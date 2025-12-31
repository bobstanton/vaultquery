import { MarkdownRenderer } from 'obsidian';
import { Column, SlickGrid, GridOption } from 'slickgrid';
import { BaseRenderer } from './BaseRenderer';
import { getErrorMessage } from '../utils/ErrorMessages';
import { generateUniqueId, escapeHTML, hashString } from '../utils/StringUtils';
import type { RenderContext } from './BaseRenderer';
import '../slickgrid-alpine-theme.css';

declare const activeWindow: Window;
declare const activeDocument: Document;

// Patch addEventListener to use passive listeners for scroll-blocking events
// This eliminates "[Violation] Added non-passive event listener" warnings from SlickGrid
const patchPassiveEventListeners = (() => {
  let patched = false;
  return () => {
    if (patched) return;
    patched = true;

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Intentional monkey-patching
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const passiveEvents = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel']);

    EventTarget.prototype.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      // Only modify if it's a scroll-blocking event and no explicit passive option is set
      if (passiveEvents.has(type)) {
        if (typeof options === 'boolean') {
          options = { capture: options, passive: true };
        }
        else if (typeof options === 'undefined') {
          options = { passive: true };
        }
        else if (typeof options === 'object' && options.passive === undefined) {
          options = { ...options, passive: true };
        }
      }
      return originalAddEventListener.call(this, type, listener, options);
    };
  };
})();

interface GridInstance {
  grid: SlickGrid;
  container: HTMLElement;
  observer?: IntersectionObserver;
  data: Record<string, unknown>[];
  columns: Column[];
  options: GridOption;
  context: RenderContext;
}

export class SlickGridRenderer extends BaseRenderer {
  private static instances = new Map<string, GridInstance>();
  private static resizeTimers = new Map<string, number>();
  private static refreshCallbacks = new Map<string, () => Promise<void>>();
  private static columnWidthCache = new Map<string, Map<string, number>>();

  private static saveColumnWidths(queryHash: string, columns: Column[]): void {
    const widths = new Map<string, number>();
    for (const col of columns) {
      if (col.width) {
        widths.set(String(col.id), col.width);
      }
    }
    this.columnWidthCache.set(queryHash, widths);
  }

  private static getSavedColumnWidth(queryHash: string, columnId: string): number | undefined {
    const widths = this.columnWidthCache.get(queryHash);
    return widths?.get(columnId);
  }

  static render(context: RenderContext): void {
    patchPassiveEventListeners();

    const { results, container } = context;

    if (!results || !Array.isArray(results) || results.length === 0) {
      container.createDiv({ cls: 'vaultquery-empty', text: 'No results found' });

      if (context.onRefresh) {
        const containerId = container.id || generateUniqueId('vq-empty');
        if (!container.id) container.id = containerId;
        this.registerRefreshCallback(containerId, context.onRefresh);
      }
      return;
    }

    this.cleanupContainer(container);

    const gridContainer = container.createDiv({ cls: 'vaultquery-slickgrid' });
    const gridId = generateUniqueId('slickgrid');
    gridContainer.id = gridId;
    gridContainer.tabIndex = -1;

    gridContainer.dataset.gridId = gridId;

    const queryHash = context.parsed?.query ? hashString(context.parsed.query) : undefined;

    const initGrid = () => {
      const domContainer = activeDocument.getElementById(gridId);
      if (!domContainer) {
        return; // Container was removed, skip initialization
      }

      try {
        const columns = this.createColumns(results[0], context, queryHash);
        const data = this.prepareData(results);

        const currentContainerWidth = domContainer.offsetWidth || 800;
        const minTotalWidth = columns.reduce((sum, col) => sum + (col.minWidth || col.width || 120), 0);
        const shouldAllowScroll = minTotalWidth > currentContainerWidth;

        // Check if markdown rendering is enabled and there's a content column
        const enableMarkdownRendering = context.settings && typeof context.settings === 'object' && 'enableMarkdownRendering' in context.settings
          ? context.settings.enableMarkdownRendering
          : false;
        const hasContentColumn = 'content' in results[0];
        const hasMarkdownContent = enableMarkdownRendering && hasContentColumn;

        const options = this.createGridOptions(shouldAllowScroll, hasMarkdownContent);

        const grid = new SlickGrid(domContainer, data, columns, options);

        if (queryHash) {
          grid.onColumnsResized.subscribe(() => {
            const currentColumns = grid.getColumns();
            this.saveColumnWidths(queryHash, currentColumns);
          });
        }

        // Create IntersectionObserver to handle visibility changes from Obsidian's DOM virtualization
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && this.instances.has(gridId)) {
              const instance = this.instances.get(gridId)!;
              // Re-render grid when it becomes visible again
              requestAnimationFrame(() => {
                if (this.instances.has(gridId) && instance.grid) {
                  try {
                    instance.grid.resizeCanvas();
                    instance.grid.invalidate();
                    instance.grid.render();

                    // Second pass to ensure all rows are rendered
                    requestAnimationFrame(() => {
                      if (this.instances.has(gridId) && instance.grid) {
                        instance.grid.invalidateAllRows();
                        instance.grid.render();
                      }
                    });
                  }
                  catch {
                    // Grid may have been destroyed, recreate it
                    this.recreateGrid(gridId, instance);
                  }
                }
              });
            }
          }
        }, { threshold: 0, rootMargin: '100px' }); // Trigger earlier with rootMargin

        observer.observe(domContainer);

        // Store complete instance data for potential recreation
        this.instances.set(gridId, {
          grid,
          container: domContainer,
          observer,
          data,
          columns,
          options,
          context
        });

        this.setupEventHandlers(grid, context.openFile);

        requestAnimationFrame(() => {
          if (this.instances.has(gridId)) {
            const instance = this.instances.get(gridId)!;
            instance.grid.resizeCanvas();
            instance.grid.invalidate();
            instance.grid.render();

            requestAnimationFrame(() => {
              if (this.instances.has(gridId) && instance.grid) {
                instance.grid.invalidateAllRows();
                instance.grid.render();
              }
            });
          }
        });

      }

      catch (error: unknown) {
        const errorContainer = activeDocument.getElementById(gridId);
        if (errorContainer) {
          errorContainer.empty();
          const errorDiv = activeDocument.createElement('div');
          errorDiv.className = 'vaultquery-error';
          errorDiv.textContent = `SlickGrid rendering failed: ${getErrorMessage(error)}`;
          errorContainer.appendChild(errorDiv);
        }
      }
    };

    activeWindow.setTimeout(initGrid, 0);
  }

  private static recreateGrid(_gridId: string, instance: GridInstance): void {
    try {
      if (instance.grid) {
        try {
          instance.grid.destroy();
        }
        catch {
          // Ignore destruction errors
        }
      }

      const domContainer = instance.container;
      if (!domContainer.isConnected) return;

      while (domContainer.firstChild) {
        domContainer.removeChild(domContainer.firstChild);
      }

      const newGrid = new SlickGrid(domContainer, instance.data, instance.columns, instance.options);
      instance.grid = newGrid;

      this.setupEventHandlers(newGrid, instance.context.openFile);

      // Use the container's window for requestAnimationFrame
      const containerWindow = domContainer.ownerDocument.defaultView || activeWindow;

      // Delay to allow the new window to fully measure the container
      containerWindow.setTimeout(() => {
        // Force complete column recalculation by re-setting columns
        newGrid.setColumns(instance.columns);
        newGrid.resizeCanvas();
        newGrid.invalidateAllRows();
        newGrid.render();
      }, 50);
    }
    catch (e) {
      console.warn('Failed to recreate SlickGrid:', e);
    }
  }

  static checkAndRestoreGrids(): void {
    for (const [gridId, instance] of this.instances.entries()) {
      // Use the stored container reference directly - it tracks across document moves
      const domContainer = instance.container;

      if (!domContainer.isConnected) {
        if (instance.observer) {
          instance.observer.disconnect();
        }
        this.instances.delete(gridId);
        continue;
      }

      // Check if the grid content is missing (empty or only has header but no rows)
      const viewport = domContainer.querySelector('.slick-viewport');
      const hasContent = viewport && viewport.children.length > 0;

      if (!hasContent && instance.data && instance.data.length > 0) {
        // Grid should have content but doesn't - recreate it
        this.recreateGrid(gridId, instance);
      }
    }
  }

  static refreshGrid(gridId: string, newData?: Array<Record<string, unknown>>): void {
    const instance = this.instances.get(gridId);
    if (instance && newData) {
      instance.grid.setData(newData);

      requestAnimationFrame(() => {
        if (this.instances.has(gridId)) {
          instance.grid.invalidateAllRows();
          instance.grid.updateRowCount();
          instance.grid.render();
        }
      });
    }
  }

  private static cleanupContainer(container: HTMLElement): void {
    for (const [gridId, instance] of this.instances.entries()) {
      if (container.contains(instance.container)) {
        try {
          if (instance.observer) {
            instance.observer.disconnect();
          }
          instance.grid.destroy();
        }
        catch (error) {
          console.warn('Error destroying SlickGrid instance:', error);
        }
        this.instances.delete(gridId);
      }
    }
  }

  private static createColumns(firstResult: Record<string, unknown>, context: RenderContext, queryHash?: string): Column[] {
    const enableMarkdownRendering = context.settings && typeof context.settings === 'object' && 'enableMarkdownRendering' in context.settings
      ? context.settings.enableMarkdownRendering
      : false;

    return Object.keys(firstResult)
      .filter(key => !key.startsWith('_'))
      .map(key => {
        const column: Column = {
          id: key,
          name: key,
          field: key,
          sortable: true,
          resizable: true,
          ...this.getColumnConfig(key, context)
        };

        if (queryHash) {
          const savedWidth = this.getSavedColumnWidth(queryHash, key);
          if (savedWidth !== undefined) {
            column.width = savedWidth;
          }
        }

        if (key.includes('(current)')) {
          column.cssClass = 'vaultquery-current-column';
        }
        else if (key.includes('(proposed)')) {
          column.cssClass = 'vaultquery-proposed-column';
        }
        else if (key === 'content' && enableMarkdownRendering) {
          column.cssClass = 'vaultquery-markdown-content-cell';
        }

        return column;
      });
  }

  private static prepareData(results: Record<string, unknown>[]): Record<string, unknown>[] {
    return results.map((row, index) => ({
      id: index,
      ...row
    }));
  }

  private static createGridOptions(_allowHorizontalScroll: boolean = false, hasMarkdownContent: boolean = false): GridOption {
    return {
      enableCellNavigation: false, // Disabled to prevent capturing keyboard events from editor
      enableColumnReorder: false, // Disabled to prevent conflict with column resizing
      enableTextSelectionOnCells: true,
      headerRowHeight: 30,
      rowHeight: hasMarkdownContent ? 150 : 32,
      defaultColumnWidth: 120,
      forceFitColumns: false, // Always allow columns to exceed viewport
      syncColumnCellResize: true,
      enableAsyncPostRender: false,
      asyncEditorLoading: false,
      enableAddRow: false,
      editable: false,
    };
  }

  private static getColumnConfig(key: string, context: RenderContext): Partial<Column> {
    const config: Partial<Column> = {};

    const width = this.getColumnWidth(key);
    config.width = width;
    config.minWidth = 50; // Minimum width for usability
    // No maxWidth - allow columns to be resized as large as needed

    const formatter = this.getColumnFormatter(key, context);
    if (formatter) {
      config.formatter = formatter;
    }

    return config;
  }

  private static getColumnWidth(key: string): number {
    if (key.includes('(current)') || key.includes('(proposed)')) {
      return 140;
    }

    switch (key) {
      case 'id':
      case 'rowid':
      case 'row_index':
      case 'table_index':
      case 'level':
      case 'line_number':
      case 'array_index':
      case 'size':
        return 60;
      case 'completed':
        return 80;
      case 'priority':
      case 'value_type':
      case 'link_type':
        return 90;
      case 'key':
      case 'tag_name':
      case 'column_name':
      case 'table_name':
        return 120;
      case 'created':
      case 'modified':
      case 'due_date':
      case 'scheduled_date':
      case 'start_date':
      case 'created_date':
      case 'done_date':
      case 'cancelled_date':
        return 130;
      case 'title':
      case 'link_text':
      case 'link_target':
        return 180;
      case 'path':
        return 220;
      case 'value':
      case 'task_text':
      case 'heading_text':
      case 'cell_value':
        return 250;
      case 'content':
        return 300;
      case 'tags':
        return 150;
      default:
        return 120;
    }
  }

  private static getColumnFormatter(key: string, context: RenderContext) {
    if (key.includes('(current)')) {
      return this.createCurrentFormatter();
    }
    if (key.includes('(proposed)')) {
      return this.createProposedFormatter();
    }

    switch (key) {
      case 'path':
        return this.createPathFormatter(context.openFile);
      case 'created':
      case 'modified':
        // These are Unix timestamps in milliseconds
        return this.createTimestampFormatter();
      case 'due_date':
      case 'scheduled_date':
      case 'start_date':
      case 'created_date':
      case 'done_date':
      case 'cancelled_date':
        // These are date strings like "2025-02-15"
        return this.createDateStringFormatter();
      case 'content':
        return this.createContentFormatter(context);
      default:
        return null;
    }
  }

  private static createPathFormatter(_openFile: (path: string) => void) {
    return (_row: number, _cell: number, value: unknown, _columnDef: Column, _dataContext: Record<string, unknown>) => {
      if (!value) return '';
      const pathStr = String(value);
      const escapedPath = escapeHTML(pathStr);
      return `<a href="${escapedPath}" class="internal-link slick-path-link" data-path="${pathStr}">${pathStr}</a>`;
    };
  }

  private static createTimestampFormatter() {
    return (_row: number, _cell: number, value: unknown, _columnDef: Column, _dataContext: Record<string, unknown>) => {
      if (!value) return '';

      const timestamp = typeof value === 'string' ? parseInt(value) : Number(value);
      if (isNaN(timestamp) || timestamp <= 0) {
        return 'N/A';
      }

      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        return 'Invalid Date';
      }

      return date.toLocaleString();
    };
  }

  private static createDateStringFormatter() {
    return (_row: number, _cell: number, value: unknown, _columnDef: Column, _dataContext: Record<string, unknown>) => {
      if (!value) return '';

      const dateStr = String(value);

      // Check if it's already a valid date string (YYYY-MM-DD format)
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        // Parse as local date to avoid timezone issues
        const [year, month, day] = dateStr.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        if (!isNaN(date.getTime())) {
          return date.toLocaleDateString();
        }
      }

      // Return as-is if not a recognized format
      return dateStr;
    };
  }

  private static createContentFormatter(context: RenderContext) {
    return (_row: number, _cell: number, value: unknown, _columnDef: Column, _dataContext: Record<string, unknown>) => {
      const { app, pluginContext, settings } = context;
      const content = String(value || '');
      if (!content) return '';

      const sanitizedContent = content.replace(/```vaultquery[^\n]*/g, '```sql');

      const enableMarkdownRendering = settings && typeof settings === 'object' && 'enableMarkdownRendering' in settings
        ? settings.enableMarkdownRendering
        : false;

      if (enableMarkdownRendering && pluginContext) {
        try {
          const container = activeDocument.createElement('div');
          container.className = 'vaultquery-markdown-cell';
          void MarkdownRenderer.render(app, sanitizedContent, container, '', pluginContext);

          const innerContent = this.serializeDOMContent(container);
          if (innerContent) {
            return `<div class="vaultquery-markdown-cell">${innerContent}</div>`;
          }
          return escapeHTML(sanitizedContent);
        }
        catch (error) {
          console.warn('Failed to render markdown:', error);
          return escapeHTML(sanitizedContent);
        }
      }

      return escapeHTML(sanitizedContent);
    };
  }

  private static createCurrentFormatter() {
    return (_row: number, _cell: number, value: unknown, columnDef: Column, dataContext: Record<string, unknown>) => {
      const columnName = typeof columnDef.name === 'string' ? columnDef.name : String(columnDef.name || '');
      const baseFieldName = columnName.replace(' (current)', '');
      const changedFieldName = `_${baseFieldName}_changed`;

      const formattedValue = this.formatValueByFieldName(value, baseFieldName);
      const escapedValue = escapeHTML(formattedValue);

      const isChanged = dataContext?.[changedFieldName] === true;

      return isChanged
        ? `<span style="font-style: italic; opacity: 0.8;">${escapedValue}</span>`
        : `<span style="opacity: 0.8;">${escapedValue}</span>`;
    };
  }

  private static createProposedFormatter() {
    return (_row: number, _cell: number, value: unknown, columnDef: Column, dataContext: Record<string, unknown>) => {
      const columnName = typeof columnDef.name === 'string' ? columnDef.name : String(columnDef.name || '');
      const baseFieldName = columnName.replace(' (proposed)', '');
      const changedFieldName = `_${baseFieldName}_changed`;

      const formattedValue = this.formatValueByFieldName(value, baseFieldName);
      const escapedValue = escapeHTML(formattedValue);

      const isChanged = dataContext?.[changedFieldName] === true;

      return isChanged
        ? `<span style="font-weight: 600;">${escapedValue}</span>`
        : `<span style="opacity: 0.8;">${escapedValue}</span>`;
    };
  }

  private static formatValueByFieldName(value: unknown, fieldName: string): string {
    if (value === null || value === undefined || value === '') {
      return '';
    }

    // Timestamp fields (Unix milliseconds)
    if (fieldName === 'created' || fieldName === 'modified') {
      const timestamp = typeof value === 'string' ? parseInt(value) : Number(value);
      if (!isNaN(timestamp) && timestamp > 0) {
        const date = new Date(timestamp);
        if (!isNaN(date.getTime())) {
          return date.toLocaleString();
        }
      }
      return 'N/A';
    }

    // Date string fields (YYYY-MM-DD)
    const dateFields = ['due_date', 'scheduled_date', 'start_date', 'created_date', 'done_date', 'cancelled_date'];
    if (dateFields.includes(fieldName)) {
      const dateStr = String(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [year, month, day] = dateStr.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        if (!isNaN(date.getTime())) {
          return date.toLocaleDateString();
        }
      }
      return dateStr;
    }

    return String(value);
  }

  private static setupEventHandlers(grid: SlickGrid, openFile: (path: string) => void): void {
    grid.onClick.subscribe((e) => {
      const target = e.target as HTMLElement;

      if (target.classList.contains('slick-scrollbar') ||
        target.closest('.slick-viewport::-webkit-scrollbar') ||
        target.closest('.slick-header') ||
        target.classList.contains('slick-resizable-handle')) {
        return;
      }

      if (target.classList.contains('slick-path-link')) {
        e.preventDefault();
        e.stopPropagation();
        const path = target.getAttribute('data-path');
        if (path) {
          openFile(path);
        }
      }
    });


    grid.onScroll.subscribe((_e) => {
      // Prevent any interference with scrolling
    });

    grid.onBeforeDestroy.subscribe(() => {
      for (const [gridId, instance] of this.instances.entries()) {
        if (instance.grid === grid) {
          this.instances.delete(gridId);
          break;
        }
      }
    });

    this.setupMobileResizeHandlers(grid);
  }

  private static setupMobileResizeHandlers(grid: SlickGrid): void {
    const container = grid.getContainerNode();
    if (!container) return;

    const resizeHandles = Array.from(container.querySelectorAll('.slick-resizable-handle'));

    const touchHandler = (e: TouchEvent) => {
      e.stopPropagation();
    };

    for (const handle of resizeHandles) {
      handle.addEventListener('touchstart', touchHandler as EventListener, { passive: false });
      handle.addEventListener('touchmove', touchHandler as EventListener, { passive: false });
      handle.addEventListener('touchend', touchHandler as EventListener, { passive: false });
    }
  }

  private static serializeDOMContent(element: HTMLElement): string {
    const children = Array.from(element.childNodes);
    return children.map(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent || '';
      }
      else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const tagName = el.tagName.toLowerCase();
        const attributes = Array.from(el.attributes)
          .map(attr => `${attr.name}="${escapeHTML(attr.value)}"`)
          .join(' ');
        const attrString = attributes ? ' ' + attributes : '';
        const content = this.serializeDOMContent(el);
        return `<${tagName}${attrString}>${content}</${tagName}>`;
      }
      return '';
    }).join('');
  }

  static cleanup(): void {
    for (const rafId of this.resizeTimers.values()) {
      cancelAnimationFrame(rafId);
    }
    this.resizeTimers.clear();

    for (const [_gridId, instance] of this.instances.entries()) {
      try {
        if (instance.observer) {
          instance.observer.disconnect();
        }
        instance.grid.destroy();
      }
      catch (error) {
        console.warn('Error destroying SlickGrid instance:', error);
      }
    }
    this.instances.clear();
  }

  static resizeGrid(gridId?: string): void {
    const resize = (id: string, instance: GridInstance) => {
      const existingTimer = this.resizeTimers.get(id);
      if (existingTimer) {
        cancelAnimationFrame(existingTimer);
      }

      const rafId = requestAnimationFrame(() => {
        try {
          instance.grid.resizeCanvas();
          instance.grid.invalidate();
          instance.grid.render();
          this.resizeTimers.delete(id);
        }
        catch (error) {
          console.warn('Error resizing SlickGrid instance:', error);
        }
      });

      this.resizeTimers.set(id, rafId);
    };

    if (gridId) {
      const instance = this.instances.get(gridId);
      if (instance) resize(gridId, instance);
    }
    else {
      for (const [id, instance] of this.instances.entries()) {
        resize(id, instance);
      }
    }
  }

  static isActive(): boolean {
    return this.instances.size > 0;
  }

  static getInstanceCount(): number {
    return this.instances.size;
  }

  static registerRefreshCallback(containerId: string, callback: () => Promise<void>): void {
    this.refreshCallbacks.set(containerId, callback);
  }

  static unregisterRefreshCallback(containerId: string): void {
    this.refreshCallbacks.delete(containerId);

    const container = activeDocument.getElementById(containerId);
    if (container) {
      for (const [gridId, instance] of this.instances.entries()) {
        if (instance.container === container || container.contains(instance.container)) {
          instance.observer?.disconnect();
          instance.grid?.destroy();
          this.instances.delete(gridId);
        }
      }
    }
  }

  static async refreshAllGrids(indexedPaths?: string[]): Promise<void> {
    const refreshPromises: Promise<void>[] = [];
    const indexedSet = indexedPaths ? new Set(indexedPaths) : null;

    for (const instance of this.instances.values()) {
      if (instance.context.onRefresh) {
        if (indexedSet && this.canSkipRefresh(instance.context, indexedSet)) {
          continue;
        }
        refreshPromises.push(instance.context.onRefresh());
      }
    }

    for (const [containerId, callback] of this.refreshCallbacks.entries()) {
      if (activeDocument.getElementById(containerId)) {
        refreshPromises.push(callback());
      }
      else {
        this.refreshCallbacks.delete(containerId);
      }
    }

    await Promise.all(refreshPromises);
  }

  private static canSkipRefresh(context: RenderContext, indexedPaths: Set<string>): boolean {
    const query = context.parsed?.query;
    const sourcePath = context.sourcePath;

    if (!query || !sourcePath) {
      return false;
    }

    if (query.includes('{this.path}')) {
      return !indexedPaths.has(sourcePath);
    }

    return false;
  }
}
