import type { IndexingProgress } from '../types';

export const VAULTQUERY_DATABASE_PREPARING_MESSAGE = 'Preparing VaultQuery database...';

export function createLoadingIndicator(container: HTMLElement, initialText: string = 'Loading...'): { setText: (text: string) => void; remove: () => void; } {
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
