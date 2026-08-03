import { MarkdownRenderer } from 'obsidian';
import { Column, SlickGrid, GridOption } from 'slickgrid';
import type { ColumnSort, MultiColumnSort, SingleColumnSort } from 'slickgrid';
import { BaseRenderer } from './BaseRenderer';
import { QueryRefreshRegistry, resolveAutoRefreshSetting } from './QueryRefreshRegistry';
import { getErrorMessage } from '../utils/ErrorMessages';
import { generateUniqueId, escapeHTML, hashString } from '../utils/StringUtils';
import { parseCssDimension } from '../utils/ConfigParsingUtils';
import { formatIsoDateString, formatTimestampValue, formatUnknownValue } from '../utils/ResultFormatUtils';
import type { RenderContext } from './BaseRenderer';
import '../slickgrid-alpine-theme.css';
import { logger as rootLogger } from '../utils/logger';

declare const activeWindow: Window;
declare const activeDocument: Document;

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
// registered inside VaultQuery grids. This eliminates "[Violation] Added
// non-passive event listener" warnings from SlickGrid without changing the
// behavior of listeners registered by Obsidian core or other plugins.
// The patch is reverted in SlickGridRenderer.cleanup() (plugin unload).
let originalAddEventListener: EventTarget['addEventListener'] | null = null;
let originalRemoveEventListener: EventTarget['removeEventListener'] | null = null;

function isInsideVaultQueryGrid(target: EventTarget): boolean {
  return target instanceof Element && target.closest('.vaultquery-data-grid') !== null;
}

function patchPassiveEventListeners(): void {
  if (originalAddEventListener) return;

  originalAddEventListener = Reflect.get(EventTarget.prototype, 'addEventListener');
  originalRemoveEventListener = Reflect.get(EventTarget.prototype, 'removeEventListener');
  const addEventListener = originalAddEventListener;
  const removeEventListener = originalRemoveEventListener;
  const passiveEvents = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel']);

  EventTarget.prototype.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (passiveEvents.has(type) && isInsideVaultQueryGrid(this)) {
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

    return addEventListener.call(this, type, listener, options);
  };

  EventTarget.prototype.removeEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (listener) {
      removeTrackedSlickGridBodyResizeListener(this, type, listener);
    }
    return removeEventListener.call(this, type, listener, options);
  };
}

function unpatchPassiveEventListeners(): void {
  if (!originalAddEventListener || !originalRemoveEventListener) return;

  EventTarget.prototype.addEventListener = originalAddEventListener;
  EventTarget.prototype.removeEventListener = originalRemoveEventListener;
  originalAddEventListener = null;
  originalRemoveEventListener = null;
  trackedSlickGridBodyResizeListeners.length = 0;
}

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
  data: Record<string, unknown>[];
  columns: Column[];
  options: GridOption;
  openFile: RenderContext['openFile'];
  queryHash?: string;
  disposed?: boolean;
  mountFailures?: number;
}

interface GridHeightConfig {
  height?: string;
  minHeight?: string;
  maxHeight?: string;
}

export class SlickGridRenderer extends BaseRenderer {
  private static records = new Map<string, GridRecord>();
  private static resizeTimers = new Map<string, number>();
  private static restoreTimers = new Map<string, number>();
  private static columnWidthCache = new Map<string, Map<string, number>>();

  private static readonly COLUMN_WIDTH_CACHE_LIMIT = 200;

  private static saveColumnWidths(queryHash: string, columns: Column[]): void {
    const widths = new Map<string, number>();
    for (const col of columns) {
      if (col.width) {
        widths.set(String(col.id), col.width);
      }
    }

    // Refresh insertion order so eviction below is least-recently-saved.
    this.columnWidthCache.delete(queryHash);
    this.columnWidthCache.set(queryHash, widths);

    while (this.columnWidthCache.size > this.COLUMN_WIDTH_CACHE_LIMIT) {
      const oldestKey = this.columnWidthCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.columnWidthCache.delete(oldestKey);
    }
  }

  private static getSavedColumnWidth(queryHash: string, columnId: string): number | undefined {
    const widths = this.columnWidthCache.get(queryHash);
    return widths?.get(columnId);
  }

  static render(context: RenderContext): void {
    patchPassiveEventListeners();

    const { results, container } = context;

    if (results.length === 0) {
      this.cleanupContainer(container);
      this.registerRefresh(context);
      container.createDiv({ cls: 'vaultquery-empty', text: 'No results found' });
      return;
    }

    const queryHash = context.parsed?.query ? hashString(context.parsed.query) : undefined;
    const existingRecord = this.findCompatibleRecord(container, results[0], queryHash);
    if (existingRecord?.grid) {
      this.registerRefresh(context);
      const prepareStartedAt = performance.now();
      existingRecord.data = this.prepareData(results);
      existingRecord.openFile = context.openFile;
      const prepareMs = performance.now() - prepareStartedAt;
      const updateStartedAt = performance.now();
      existingRecord.grid.setData(existingRecord.data, false);
      existingRecord.grid.updateRowCount();
      const activeSort = existingRecord.grid.getSortColumns();
      if (activeSort.length > 0) {
        this.sortGridData(existingRecord.grid, {
          grid: existingRecord.grid,
          multiColumnSort: true,
          sortCols: activeSort,
        });
      } else {
        existingRecord.grid.invalidateAllRows();
        existingRecord.grid.render();
      }
      logger.debug(`SlickGrid updated in place ${existingRecord.id}: rows=${existingRecord.data.length}, columns=${existingRecord.columns.length}, prepareMs=${Math.round(prepareMs)}, updateMs=${Math.round(performance.now() - updateStartedAt)}`);
      return;
    }

    this.cleanupContainer(container);
    this.registerRefresh(context);

    const gridContainer: HTMLElement = container.createDiv({ cls: 'vaultquery-data-grid' });
    this.applyHeightConfig(gridContainer, this.parseHeightConfig(context.parsed.output?.options));
    const gridId = generateUniqueId('data-grid');
    gridContainer.id = gridId;
    gridContainer.tabIndex = -1;

    gridContainer.dataset.gridId = gridId;

    const prepareStartedAt = performance.now();
    const columns = this.createColumns(results[0], context, queryHash);
    const data = this.prepareData(results);
    const preferredTotalWidth = columns.reduce((sum, col) => sum + (col.width || col.minWidth || 120), 0);
    const currentContainerWidth = gridContainer.offsetWidth || 800;
    const shouldAllowScroll = preferredTotalWidth > currentContainerWidth;
    const hasMarkdownContent = this.shouldRenderMarkdownContent(context) && 'content' in results[0];
    const options = this.createGridOptions(shouldAllowScroll, hasMarkdownContent);
    const prepareMs = performance.now() - prepareStartedAt;

    const record: GridRecord = {
      id: gridId,
      container: gridContainer,
      data,
      columns,
      options,
      openFile: context.openFile,
      queryHash,
    };

    this.records.set(gridId, record);
    logger.debug(`SlickGrid prepared ${gridId}: rows=${data.length}, columns=${columns.length}, prepareMs=${Math.round(prepareMs)}`);
    this.attachContainerObservers(record);
    this.scheduleGridEnsure(record, 'initial render');
  }

  private static registerRefresh(context: RenderContext): void {
    if (!context.onRefresh) return;
    QueryRefreshRegistry.register(context.container, {
      onRefresh: context.onRefresh,
      autoRefresh: resolveAutoRefreshSetting(context.settings, context.parsed),
    });
  }

  private static findCompatibleRecord(container: HTMLElement, firstResult: Record<string, unknown>, queryHash: string | undefined): GridRecord | undefined {
    const resultColumns = Object.keys(firstResult).filter(key => !key.startsWith('_'));
    for (const record of this.records.values()) {
      if (record.disposed || record.queryHash !== queryHash || record.container.parentElement !== container) continue;
      const existingColumns = record.columns.map(column => String(column.id));
      if (existingColumns.length === resultColumns.length && existingColumns.every((column, index) => column === resultColumns[index])) {
        return record;
      }
    }
    return undefined;
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

    const containerWindow = record.container.ownerDocument.defaultView || activeWindow;

    const existingTimer = this.resizeTimers.get(record.id);
    if (existingTimer !== undefined) {
      containerWindow.cancelAnimationFrame(existingTimer);
    }

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
      logger.debug(`SlickGrid ${record.id} container detached; holding mount until it reattaches (${reason})`);
      return;
    }

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
      const mountStartedAt = performance.now();
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
      logger.debug(`SlickGrid initialized ${record.id}: rows=${record.data.length}, columns=${record.columns.length}, mountMs=${Math.round(performance.now() - mountStartedAt)}`);

      // Single post-layout fixup: setColumns re-measures widths after layout
      // and fonts settle, and refreshGrid resizes the canvas.
      const containerWindow = record.container.ownerDocument.defaultView || activeWindow;
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

      // Stop the observer-driven restore from retrying (and re-rendering this
      // error) forever when mounting fails deterministically.
      record.mountFailures = (record.mountFailures ?? 0) + 1;
      if (record.mountFailures >= 3) {
        logger.debug(`SlickGrid ${record.id} failed to mount ${record.mountFailures} times; giving up`);
        this.cleanupRecord(record);
      }
    }
  }

  private static attachContainerObservers(record: GridRecord): void {
    if (record.observer && record.resizeObserver) {
      return;
    }
    this.disconnectContainerObservers(record);

    const container = record.container;
    const containerWindow = container.ownerDocument.defaultView || activeWindow;

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
  }

  private static disconnectContainerObservers(record: GridRecord): void {
    record.observer?.disconnect();
    record.resizeObserver?.disconnect();
    record.observer = undefined;
    record.resizeObserver = undefined;
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
      window.cancelAnimationFrame(resizeTimer);
      this.resizeTimers.delete(gridId);
    }

    const restoreTimer = this.restoreTimers.get(gridId);
    if (restoreTimer !== undefined) {
      window.clearTimeout(restoreTimer);
      this.restoreTimers.delete(gridId);
    }
  }

  private static destroyMountedGrid(record: GridRecord): void {
    if (!record.grid) {
      return;
    }

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
    if (typeof activeDocument !== 'undefined') {
      documents.add(activeDocument);
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
          ...this.getColumnConfig(key)
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
          column.asyncPostRender = this.createMarkdownCellPostRenderer(context);
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
      enableAsyncPostRender: hasMarkdownContent,
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

  private static getColumnConfig(key: string): Partial<Column> {
    const config: Partial<Column> = {};

    const width = this.getColumnWidth(key);
    config.width = width;
    config.minWidth = 50;
    // No maxWidth - allow columns to be resized as large as needed

    const formatter = this.getColumnFormatter(key);
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

  private static getColumnFormatter(key: string) {
    if (key.includes('(current)')) {
      return this.createCurrentFormatter();
    }
    if (key.includes('(proposed)')) {
      return this.createProposedFormatter();
    }

    switch (key) {
      case 'path':
        return this.createPathFormatter();
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
        return this.createContentFormatter();
      default:
        return null;
    }
  }

  private static createPathFormatter() {
    return (_row: number, _cell: number, value: unknown, _columnDef: Column, _dataContext: Record<string, unknown>) => {
      if (!value) return '';
      const escapedPath = escapeHTML(formatUnknownValue(value));
      return `<a href="${escapedPath}" class="internal-link slick-path-link" data-path="${escapedPath}">${escapedPath}</a>`;
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

      return formatIsoDateString(formatUnknownValue(value));
    };
  }

  private static sanitizeMarkdownCellContent(value: unknown): string {
    const content = formatUnknownValue(value);
    return content.replace(/```vaultquery[^\n]*/g, '```sql');
  }

  private static createContentFormatter() {
    // Plain-text placeholder; in rendered-markdown mode the real rendering
    // happens in the asyncPostRender callback, which can await
    // MarkdownRenderer and append actual DOM nodes.
    return (_row: number, _cell: number, value: unknown, _columnDef: Column, _dataContext: Record<string, unknown>) => {
      const sanitizedContent = this.sanitizeMarkdownCellContent(value);
      if (!sanitizedContent) return '';
      return escapeHTML(sanitizedContent);
    };
  }

  private static createMarkdownCellPostRenderer(context: RenderContext) {
    return (domCellNode: HTMLElement, _row: number, dataContext: Record<string, unknown>, _columnDef: Column) => {
      const { app, pluginContext } = context;
      if (!pluginContext) return;

      const sanitizedContent = this.sanitizeMarkdownCellContent(dataContext?.content);
      if (!sanitizedContent) return;

      const container = domCellNode.createDiv();
      container.detach();
      container.className = 'vaultquery-markdown-cell';

      MarkdownRenderer.render(app, sanitizedContent, container, '', pluginContext)
        .then(() => {
          if (domCellNode.isConnected) {
            domCellNode.empty();
            domCellNode.appendChild(container);
          }
        })
        .catch(error => {
          logger.warn('Failed to render markdown cell', error);
        });
    };
  }

  private static shouldRenderMarkdownContent(context: RenderContext): boolean {
    return context.settings.contentRenderingMode === 'rendered-markdown';
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
    const columnName = typeof columnDef.name === 'string' ? columnDef.name : formatUnknownValue(columnDef.name);
    const baseFieldName = columnName.replace(suffix, '');
    const changedFieldName = `_${baseFieldName}_changed`;
    const formattedValue = this.formatValueByFieldName(value, baseFieldName);
    const escapedValue = escapeHTML(formattedValue);
    const escapedTitle = escapeHTML(formattedValue);
    const isChanged = dataContext?.[changedFieldName] === true;

    if (!isChanged) {
      return `<span title="${escapedTitle}" class="vaultquery-comparison-cell">${escapedValue}</span>`;
    }

    const changedClass = variant === 'current'
      ? 'vaultquery-comparison-changed-current'
      : 'vaultquery-comparison-changed-proposed';
    return `<span title="${escapedTitle}" class="${changedClass}">${escapedValue}</span>`;
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
      return formatIsoDateString(formatUnknownValue(value));
    }

    return formatUnknownValue(value);
  }

  private static setupEventHandlers(grid: SlickGrid, record: GridRecord): void {
    grid.onSort.subscribe((_e, args) => {
      this.sortGridData(grid, args);
    });

    grid.onClick.subscribe((e) => {
      const target = e.target as HTMLElement;

      if (target.classList.contains('slick-scrollbar') ||
        target.closest('.slick-header') ||
        target.classList.contains('slick-resizable-handle')) {
        return;
      }

      if (target.classList.contains('slick-path-link')) {
        e.preventDefault();
        e.stopPropagation();
        const path = target.getAttribute('data-path');
        if (path) {
          record.openFile(path);
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
    const columns: Array<{ field: string; asc: boolean }> = [];
    for (const sortColumn of sortColumns) {
      const field = this.getSortField(sortColumn);
      if (field !== null) {
        columns.push({ field, asc: !!sortColumn.sortAsc });
      }
    }

    if (columns.length === 0) {
      return;
    }

    const data = grid.getData() as unknown;
    if (!Array.isArray(data)) {
      return;
    }

    const rows = data as Record<string, unknown>[];

    // Precompute sort keys once per cell (O(n) conversions) instead of parsing
    // numbers/dates inside the comparator (O(n log n) conversions per side).
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const indexedRows = rows.map((item, index) => ({
      item,
      index,
      keys: columns.map(column => this.buildSortKey(item[column.field])),
    }));

    indexedRows.sort((left, right) => {
      for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
        const comparison = this.compareSortKeys(left.keys[columnIndex], right.keys[columnIndex], collator);
        if (comparison !== 0) {
          return columns[columnIndex].asc ? comparison : -comparison;
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

  private static buildSortKey(value: unknown): { empty: boolean; num: number | null; str: string } {
    if (value === null || value === undefined || value === '') {
      return { empty: true, num: null, str: '' };
    }

    return { empty: false, num: this.toSortableNumber(value), str: formatUnknownValue(value) };
  }

  private static compareSortKeys(
    left: { empty: boolean; num: number | null; str: string },
    right: { empty: boolean; num: number | null; str: string },
    collator: Intl.Collator
  ): number {
    if (left.empty && right.empty) {
      return 0;
    }
    if (left.empty) {
      return 1;
    }
    if (right.empty) {
      return -1;
    }

    if (left.num !== null && right.num !== null) {
      return left.num - right.num;
    }

    return collator.compare(left.str, right.str);
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
    const documents = this.getCandidateDocuments(record.container.ownerDocument);

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

  static cleanup(): void {
    for (const record of Array.from(this.records.values())) {
      this.cleanupRecord(record);
    }
    this.resizeTimers.clear();
    this.restoreTimers.clear();
    unpatchPassiveEventListeners();
  }

}
