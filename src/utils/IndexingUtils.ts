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
  const loadingDiv = createLoadingDivUnlessReady(getApi(), container);
  if (!loadingDiv) {
    return true;
  }

  const checkInterval = window.setInterval(() => {
    if (!container.isConnected) {
      window.clearInterval(checkInterval);
      return;
    }

    const polledApi = getApi();
    if (!polledApi) {
      return;
    }

    const status = polledApi.getIndexingStatus();

    if (!status.isIndexing) {
      window.clearInterval(checkInterval);
      loadingDiv.remove();
      void Promise.resolve(onReady()).catch((error: unknown) => {
        logger.error('Indexing onReady callback failed', error);
      });
    }
    else if (status.progress) {
      renderIndexingProgress(loadingDiv, status.progress);
    }
  }, 500);

  return false;
}

function createLoadingDivUnlessReady(api: VaultQueryAPI | null, container: HTMLElement): HTMLElement | null {
  if (api && !api.getIndexingStatus().isIndexing) {
    return null;
  }

  const loadingDiv = container.createDiv({ cls: 'vaultquery-loading' });
  const progress = api?.getIndexingStatus().progress ?? { current: 0, total: 0, currentFile: VAULTQUERY_DATABASE_PREPARING_MESSAGE };
  renderIndexingProgress(loadingDiv, progress);
  return loadingDiv;
}

export function checkIndexingAndWait(options: IndexingCheckOptions): IndexingCheckResult {
  const { pendingBlocks, blockInfo } = options;
  const loadingDiv = createLoadingDivUnlessReady(options.getApi(), options.container);
  if (!loadingDiv) {
    return { ready: true };
  }

  pendingBlocks.add(blockInfo);

  return { ready: false };
}
