import { BaseRenderer } from './BaseRenderer';
import type { App } from 'obsidian';

export interface FloatingButtonsOptions {
  /** A reader keeps the rows where the renderer already holds them, instead of a second strong reference. */
  results?: Record<string, unknown>[] | (() => Record<string, unknown>[]);
  columns?: readonly string[] | (() => readonly string[] | undefined);
  dataFileColumns?: readonly string[];
  app?: App;
  exportFolder?: string;
  exportName?: string;
  onRefresh?: (force?: boolean) => Promise<void>;
}

interface FloatingButtonsState {
  buttonContainer: HTMLElement;
  readResults?: () => Record<string, unknown>[];
  readColumns?: () => readonly string[] | undefined;
  dataFileColumns?: readonly string[];
  app?: App;
  exportFolder: string;
  exportName: string;
  onRefresh?: (force?: boolean) => Promise<void>;
  shape: string;
  listeners: AbortController;
}

function release(state: FloatingButtonsState): void {
  state.listeners.abort();
  state.readResults = undefined;
  state.readColumns = undefined;
  state.onRefresh = undefined;
  state.app = undefined;
}

// Editor views may retain containers after their output is removed.
export function releaseFloatingButtons(container: HTMLElement): void {
  for (const element of [container, ...Array.from(container.querySelectorAll<HTMLElement>('[data-vaultquery-chrome]'))]) {
    const state = floatingControls.get(element);
    if (!state) continue;
    release(state);
    floatingControls.delete(element);
    delete element.dataset.vaultqueryChrome;
  }
}

const floatingControls = new WeakMap<HTMLElement, FloatingButtonsState>();

export function getFloatingButtonContainer(container: HTMLElement): HTMLElement | null {
  const state = floatingControls.get(container);

  return state && state.buttonContainer.isConnected ? state.buttonContainer : null;
}

export function addFloatingButtons(container: HTMLElement, options: FloatingButtonsOptions): void {
  const existing = floatingControls.get(container);

  const readResults = typeof options.results === 'function' ? options.results
    : options.results?.length ? () => options.results as Record<string, unknown>[] : undefined;

  const readColumns = typeof options.columns === 'function' ? options.columns
    : options.columns ? () => options.columns as readonly string[] : undefined;

  // The buttons themselves depend on nothing but which of them there are; the
  // rows, the columns and the name are read when the reader asks for them.
  const shape = `${Boolean(readResults)}|${Boolean(options.onRefresh)}`;

  if (existing?.buttonContainer.isConnected && existing.buttonContainer.parentElement === container && existing.shape === shape) {
    existing.readResults = readResults;
    existing.readColumns = readColumns;
    existing.dataFileColumns = options.dataFileColumns;
    existing.app = options.app;
    existing.exportFolder = options.exportFolder ?? existing.exportFolder;
    existing.exportName = options.exportName ?? existing.exportName;
    existing.onRefresh = options.onRefresh;

    return;
  }

  if (existing) {
    release(existing);
  }

  for (const child of Array.from(container.children)) {
    if (child.classList.contains('vaultquery-floating-buttons')) {
      child.remove();
    }
  }

  const buttonContainer = container.createDiv('vaultquery-floating-buttons');

  const state: FloatingButtonsState = {
    buttonContainer,
    readResults,
    readColumns,
    dataFileColumns: options.dataFileColumns,
    app: options.app,
    exportFolder: options.exportFolder ?? '',
    exportName: options.exportName ?? 'vaultquery',
    onRefresh: options.onRefresh,
    shape,
    listeners: new AbortController(),
  };

  floatingControls.set(container, state);
  container.dataset.vaultqueryChrome = 'buttons';

  if (readResults) {
    BaseRenderer.addExportButton(buttonContainer, {
      get app() { return state.app; },
      get exportFolder() { return state.exportFolder; },
      get name() { return state.exportName; },
      get dataFileColumns() { return state.dataFileColumns; },
      readRows: () => state.readResults?.() ?? [],
      readColumns: () => state.readColumns?.(),
    }, state.listeners.signal);
  }

  if (options.onRefresh) {
    BaseRenderer.addRefreshButton(buttonContainer, async force => {
      await state.onRefresh?.(force);
    }, state.listeners.signal);
  }
}
