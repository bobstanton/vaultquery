import { cleanupRenderedOutput } from '../Renderers/RendererCleanup';

export function createVaultQueryCodeBlockContainer(el: HTMLElement): HTMLElement | null {
  if (el.closest('.display-only')) {
    return null;
  }

  cleanupRenderedOutput(el);
  el.empty();
  return el.createDiv({ cls: 'vaultquery-container' });
}
