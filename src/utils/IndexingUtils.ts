import { MarkdownPostProcessorContext } from 'obsidian';
import { VaultQueryAPI } from '../VaultQueryAPI';
import type { IndexingProgress } from '../types';
import { logger as rootLogger } from './logger';

const logger = rootLogger.scope('Indexing');

export const VAULTQUERY_DATABASE_PREPARING_MESSAGE = 'Preparing VaultQuery database...';

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

interface WaitForIndexingOptions {
  getApi: () => VaultQueryAPI | null;
  hasPendingFileModifications?: () => boolean;
  timeoutMs?: number;
  pendingCheckIntervalMs?: number;
  onPendingTimeout?: () => void;
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

export async function waitForVaultQueryIndexing(options: WaitForIndexingOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const pendingCheckIntervalMs = options.pendingCheckIntervalMs ?? 50;
  const startedAt = Date.now();

  while (options.hasPendingFileModifications?.() === true) {
    if (Date.now() - startedAt > timeoutMs) {
      options.onPendingTimeout?.();
      return;
    }

    await new Promise(resolve => window.setTimeout(resolve, pendingCheckIntervalMs));
  }

  const api = options.getApi();
  if (!api) {
    return;
  }

  const remainingTime = timeoutMs - (Date.now() - startedAt);
  if (remainingTime > 0) {
    await api.waitForIndexing(remainingTime);
  }
}

export function renderIndexingProgress(loadingDiv: HTMLElement, progress?: IndexingProgress): void {
  loadingDiv.empty();
  loadingDiv.addClass('vaultquery-loading');

  const textContainer = loadingDiv.createDiv({ cls: 'vaultquery-loading-text' });

  if (!progress || progress.total === 0) {
    textContainer.textContent = progress?.currentFile || VAULTQUERY_DATABASE_PREPARING_MESSAGE;
  }
  else {
    const progressText = textContainer.createDiv({ cls: 'vaultquery-progress-count' });
    progressText.textContent = "Indexing: " + progress.current + "/" + progress.total + " files";

    if (progress.currentFile && progress.currentFile !== 'Starting...' && progress.currentFile !== 'Complete') {
      const currentFile = textContainer.createDiv({ cls: 'vaultquery-progress-file' });
      currentFile.textContent = progress.currentFile;
    }
  }

  loadingDiv.createDiv({ cls: 'vaultquery-loading-spinner' });
}

interface IndexingCheckResult {
  ready: boolean;
}

interface IndexingCheckOptions {
  getApi: () => VaultQueryAPI | null;
  container: HTMLElement;
  pendingBlocks: Set<PendingBlock>;
  blockInfo: PendingBlock;
}

export function waitForIndexingWithProgress(getApi: () => VaultQueryAPI | null, container: HTMLElement, onReady: () => void | Promise<void>): boolean {
  return waitForIndexingAndRender({
    getApi,
    container,
    onReady: async () => { await Promise.resolve(onReady()); },
    clearContainerOnReady: false,
    removeLoadingOnReady: true,
  }).ready;
}

export function checkIndexingAndWait(options: IndexingCheckOptions): IndexingCheckResult {
  const { pendingBlocks, blockInfo } = options;
  const api = options.getApi();
  if (api && !api.getIndexingStatus().isIndexing) {
    return { ready: true };
  }

  const loadingDiv = options.container.createDiv({ cls: 'vaultquery-loading' });
  const progress = api?.getIndexingStatus().progress ?? { current: 0, total: 0, currentFile: VAULTQUERY_DATABASE_PREPARING_MESSAGE };
  renderIndexingProgress(loadingDiv, progress);
  pendingBlocks.add(blockInfo);

  return { ready: false };
}

function waitForIndexingAndRender(options: {
  getApi: () => VaultQueryAPI | null;
  container: HTMLElement;
  onReady: () => Promise<void>;
  clearContainerOnReady: boolean;
  removeLoadingOnReady: boolean;
}): IndexingCheckResult {
  const api = options.getApi();
  if (api) {
    const indexingStatus = api.getIndexingStatus();
    if (!indexingStatus.isIndexing) {
      return { ready: true };
    }
  }

  const loadingDiv = options.container.createDiv({ cls: 'vaultquery-loading' });
  const currentApi = options.getApi();
  if (currentApi) {
    renderIndexingProgress(loadingDiv, currentApi.getIndexingStatus().progress);
  }
  else {
    renderIndexingProgress(loadingDiv, { current: 0, total: 0, currentFile: VAULTQUERY_DATABASE_PREPARING_MESSAGE });
  }
  const checkInterval = window.setInterval(() => {
    if (!options.container.isConnected) {
      window.clearInterval(checkInterval);
      return;
    }

    const polledApi = options.getApi();
    if (!polledApi) {
      return;
    }

    const status = polledApi.getIndexingStatus();

    if (!status.isIndexing) {
      window.clearInterval(checkInterval);
      if (options.clearContainerOnReady) {
        options.container.empty();
      }
      else if (options.removeLoadingOnReady) {
        loadingDiv.remove();
      }
      void options.onReady().catch((error: unknown) => {
        logger.error('Indexing onReady callback failed', error);
      });
    }
    else if (status.progress) {
      renderIndexingProgress(loadingDiv, status.progress);
    }
  }, 500);

  return { ready: false };
}
