import { ChartRenderer } from './ChartRenderer';
import { CalendarRenderer } from './CalendarRenderer';
import { MarkdownTableRenderer } from './MarkdownTableRenderer';
import { SlickGridRenderer } from './SlickGridRenderer';
import { JavaScriptRenderer } from './JavaScriptRenderer';
import { BaseRenderer } from './BaseRenderer';
import { QueryRefreshRegistry, resolveAutoRefreshSetting } from './QueryRefreshRegistry';
import { addFloatingButtons } from './OutputChrome';
import type { ChartContext } from './ChartRenderer';
import type { RenderContext } from './BaseRenderer';

export type { RenderContext };

export class QueryRenderer {
  static async render(context: RenderContext): Promise<void> {
    const { parsed, onRefresh, container } = context;
    const outputKind = parsed.output?.kind ?? 'table';

    container.removeClass('vaultquery-calendar-output');

    if (outputKind === 'chart') {
      this.prepareNonGridRender(context);
      const chartContext: ChartContext = {
        results: context.results,
        container,
        config: ChartRenderer.parseConfig(parsed.output?.options)
      };
      ChartRenderer.renderChart(chartContext);

      addFloatingButtons(container, { results: context.results, onRefresh });
      return;
    }

    if (outputKind === 'markdown') {
      this.prepareNonGridRender(context);
      await MarkdownTableRenderer.render(context, MarkdownTableRenderer.parseConfig(parsed.output?.options));
      return;
    }

    if (outputKind === 'calendar') {
      this.prepareNonGridRender(context);
      CalendarRenderer.render(context, CalendarRenderer.parseConfig(parsed.output?.options));
      container.addClass('vaultquery-calendar-output');
      addFloatingButtons(container, { results: context.results, onRefresh });
      return;
    }

    if (outputKind === 'template' && parsed.template) {
      SlickGridRenderer.cleanupContainer(container);
      if (!context.settings.enableJavaScriptRendering) {
        BaseRenderer.renderError(container, {
          title: 'JavaScript rendering disabled',
          message: 'Enable JavaScript rendering in VaultQuery settings before using template sections.'
        });
        return;
      }

      this.prepareNonGridRender(context);
      container.addClass('vaultquery-template-output');

      JavaScriptRenderer.render(
        parsed.template,
        {
          results: context.results,
          query: parsed.query,
          count: context.results.length
        },
        container,
        context.openFile
      );

      addFloatingButtons(container, { results: context.results, onRefresh });
      return;
    }

    SlickGridRenderer.render(context);

    addFloatingButtons(container, { results: context.results, onRefresh });
  }

  private static prepareNonGridRender(context: RenderContext): void {
    SlickGridRenderer.cleanupContainer(context.container);
    this.registerNonGridRefresh(context);
  }

  private static registerNonGridRefresh(context: RenderContext): void {
    if (!context.onRefresh) return;
    QueryRefreshRegistry.register(context.container, {
      onRefresh: context.onRefresh,
      autoRefresh: resolveAutoRefreshSetting(context.settings, context.parsed, { includeGlobalDefault: false }),
    });
  }

}
