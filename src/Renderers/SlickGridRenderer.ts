import { MarkdownRenderer } from 'obsidian';
import { Column, SlickGrid, GridOption } from 'slickgrid';
import type { ColumnSort, MultiColumnSort, SingleColumnSort } from 'slickgrid';
import { BaseRenderer } from './BaseRenderer';
import { QueryRefreshRegistry, buildShouldRefreshPredicate } from './QueryRefreshRegistry';
import { getErrorMessage } from '../utils/ErrorMessages';
import { generateUniqueId, escapeHTML, hashString } from '../utils/StringUtils';
import type { RenderContext } from './BaseRenderer';
import '../slickgrid-alpine-theme.css';
import { logger as rootLogger } from '../utils/logger';

declare const activeWindow: Window;

const logger = rootLogger.scope('SlickGrid');

// Patch addEventListener to use passive listeners for scroll-blocking events
// This eliminates "[Violation] Added non-passive event listener" warnings from SlickGrid
const patchPassiveEventListeners = (() => {
  let patched = false;
  return () => {
    if (patched) return;
    patched = true;

    const originalAddEventListener = Reflect.get(
      EventTarget.prototype,
      'addEventListener',
    ) as EventTarget['addEventListener'];
    const passiveEvents = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel']);

    EventTarget.prototype.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
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
  resizeObserver?: ResizeObserver;
  data: Record<string, unknown>[];
  columns: Column[];
  options: GridOption;
  context: RenderContext;
  detachedAt?: number;
}

interface PendingGridInitialization {
  container: HTMLElement;
  init: () => void;
  createdAt: number;
}

export class SlickGridRenderer extends BaseRenderer {
  private static instances = new Map<string, GridInstance>();
  private static pendingInitializations = new Map<string, PendingGridInitialization>();
  private static resizeTimers = new Map<string, number>();
  private static columnWidthCache = new Map<string, Map<string, number>>();
  private static recreatingGridIds = new Set<string>();

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

    this.cleanupContainer(container);

    if (context.onRefresh) {
      QueryRefreshRegistry.register(container, {
        onRefresh: context.onRefresh,
        shouldRefresh: buildShouldRefreshPredicate(context.sourcePath, context.parsed?.query),
      });
    }

    if (!results || !Array.isArray(results) || results.length === 0) {
      container.createDiv({ cls: 'vaultquery-empty', text: 'No results found' });
      return;
    }

    const gridContainer = container.createDiv({ cls: 'vaultquery-data-grid' });
    const gridId = generateUniqueId('data-grid');
    gridContainer.id = gridId;
    gridContainer.tabIndex = -1;

    gridContainer.dataset.gridId = gridId;

    const queryHash = context.parsed?.query ? hashString(context.parsed.query) : undefined;

    const initGrid = () => {
      if (this.instances.has(gridId)) {
        this.pendingInitializations.delete(gridId);
        return;
      }

      if (!gridContainer.isConnected) {
        this.pendingInitializations.set(gridId, {
          container: gridContainer,
          init: initGrid,
          createdAt: this.pendingInitializations.get(gridId)?.createdAt ?? Date.now()
        });
        return;
      }

      try {
        this.pendingInitializations.delete(gridId);

        const domContainer = gridContainer;
        const columns = this.createColumns(results[0], context, queryHash);
        const data = this.prepareData(results);

        const currentContainerWidth = domContainer.offsetWidth || 800;
        const minTotalWidth = columns.reduce((sum, col) => sum + (col.minWidth || col.width || 120), 0);
        const shouldAllowScroll = minTotalWidth > currentContainerWidth;

        const hasMarkdownContent = this.shouldRenderMarkdownContent(context) && 'content' in results[0];

        const options = this.createGridOptions(shouldAllowScroll, hasMarkdownContent);

        const grid = new SlickGrid(domContainer, data, columns, options);

        if (queryHash) {
          grid.onColumnsResized.subscribe(() => {
            const currentColumns = grid.getColumns();
            this.saveColumnWidths(queryHash, currentColumns);
          });
        }

        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && this.instances.has(gridId)) {
              const instance = this.instances.get(gridId)!;
              // Single RAF is sufficient - invalidateAllRows() + render() handles full refresh
              requestAnimationFrame(() => {
                if (this.instances.has(gridId) && instance.grid) {
                  this.refreshGrid(gridId, instance);
                }
              });
            }
          }
        }, { threshold: 0, rootMargin: '100px' }); // Trigger earlier with rootMargin

        observer.observe(domContainer);

        const resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0) {
              const instance = this.instances.get(gridId);
              if (instance) {
                this.scheduleGridRefresh(gridId, instance);
              }
            }
          }
        });
        resizeObserver.observe(domContainer);

        this.instances.set(gridId, {
          grid,
          container: domContainer,
          observer,
          resizeObserver,
          data,
          columns,
          options,
          context
        });

        this.setupEventHandlers(grid, context.openFile);

        // Single RAF is sufficient - invalidateAllRows() + render() handles full refresh
        requestAnimationFrame(() => {
          if (this.instances.has(gridId)) {
            const instance = this.instances.get(gridId)!;
            this.refreshGrid(gridId, instance);
          }
        });

      }

      catch (error: unknown) {
        gridContainer.empty();
        BaseRenderer.renderError(gridContainer, {
          title: 'Grid Error',
          message: `SlickGrid rendering failed: ${getErrorMessage(error)}`
        });
      }
    };

    this.pendingInitializations.set(gridId, {
      container: gridContainer,
      init: initGrid,
      createdAt: Date.now()
    });

    activeWindow.setTimeout(initGrid, 0);
  }

  private static refreshGrid(gridId: string, instance: GridInstance): void {
    if (!instance.container.isConnected) {
      return;
    }

    try {
      instance.grid.resizeCanvas();
      instance.grid.invalidateAllRows();
      instance.grid.render();
    }
    catch {
      this.recreateGrid(gridId, instance);
    }
  }

  private static scheduleGridRefresh(gridId: string, instance: GridInstance): void {
    const existingTimer = this.resizeTimers.get(gridId);
    if (existingTimer !== undefined) {
      cancelAnimationFrame(existingTimer);
    }

    const rafId = requestAnimationFrame(() => {
      this.resizeTimers.delete(gridId);
      if (this.instances.get(gridId) === instance) {
        this.refreshGrid(gridId, instance);
      }
    });
    this.resizeTimers.set(gridId, rafId);
  }

  private static recreateGrid(gridId: string, instance: GridInstance): void {
    try {
      if (instance.grid) {
        this.recreatingGridIds.add(gridId);
        try {
          instance.grid.destroy();
        }
        catch {
          // Ignore destruction errors
        }
        finally {
          this.recreatingGridIds.delete(gridId);
        }
      }

      const domContainer = instance.container;
      if (!domContainer.isConnected) return;

      while (domContainer.firstChild) {
        domContainer.removeChild(domContainer.firstChild);
      }

      const newGrid = new SlickGrid(domContainer, instance.data, instance.columns, instance.options);
      instance.grid = newGrid;
      this.instances.set(gridId, instance);

      this.setupEventHandlers(newGrid, instance.context.openFile);

      // Use the container's window for requestAnimationFrame
      const containerWindow = domContainer.ownerDocument.defaultView || activeWindow;

      // Delay to allow the new window to fully measure the container
      containerWindow.setTimeout(() => {
        newGrid.setColumns(instance.columns);
        this.refreshGrid(gridId, instance);
      }, 50);
    }
    catch (e) {
      logger.warn('Failed to recreate SlickGrid', e);
    }
  }

  static checkAndRestoreGrids(): void {
    const now = Date.now();
    const DETACHED_INSTANCE_TTL_MS = 60000;
    const PENDING_INIT_TTL_MS = 60000;

    for (const [gridId, pending] of this.pendingInitializations.entries()) {
      if (this.instances.has(gridId)) {
        this.pendingInitializations.delete(gridId);
        continue;
      }

      if (!pending.container.isConnected) {
        if (now - pending.createdAt > PENDING_INIT_TTL_MS) {
          this.pendingInitializations.delete(gridId);
        }
        continue;
      }

      pending.init();
    }

    for (const [gridId, instance] of this.instances.entries()) {
      // Use the stored container reference directly - it tracks across document moves
      const domContainer = instance.container;

      if (!domContainer.isConnected) {
        if (!instance.detachedAt) {
          instance.detachedAt = now;
        }
        else if (now - instance.detachedAt > DETACHED_INSTANCE_TTL_MS) {
          instance.observer?.disconnect();
          instance.resizeObserver?.disconnect();
          const resizeTimer = this.resizeTimers.get(gridId);
          if (resizeTimer !== undefined) {
            cancelAnimationFrame(resizeTimer);
            this.resizeTimers.delete(gridId);
          }
          try {
            instance.grid.destroy();
          }
          catch {
            // Ignore cleanup errors for expired detached instances
          }
          this.instances.delete(gridId);
        }
        continue;
      }

      instance.detachedAt = undefined;

      const hasUsableDimensions = domContainer.offsetWidth > 0 && domContainer.offsetHeight > 0;
      const hasRenderedRows = domContainer.querySelector('.slick-row') !== null;

      if (hasUsableDimensions && !hasRenderedRows && instance.data && instance.data.length > 0) {
        this.recreateGrid(gridId, instance);
      }
    }
  }

  static cleanupContainer(container: HTMLElement): void {
    QueryRefreshRegistry.unregister(container);

    for (const [gridId, instance] of this.instances.entries()) {
      if (container.contains(instance.container)) {
        try {
          instance.observer?.disconnect();
          instance.resizeObserver?.disconnect();
          const resizeTimer = this.resizeTimers.get(gridId);
          if (resizeTimer !== undefined) {
            cancelAnimationFrame(resizeTimer);
            this.resizeTimers.delete(gridId);
          }
          instance.grid.destroy();
        }
        catch (error) {
          logger.warn('Error destroying SlickGrid instance', error);
        }
        this.instances.delete(gridId);
      }
    }

    container.empty();
  }

  private static createColumns(firstResult: Record<string, unknown>, context: RenderContext, queryHash?: string): Column[] {
    const shouldRenderMarkdownContent = this.shouldRenderMarkdownContent(context);

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
        else if (key === 'content' && shouldRenderMarkdownContent) {
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
      enableCellNavigation: false,
      enableColumnReorder: false,
      enableTextSelectionOnCells: true,
      headerRowHeight: 30,
      rowHeight: hasMarkdownContent ? 150 : 32,
      defaultColumnWidth: 120,
      forceFitColumns: false,
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
    config.minWidth = 50;
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
        return this.createTimestampFormatter();
      case 'due_date':
      case 'scheduled_date':
      case 'start_date':
      case 'created_date':
      case 'done_date':
      case 'cancelled_date':
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

      return this.formatIsoDateString(String(value));
    };
  }

  private static createContentFormatter(context: RenderContext) {
    return (_row: number, _cell: number, value: unknown, _columnDef: Column, _dataContext: Record<string, unknown>) => {
      const { app, pluginContext, settings } = context;
      const content = String(value || '');
      if (!content) return '';

      const sanitizedContent = content.replace(/```vaultquery[^\n]*/g, '```sql');

      if (settings?.contentRenderingMode === 'rendered-markdown' && pluginContext) {
        try {
          const container = context.container.ownerDocument.createElement('div');
          container.className = 'vaultquery-markdown-cell';
          void MarkdownRenderer.render(app, sanitizedContent, container, '', pluginContext);

          const innerContent = this.serializeDOMContent(container);
          if (innerContent) {
            return `<div class="vaultquery-markdown-cell">${innerContent}</div>`;
          }
          return escapeHTML(sanitizedContent);
        }
        catch (error) {
          logger.warn('Failed to render markdown', error);
          return escapeHTML(sanitizedContent);
        }
      }

      return escapeHTML(sanitizedContent);
    };
  }

  private static shouldRenderMarkdownContent(context: RenderContext): boolean {
    return context.settings?.contentRenderingMode === 'rendered-markdown';
  }

  private static createCurrentFormatter() {
    return (_row: number, _cell: number, value: unknown, columnDef: Column, dataContext: Record<string, unknown>) => {
      return this.formatComparisonCell(value, columnDef, dataContext, 'current');
    };
  }

  private static createProposedFormatter() {
    return (_row: number, _cell: number, value: unknown, columnDef: Column, dataContext: Record<string, unknown>) => {
      return this.formatComparisonCell(value, columnDef, dataContext, 'proposed');
    };
  }

  private static formatComparisonCell(value: unknown, columnDef: Column, dataContext: Record<string, unknown>, variant: 'current' | 'proposed'): string {
    const suffix = variant === 'current' ? ' (current)' : ' (proposed)';
    const columnName = typeof columnDef.name === 'string' ? columnDef.name : String(columnDef.name || '');
    const baseFieldName = columnName.replace(suffix, '');
    const changedFieldName = `_${baseFieldName}_changed`;
    const escapedValue = escapeHTML(this.formatValueByFieldName(value, baseFieldName));
    const isChanged = dataContext?.[changedFieldName] === true;

    if (!isChanged) {
      return `<span style="opacity: 0.8;">${escapedValue}</span>`;
    }

    const changedStyle = variant === 'current'
      ? 'font-style: italic; opacity: 0.8;'
      : 'font-weight: 600;';
    return `<span style="${changedStyle}">${escapedValue}</span>`;
  }

  private static formatValueByFieldName(value: unknown, fieldName: string): string {
    if (value === null || value === undefined || value === '') {
      return '';
    }

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

    const dateFields = ['due_date', 'scheduled_date', 'start_date', 'created_date', 'done_date', 'cancelled_date'];
    if (dateFields.includes(fieldName)) {
      return this.formatIsoDateString(String(value));
    }

    return String(value);
  }

  private static setupEventHandlers(grid: SlickGrid, openFile: (path: string) => void): void {
    grid.onSort.subscribe((_e, args) => {
      this.sortGridData(grid, args);
    });

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
    });

    grid.onBeforeDestroy.subscribe(() => {
      for (const [gridId, instance] of this.instances.entries()) {
        if (instance.grid === grid) {
          if (!this.recreatingGridIds.has(gridId)) {
            this.instances.delete(gridId);
          }
          break;
        }
      }
    });

    this.setupMobileResizeHandlers(grid);
  }

  private static sortGridData(grid: SlickGrid, args: SingleColumnSort | MultiColumnSort): void {
    const sortColumns = this.getSortColumns(args);
    if (sortColumns.length === 0) {
      return;
    }

    const data = grid.getData() as unknown;
    if (!Array.isArray(data)) {
      return;
    }

    const rows = data as Record<string, unknown>[];

    const indexedRows = rows.map((item, index) => ({ item, index }));
    indexedRows.sort((left, right) => {
      for (const sortColumn of sortColumns) {
        const field = this.getSortField(sortColumn);
        if (!field) {
          continue;
        }

        const comparison = this.compareSortValues(left.item[field], right.item[field]);
        if (comparison !== 0) {
          return sortColumn.sortAsc ? comparison : -comparison;
        }
      }

      return left.index - right.index;
    });

    for (let index = 0; index < indexedRows.length; index++) {
      rows[index] = indexedRows[index].item;
    }

    grid.invalidateAllRows();
    grid.render();
  }

  private static getSortColumns(args: SingleColumnSort | MultiColumnSort): ColumnSort[] {
    if (args.multiColumnSort === true) {
      return args.sortCols;
    }

    return [{
      columnId: args.columnId,
      sortAsc: args.sortAsc,
      sortCol: args.sortCol,
    }];
  }

  private static getSortField(sortColumn: ColumnSort): string | null {
    const field = sortColumn.sortCol?.field ?? sortColumn.columnId;
    return typeof field === 'string' || typeof field === 'number' ? String(field) : null;
  }

  private static compareSortValues(left: unknown, right: unknown): number {
    const leftEmpty = left === null || left === undefined || left === '';
    const rightEmpty = right === null || right === undefined || right === '';

    if (leftEmpty && rightEmpty) {
      return 0;
    }
    if (leftEmpty) {
      return 1;
    }
    if (rightEmpty) {
      return -1;
    }

    const leftNumber = this.toSortableNumber(left);
    const rightNumber = this.toSortableNumber(right);
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber - rightNumber;
    }

    return String(left).localeCompare(String(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }

  private static toSortableNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isNaN(value) ? null : value;
    }

    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const trimmedValue = value.trim();
    if (trimmedValue === '') {
      return null;
    }

    const parsedNumber = Number(trimmedValue);
    if (!Number.isNaN(parsedNumber)) {
      return parsedNumber;
    }

    const parsedDate = Date.parse(trimmedValue);
    return Number.isNaN(parsedDate) ? null : parsedDate;
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
    this.pendingInitializations.clear();

    for (const [_gridId, instance] of this.instances.entries()) {
      try {
        instance.observer?.disconnect();
        instance.resizeObserver?.disconnect();
        instance.grid.destroy();
      }
      catch (error) {
        logger.warn('Error destroying SlickGrid instance', error);
      }
    }
    this.instances.clear();
  }

}
