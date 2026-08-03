import { BaseRenderer } from './BaseRenderer';

export interface FloatingButtonsOptions {
  results?: Record<string, unknown>[];
  columns?: string[];
  onRefresh?: (force?: boolean) => Promise<void>;
}

interface FloatingButtonsState {
  buttonContainer: HTMLElement;
  results: Record<string, unknown>[];
  onRefresh?: (force?: boolean) => Promise<void>;
}

const floatingControls = new WeakMap<HTMLElement, FloatingButtonsState>();

export function addFloatingButtons(container: HTMLElement, options: FloatingButtonsOptions): void {
  const existing = floatingControls.get(container);
  if (existing?.buttonContainer.isConnected && existing.buttonContainer.parentElement === container) {
    existing.results = options.results ?? [];
    existing.onRefresh = options.onRefresh;
    return;
  }

  for (const child of Array.from(container.children)) {
    if (child.classList.contains('vaultquery-floating-buttons')) {
      child.remove();
    }
  }

  const buttonContainer = container.createDiv('vaultquery-floating-buttons');
  const state: FloatingButtonsState = {
    buttonContainer,
    results: options.results ?? [],
    onRefresh: options.onRefresh,
  };
  floatingControls.set(container, state);

  if (state.results.length > 0) {
    BaseRenderer.addCopyAsMarkdownButton(buttonContainer, () => state.results, options.columns);
  }

  if (options.onRefresh) {
    BaseRenderer.addRefreshButton(buttonContainer, async force => {
      await state.onRefresh?.(force);
    });
  }
}
