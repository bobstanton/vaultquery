import { CalendarRenderer } from './CalendarRenderer';
import { SlickGridRenderer } from './SlickGridRenderer';

export function cleanupRenderedOutput(container: HTMLElement): void {
  CalendarRenderer.cleanupContainer(container);
  SlickGridRenderer.cleanupContainer(container);
  container.removeClass('vaultquery-calendar-output');
  container.removeClass('vaultquery-template-output');
}
