import { ChartRenderer } from './ChartRenderer';
import { SlickGridRenderer } from './SlickGridRenderer';
import { TemplateRenderer } from './TemplateRenderer';
import { BaseRenderer } from './BaseRenderer';
import type { ChartContext, ChartConfig } from './ChartRenderer';
import type { RenderContext } from './BaseRenderer';

export type { RenderContext };

export class QueryRenderer {
  static render(context: RenderContext): void {
    const { parsed, onRefresh, container } = context;

    if (parsed.chart) {
      const chartContext: ChartContext = {
        results: context.results,
        container,
        config: parsed.chart as unknown as ChartConfig
      };
      ChartRenderer.renderChart(chartContext);

      this.addFloatingButtons(container, context.results, onRefresh);
      return;
    }
    
    if (parsed.template) {
      TemplateRenderer.render(
        parsed.template,
        {
          results: context.results,
          query: parsed.query,
          count: context.results.length
        },
        container,
        context.openFile
      );

      this.addFloatingButtons(container, context.results, onRefresh);
      return;
    }

    SlickGridRenderer.render(context);

    this.addFloatingButtons(container, context.results, onRefresh);
  }

  private static addFloatingButtons(container: HTMLElement, results: Record<string, unknown>[] | undefined, onRefresh: (() => Promise<void>) | undefined): void {
    const buttonContainer = container.createDiv('vaultquery-floating-buttons');

    if (results && results.length > 0) {
      BaseRenderer.addCopyAsMarkdownButton(buttonContainer, results);
    }

    if (onRefresh) {
      BaseRenderer.addRefreshButton(buttonContainer, onRefresh);
    }
  }

  static cleanup(): void {
    SlickGridRenderer.cleanup();
  }
}