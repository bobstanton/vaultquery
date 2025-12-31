import { MarkdownPostProcessorContext } from 'obsidian';
import { VaultQueryAPI } from '../VaultQueryAPI';
import type { IndexingProgress } from '../types';

declare const activeWindow: Window;

export interface PendingBlock {
  container: HTMLElement;
  source: string;
  el: HTMLElement;
  ctx: MarkdownPostProcessorContext;
  type: string;
}

export interface BlockProcessor {
  getPendingBlocks(): Set<PendingBlock>;
  clearPendingBlocks(): void;
  process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void>;
}

export function createLoadingIndicator(container: HTMLElement, initialText: string = 'Loading...'): {
  setText: (text: string) => void;
  remove: () => void;
} {
  const loadingContainer = container.createDiv({ cls: 'vaultquery-loading' });
  const loadingText = loadingContainer.createDiv({
    text: initialText,
    cls: 'vaultquery-loading-text'
  });
  loadingContainer.createDiv({ cls: 'vaultquery-loading-spinner' });

  return {
    setText: (text: string) => { loadingText.textContent = text; },
    remove: () => loadingContainer.remove()
  };
}

export function renderIndexingProgress(loadingDiv: HTMLElement, progress?: IndexingProgress): void {
  loadingDiv.empty();
  loadingDiv.addClass('vaultquery-loading');

  const textContainer = loadingDiv.createDiv({ cls: 'vaultquery-loading-text' });

  if (!progress || progress.total === 0) {
    textContainer.textContent = progress?.currentFile || 'Initializing database...';
  }
  else {
    const progressText = textContainer.createDiv({ cls: 'vaultquery-progress-count' });
    // eslint-disable-next-line obsidianmd/prefer-stringify-yaml -- This is UI progress text, not YAML construction
    progressText.textContent = `Indexing: ${progress.current}/${progress.total} files`;

    if (progress.currentFile && progress.currentFile !== 'Starting...' && progress.currentFile !== 'Complete') {
      const currentFile = textContainer.createDiv({ cls: 'vaultquery-progress-file' });
      currentFile.textContent = progress.currentFile;
    }
  }

  loadingDiv.createDiv({ cls: 'vaultquery-loading-spinner' });
}

export interface IndexingCheckResult {
  ready: boolean;
}

export interface IndexingCheckOptions {
  getApi: () => VaultQueryAPI | null;
  container: HTMLElement;
  pendingBlocks: Set<PendingBlock>;
  blockInfo: PendingBlock;

  onReady: () => Promise<void>;
}

export function waitForIndexingWithProgress(getApi: () => VaultQueryAPI | null, container: HTMLElement, onReady: () => void | Promise<void>): boolean {
  const api = getApi();

  if (api && !api.getIndexingStatus().isIndexing) {
    return true;
  }

  const loading = createLoadingIndicator(container, 'Waiting for database...');
  const indexingStatus = api?.getIndexingStatus();
  if (indexingStatus?.progress) {
    // eslint-disable-next-line obsidianmd/prefer-stringify-yaml -- UI status text, not YAML
    loading.setText(`Indexing: ${indexingStatus.progress.current}/${indexingStatus.progress.total} files`);
  }

  const checkInterval = activeWindow.setInterval(() => {
    if (!container.isConnected) {
      activeWindow.clearInterval(checkInterval);
      return;
    }

    const polledApi = getApi();
    if (!polledApi) return;

    const status = polledApi.getIndexingStatus();
    if (!status.isIndexing) {
      activeWindow.clearInterval(checkInterval);
      loading.remove();
      void Promise.resolve(onReady());
    }
    else if (status.progress) {
      // eslint-disable-next-line obsidianmd/prefer-stringify-yaml -- UI status text, not YAML
      loading.setText(`Indexing: ${status.progress.current}/${status.progress.total} files`);
    }
  }, 500);

  return false;
}

export function checkIndexingAndWait(options: IndexingCheckOptions): IndexingCheckResult {
  const { getApi, container, pendingBlocks, blockInfo, onReady } = options;

  const api = getApi();

  if (api) {
    const indexingStatus = api.getIndexingStatus();
    if (!indexingStatus.isIndexing) {
      return { ready: true };
    }
  }

  const loadingDiv = container.createDiv({ cls: 'vaultquery-loading' });
  const currentApi = getApi();
  if (currentApi) {
    renderIndexingProgress(loadingDiv, currentApi.getIndexingStatus().progress);
  }
  else {
    renderIndexingProgress(loadingDiv, { current: 0, total: 0, currentFile: 'Initializing database...' });
  }
  pendingBlocks.add(blockInfo);

  const checkInterval = activeWindow.setInterval(async () => {
    if (!container.isConnected) {
      activeWindow.clearInterval(checkInterval);
      return;
    }

    const polledApi = getApi();
    if (!polledApi) {
      return;
    }

    const status = polledApi.getIndexingStatus();

    if (!status.isIndexing) {
      activeWindow.clearInterval(checkInterval);
      container.empty();
      await onReady();
    }
    else if (status.progress) {
      renderIndexingProgress(loadingDiv, status.progress);
    }
  }, 500);

  return { ready: false };
}
