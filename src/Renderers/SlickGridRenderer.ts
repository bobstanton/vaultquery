import { MarkdownRenderer } from 'obsidian';
import { Column, SlickGrid, GridOption } from 'slickgrid';
import type { ColumnSort, MultiColumnSort, SingleColumnSort } from 'slickgrid';
import { BaseRenderer } from './BaseRenderer';
import { QueryRefreshRegistry, resolveAutoRefreshSetting } from './QueryRefreshRegistry';
import { getErrorMessage } from '../utils/ErrorMessages';
import { generateUniqueId, escapeHTML, hashString } from '../utils/StringUtils';
import { parseCssDimension } from '../utils/ConfigParsingUtils';
import { formatIsoDateString, formatTimestampValue } from '../utils/ResultFormatUtils';
import type { RenderContext } from './BaseRenderer';
import '../slickgrid-alpine-theme.css';
import { logger as rootLogger } from '../utils/logger';

declare const activeWindow: Window;

const logger = rootLogger.scope('SlickGrid');

interface TrackedBodyResizeListener {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | EventListenerOptions;
}

const slickGridBodyResizeEventTypes = new Set(['mousemove', 'mouseup', 'touchmove', 'touchend']);
const slickGridBodyResizeListenerNames = new Set(['resizingHandler', 'resizeEndHandler']);
const trackedSlickGridBodyResizeListeners: TrackedBodyResizeListener[] = [];

// Patch addEventListener to use passive listeners for scroll-blocking events
// This eliminates "[Violation] Added non-passive event listener" warnings from SlickGrid
const patchPassiveEventListeners = (() => {
  let patched = false;
  return () => {
    if (patched) return;
    patched = true;

    const originalAddEventListener = Reflect.get(EventTarget.prototype, 'addEventListener') as EventTarget['addEventListener'];
    const originalRemoveEventListener = Reflect.get(EventTarget.prototype, 'removeEventListener') as EventTarget['removeEventListener'];
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

      if (listener && isSlickGridBodyResizeListener(this, type, listener)) {
        trackedSlickGridBodyResizeListeners.push({
          target: this,
          type,
          listener,
          options,
        });
      }

      return originalAddEventListener.call(this, type, listener, options);
    };

    EventTarget.prototype.removeEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
      if (listener) {
        removeTrackedSlickGridBodyResizeListener(this, type, listener);
      }
      return originalRemoveEventListener.call(this, type, listener, options);
    };
  };
})();

function isSlickGridBodyResizeListener(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject): boolean {
  if (!slickGridBodyResizeEventTypes.has(type)) {
    return false;
  }

  if (!(target instanceof HTMLElement) || target.tagName !== 'BODY') {
    return false;
  }

  const listenerName = typeof listener === 'function'
    ? listener.name
    : listener.handleEvent.name;

  return slickGridBodyResizeListenerNames.has(listenerName);
}

function removeTrackedSlickGridBodyResizeListener(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject): void {
  for (let index = trackedSlickGridBodyResizeListeners.length - 1; index >= 0; index--) {
    const tracked = trackedSlickGridBodyResizeListeners[index];
    if (tracked.target === target && tracked.type === type && tracked.listener === listener) {
      trackedSlickGridBodyResizeListeners.splice(index, 1);
    }
  }
}

interface GridRecord {
  id: string;
  container: HTMLElement;
  grid?: SlickGrid;
  observer?: IntersectionObserver;
  resizeObserver?: ResizeObserver;
  domObserver?: MutationObserver;
  data: Record<string, unknown>[];
  columns: Column[];
  options: GridOption;
  context: RenderContext;
  queryHash?: string;
  detachedAt?: number;
  disposed?: boolean;
  detachLogged?: boolean;
}

interface GridHeightConfig {
  height?: string;
  minHeight?: string;
  maxHeight?: string;
}

export class SlickGridRenderer extends BaseRenderer {
  private static readonly DETACHED_RECORD_TTL_MS = 30 * 60 * 1000;
  private static records = new Map<string, GridRecord>();
  private static resizeTimers = new Map<string, number>();
  private static restoreTimers = new Map<string, number>();
  private static orphanRefreshElements = new WeakSet<HTMLElement>();
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

    this.cleanupContainer(container);

    if (context.onRefresh) {
      QueryRefreshRegistry.register(container, {
        onRefresh: context.onRefresh,
        autoRefresh: resolveAutoRefreshSetting(context.settings, context.parsed),
      });
    }

    if (!results || !Array.isArray(results) || results.length === 0) {
      container.createDiv({ cls: 'vaultquery-empty', text: 'No results found' });
      return;
    }

    const gridContainer: HTMLElement = container.createDiv({ cls: 'vaultquery-data-grid' });
    this.applyHeightConfig(gridContainer, this.parseHeightConfig(context.parsed.output?.options));
    const gridId = generateUniqueId('data-grid');
    gridContainer.id = gridId;
    gridContainer.tabIndex = -1;

    gridContainer.dataset.gridId = gridId;

    const queryHash = context.parsed?.query ? hashString(context.parsed.query) : undefined;
    const columns = this.createColumns(results[0], context, queryHash);
    const data = this.prepareData(results);
    const preferredTotalWidth = columns.reduce((sum, col) => sum + (col.width || col.minWidth || 120), 0);
    const currentContainerWidth = gridContainer.offsetWidth || 800;
    const shouldAllowScroll = preferredTotalWidth > currentContainerWidth;
    const hasMarkdownContent = this.shouldRenderMarkdownContent(context) && 'content' in results[0];
    const options = this.createGridOptions(shouldAllowScroll, hasMarkdownContent);

    const record: GridRecord = {
      id: gridId,
      container: gridContainer,
      data,
      columns,
      options,
      context,
      queryHash,
    };

    this.records.set(gridId, record);
    this.scheduleGridEnsure(record, 'initial render');
  }

  private static refreshGrid(record: GridRecord): void {
    if (this.records.get(record.id) !== record || !record.grid || !record.container.isConnected) {
      return;
    }

    try {
      record.grid.resizeCanvas();
      record.grid.invalidateAllRows();
      record.grid.render();
    }
    catch (error) {
      if (this.records.get(record.id) === record && record.container.isConnected) {
        logger.debug(`SlickGrid refresh failed; recreating grid ${record.id}: ${getErrorMessage(error)}`);
        this.mountGrid(record, 'refresh failure', true);
      }
    }
  }

  private static scheduleGridRefresh(record: GridRecord): void {
    if (this.records.get(record.id) !== record || record.disposed) {
      return;
    }

    const existingTimer = this.resizeTimers.get(record.id);
    if (existingTimer !== undefined) {
      cancelAnimationFrame(existingTimer);
    }

    const containerWindow = record.container.ownerDocument.defaultView || activeWindow;
    const rafId = containerWindow.requestAnimationFrame(() => {
      this.resizeTimers.delete(record.id);
      if (this.records.get(record.id) === record) {
        this.refreshGrid(record);
      }
    });
    this.resizeTimers.set(record.id, rafId);
  }

  private static scheduleGridEnsure(record: GridRecord, reason: string, delay = 0): void {
    if (this.records.get(record.id) !== record || record.disposed || this.restoreTimers.has(record.id)) {
      return;
    }

    const containerWindow = record.container.ownerDocument.defaultView || activeWindow;
    const timer = containerWindow.setTimeout(() => {
      this.restoreTimers.delete(record.id);
      this.ensureGridMounted(record, reason);
    }, delay);

    this.restoreTimers.set(record.id, timer);
  }

  private static ensureGridMounted(record: GridRecord, reason: string): void {
    if (this.records.get(record.id) !== record || record.disposed) {
      return;
    }

    if (!record.container.isConnected) {
      return;
    }

    record.detachedAt = undefined;

    if (!record.grid) {
      this.mountGrid(record, reason, false);
      return;
    }

    if (this.hasUsableGridDimensions(record) && !this.hasUsableGridDom(record)) {
      this.mountGrid(record, reason, true);
      return;
    }

    this.refreshGrid(record);
  }

  private static mountGrid(record: GridRecord, reason: string, forceRecreate: boolean): void {
    if (this.records.get(record.id) !== record || record.disposed || !record.container.isConnected) {
      return;
    }

    if (record.grid && !forceRecreate && this.hasUsableGridDom(record)) {
      this.refreshGrid(record);
      return;
    }

    try {
      if (record.grid) {
        logger.debug(`Recreating SlickGrid ${record.id}: ${reason}`);
        this.destroyMountedGrid(record);
      }
      else {
        logger.debug(`Mounting SlickGrid ${record.id}: ${reason}`);
      }

      while (record.container.firstChild) {
        record.container.removeChild(record.container.firstChild);
      }

      const grid = new SlickGrid(record.container, record.data, record.columns, record.options);
      record.grid = grid;

      if (record.queryHash) {
        grid.onColumnsResized.subscribe(() => {
          const currentColumns = grid.getColumns();
          this.saveColumnWidths(record.queryHash!, currentColumns);
        });
      }

      this.attachContainerObservers(record);
      this.setupEventHandlers(grid, record);
      logger.debug(`SlickGrid initialized ${record.id}: rows=${record.data.length}, columns=${record.columns.length}`);

      const containerWindow = record.container.ownerDocument.defaultView || activeWindow;
      containerWindow.requestAnimationFrame(() => {
        if (this.records.get(record.id) === record && record.grid === grid && record.container.isConnected) {
          this.refreshGrid(record);
        }
      });

      containerWindow.setTimeout(() => {
        if (this.records.get(record.id) !== record || record.grid !== grid || !record.container.isConnected) {
          return;
        }
        grid.setColumns(record.columns);
        this.refreshGrid(record);
      }, 50);
    }
    catch (error: unknown) {
      record.container.empty();
      BaseRenderer.renderError(record.container, {
        title: 'Grid Error',
        message: `SlickGrid rendering failed: ${getErrorMessage(error)}`
      });
    }
  }

  private static createDomObserver(record: GridRecord): MutationObserver | undefined {
    const MutationObserverCtor = record.container.ownerDocument.defaultView?.MutationObserver;
    if (!MutationObserverCtor) {
      return undefined;
    }

    const observer = new MutationObserverCtor(() => {
      if (this.records.get(record.id) !== record || record.disposed || !record.container.isConnected) {
        return;
      }

      if (!this.hasUsableGridDimensions(record) || this.hasUsableGridDom(record)) {
        return;
      }

      this.scheduleGridEnsure(record, 'grid DOM mutation', 100);
    });

    observer.observe(record.container, { childList: true, subtree: true });
    return observer;
  }

  private static attachContainerObservers(record: GridRecord): void {
    const container = record.container;
    const containerWindow = container.ownerDocument.defaultView || activeWindow;

    if (record.observer || record.resizeObserver || record.domObserver) {
      this.disconnectContainerObservers(record);
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && this.records.get(record.id) === record) {
          containerWindow.requestAnimationFrame(() => {
            if (this.records.get(record.id) === record) {
              this.ensureGridMounted(record, 'intersection');
            }
          });
        }
      }
    }, { threshold: 0, rootMargin: '100px' });

    observer.observe(container);
    record.observer = observer;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && this.records.get(record.id) === record) {
          if (record.grid) {
            this.scheduleGridRefresh(record);
          }
          else {
            this.scheduleGridEnsure(record, 'resize');
          }
        }
      }
    });

    resizeObserver.observe(container);
    record.resizeObserver = resizeObserver;

    record.domObserver = this.createDomObserver(record);
  }

  private static disconnectContainerObservers(record: GridRecord): void {
    record.observer?.disconnect();
    record.resizeObserver?.disconnect();
    record.domObserver?.disconnect();
    record.observer = undefined;
    record.resizeObserver = undefined;
    record.domObserver = undefined;
  }

  private static hasUsableGridDimensions(record: GridRecord): boolean {
    return record.container.offsetWidth > 0 && record.container.offsetHeight > 0;
  }

  private static hasUsableGridDom(record: GridRecord): boolean {
    if (!record.data || record.data.length === 0) {
      return true;
    }

    return this.hasUsableGridElementDom(record.container);
  }

  private static hasUsableGridElementDom(container: HTMLElement): boolean {
    return container.querySelector('.slick-header-column') !== null
      && container.querySelector('.slick-viewport') !== null
      && container.querySelector('.grid-canvas') !== null
      && container.querySelector('.slick-row') !== null;
  }

  private static clearTimers(gridId: string): void {
    const resizeTimer = this.resizeTimers.get(gridId);
    if (resizeTimer !== undefined) {
      cancelAnimationFrame(resizeTimer);
      this.resizeTimers.delete(gridId);
    }

    const restoreTimer = this.restoreTimers.get(gridId);
    if (restoreTimer !== undefined) {
      activeWindow.clearTimeout(restoreTimer);
      this.restoreTimers.delete(gridId);
    }
  }

  private static destroyMountedGrid(record: GridRecord): void {
    if (!record.grid) {
      return;
    }

    record.domObserver?.disconnect();
    record.domObserver = undefined;
    this.cancelActiveColumnResize(record);

    const grid = record.grid;
    record.grid = undefined;
    try {
      grid.destroy();
    }
    catch {
      // Ignore destruction errors during controlled cleanup/recreate.
    }
  }

  static checkAndRestoreGrids(): void {
    const now = Date.now();

    for (const [gridId, record] of Array.from(this.records.entries())) {
      if (record.disposed) {
        this.records.delete(gridId);
        continue;
      }

      if (!record.container.isConnected) {
        if (!record.detachedAt) {
          record.detachedAt = now;
          if (!record.detachLogged) {
            logger.debug(`SlickGrid ${gridId} container detached; waiting for reconnect`);
            record.detachLogged = true;
          }
        }
        else if (now - record.detachedAt > this.DETACHED_RECORD_TTL_MS) {
          logger.debug(`SlickGrid ${gridId} detached record expired; cleaning up`);
          this.cleanupRecord(record);
        }
        continue;
      }

      record.detachedAt = undefined;
      record.detachLogged = undefined;
      this.ensureGridMounted(record, 'periodic restore check');
    }

    this.refreshOrphanedGridContainers();
  }

  private static refreshOrphanedGridContainers(): void {
    for (const doc of this.getCandidateDocuments(activeWindow.document)) {
      const grids = Array.from(doc.querySelectorAll('.vaultquery-data-grid'));
      for (const grid of grids) {
        if (!(grid instanceof HTMLElement) || !grid.isConnected) {
          continue;
        }

        const gridId = grid.dataset.gridId || grid.id;
        if (gridId && this.records.has(gridId)) {
          continue;
        }

        if (this.hasUsableGridElementDom(grid) || this.orphanRefreshElements.has(grid)) {
          continue;
        }

        this.orphanRefreshElements.add(grid);
        logger.debug(`Refreshing orphaned SlickGrid container ${gridId || '(unknown id)'}`);
        void QueryRefreshRegistry.refreshForElement(grid)
          .then(refreshed => {
            if (!refreshed) {
              logger.debug(`Orphaned SlickGrid container ${gridId || '(unknown id)'} has no refresh owner`);
            }
          })
          .finally(() => {
            this.orphanRefreshElements.delete(grid);
          });
      }
    }
  }

  static cleanupContainer(container: HTMLElement): void {
    QueryRefreshRegistry.unregister(container);

    for (const record of Array.from(this.records.values())) {
      if (container === record.container || container.contains(record.container)) {
        this.cleanupRecord(record);
      }
    }

    container.empty();
  }

  private static cleanupRecord(record: GridRecord): void {
    if (record.disposed) {
      return;
    }

    logger.debug(`Cleaning up SlickGrid ${record.id}`);
    record.disposed = true;
    this.clearTimers(record.id);
    this.disconnectContainerObservers(record);
    this.destroyMountedGrid(record);
    this.records.delete(record.id);
  }

  private static getCandidateDocuments(primaryDocument: Document): Set<Document> {
    const documents = new Set<Document>();
    documents.add(primaryDocument);
    documents.add(activeWindow.document);
    if (typeof document !== 'undefined') {
      documents.add(document);
    }
    return documents;
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

  private static createGridOptions(allowHorizontalScroll: boolean = false, hasMarkdownContent: boolean = false): GridOption {
    return {
      enableCellNavigation: false,
      enableColumnReorder: false,
      enableTextSelectionOnCells: true,
      headerRowHeight: 30,
      rowHeight: hasMarkdownContent ? 150 : 32,
      defaultColumnWidth: 120,
      forceFitColumns: !allowHorizontalScroll,
      syncColumnCellResize: true,
      enableAsyncPostRender: false,
      asyncEditorLoading: false,
      enableAddRow: false,
      editable: false,
    };
  }

  private static parseHeightConfig(options?: Record<string, unknown>): GridHeightConfig {
    const height = this.parseGridDimension(options?.height);
    const minHeight = this.parseGridDimension(options?.minheight);
    const maxHeight = this.parseGridDimension(options?.maxheight);

    return {
      height,
      minHeight: minHeight ?? height,
      maxHeight: maxHeight ?? height
    };
  }

  private static parseGridDimension(value: unknown): string | undefined {
    const dimension = parseCssDimension(value, { bareNumber: 'px' });
    return typeof dimension === 'string' ? dimension : undefined;
  }

  private static applyHeightConfig(gridContainer: HTMLElement, config: GridHeightConfig): void {
    if (config.height) {
      gridContainer.style.setProperty('--vaultquery-grid-height', config.height);
    }
    if (config.minHeight) {
      gridContainer.style.setProperty('--vaultquery-grid-min-height', config.minHeight);
    }
    if (config.maxHeight) {
      gridContainer.style.setProperty('--vaultquery-grid-max-height', config.maxHeight);
    }
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
      return 360;
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

      return formatTimestampValue(value);
    };
  }

  private static createDateStringFormatter() {
    return (_row: number, _cell: number, value: unknown, _columnDef: Column, _dataContext: Record<string, unknown>) => {
      if (!value) return '';

      return formatIsoDateString(String(value));
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
    const formattedValue = this.formatValueByFieldName(value, baseFieldName);
    const escapedValue = escapeHTML(formattedValue);
    const escapedTitle = escapeHTML(formattedValue);
    const isChanged = dataContext?.[changedFieldName] === true;

    if (!isChanged) {
      return `<span title="${escapedTitle}" style="opacity: 0.8;">${escapedValue}</span>`;
    }

    const changedStyle = variant === 'current'
      ? 'font-style: italic; opacity: 0.8;'
      : 'font-weight: 600;';
    return `<span title="${escapedTitle}" style="${changedStyle}">${escapedValue}</span>`;
  }

  private static formatValueByFieldName(value: unknown, fieldName: string): string {
    if (value === null || value === undefined || value === '') {
      return '';
    }

    if (fieldName === 'created' || fieldName === 'modified') {
      return formatTimestampValue(value);
    }

    const dateFields = ['due_date', 'scheduled_date', 'start_date', 'created_date', 'done_date', 'cancelled_date'];
    if (dateFields.includes(fieldName)) {
      return formatIsoDateString(String(value));
    }

    return String(value);
  }

  private static setupEventHandlers(grid: SlickGrid, record: GridRecord): void {
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
          record.context.openFile(path);
        }
      }
    });

    grid.onBeforeDestroy.subscribe(() => {
      if (this.records.get(record.id) === record && record.grid === grid && !record.disposed) {
        logger.debug(`SlickGrid destroyed unexpectedly; scheduling restore ${record.id}`);
        record.grid = undefined;
        this.scheduleGridEnsure(record, 'unexpected destroy');
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

  private static cancelActiveColumnResize(record: GridRecord): void {
    const documents = new Set<Document>();
    documents.add(record.container.ownerDocument);
    documents.add(activeWindow.document);
    if (typeof document !== 'undefined') {
      documents.add(document);
    }

    for (const doc of documents) {
      const body = doc.body;
      if (!body) {
        continue;
      }

      for (let index = trackedSlickGridBodyResizeListeners.length - 1; index >= 0; index--) {
        const tracked = trackedSlickGridBodyResizeListeners[index];
        if (tracked.target !== body) {
          continue;
        }

        trackedSlickGridBodyResizeListeners.splice(index, 1);
        body.removeEventListener(tracked.type, tracked.listener, tracked.options);
      }
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
    for (const record of Array.from(this.records.values())) {
      this.cleanupRecord(record);
    }
    this.resizeTimers.clear();
    this.restoreTimers.clear();
  }

}
