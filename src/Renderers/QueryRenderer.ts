import { ChartRenderer } from './ChartRenderer';
import { PeleChartRenderer } from './PeleChartRenderer';
import { CalendarRenderer } from './CalendarRenderer';
import { MarkdownTableRenderer } from './MarkdownTableRenderer';
import { SlickGridRenderer } from './SlickGridRenderer';
import { JavaScriptRenderer } from './JavaScriptRenderer';
import { BaseRenderer } from './BaseRenderer';
import { registerQueryRefresh } from './QueryRefreshRegistry';
import { addFloatingButtons } from './OutputChrome';
import { exportNameFor } from './ExportMenu';
import type { ChartContext } from './ChartRenderer';
import type { RenderContext } from './BaseRenderer';

export type { RenderContext };

export class QueryRenderer {
  static async render(context: RenderContext): Promise<void> {
    const { parsed, container } = context;
    const outputKind = parsed.output?.kind ?? 'table';

    PeleChartRenderer.cleanupContainer(container);

    container.removeClass('vaultquery-calendar-output');

    if (outputKind === 'chart') {
      this.prepareNonGridRender(context);
      ChartRenderer.cleanupContainer(container);

      const chartContext: ChartContext = {
        results: context.results,
        container,
        config: ChartRenderer.parseConfig(parsed.output?.options)
      };

      if (chartContext.config.renderer === 'pele') {
        if (!await PeleChartRenderer.render(context, chartContext.config)) return;
      }
      else {
        ChartRenderer.renderChart(chartContext);
      }

      const readMermaid = chartContext.config.renderer === 'pele' && context.results.length > 0
        ? () => PeleChartRenderer.getSource(container) : undefined;
      this.addOutputButtons(context, readMermaid);

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
      this.addOutputButtons(context);

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

      this.addOutputButtons(context);

      return;
    }

    SlickGridRenderer.render(context);

    this.addOutputButtons(context);
  }

  private static addOutputButtons(context: RenderContext, readMermaid?: () => string | undefined): void {
    addFloatingButtons(context.container, { results: context.readResults ?? context.results,
      columns: context.readColumns ?? context.dataFileColumns, dataFileColumns: context.dataFileColumns,
      app: context.app, exportFolder: context.settings.exportFolder, exportName: exportNameFor(context),
      onRefresh: context.onRefresh, readMermaid });
  }

  private static prepareNonGridRender(context: RenderContext): void {
    SlickGridRenderer.cleanupContainer(context.container);
    registerQueryRefresh(context, false);
  }

}
