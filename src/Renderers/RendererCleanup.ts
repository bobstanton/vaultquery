import { CalendarRenderer } from './CalendarRenderer';
import { ChartRenderer } from './ChartRenderer';
import { MarkdownTableRenderer } from './MarkdownTableRenderer';
import { SlickGridRenderer } from './SlickGridRenderer';

export function cleanupRenderedOutput(container: HTMLElement): void {
  CalendarRenderer.cleanupContainer(container);
  ChartRenderer.cleanupContainer(container);
  MarkdownTableRenderer.cleanupContainer(container);
  SlickGridRenderer.cleanupContainer(container);
  container.removeClass('vaultquery-calendar-output');
  container.removeClass('vaultquery-template-output');
}
