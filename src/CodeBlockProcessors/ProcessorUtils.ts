import { CalendarRenderer } from '../Renderers/CalendarRenderer';
import { SlickGridRenderer } from '../Renderers/SlickGridRenderer';

export function createVaultQueryCodeBlockContainer(el: HTMLElement): HTMLElement | null {
  if (el.closest('.display-only')) {
    return null;
  }

  SlickGridRenderer.cleanupContainer(el);
  CalendarRenderer.cleanupContainer(el);
  el.empty();
  return el.createDiv({ cls: 'vaultquery-container' });
}
