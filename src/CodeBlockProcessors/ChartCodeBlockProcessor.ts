import { App, MarkdownPostProcessorContext } from 'obsidian';
import { checkIndexingAndWait } from '../utils/IndexingUtils';
import { parseConfigSection } from '../utils/QueryParsingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';
import VaultQueryPlugin from '../main';
import { ChartRenderer } from '../Renderers/ChartRenderer';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import type { PendingBlock } from '../utils/IndexingUtils';
import type { ChartConfig } from '../Renderers/ChartRenderer';

interface ParsedChartBlock {
  query: string;
  config: ChartConfig;
}

export class ChartCodeBlockProcessor {
  private pendingBlocks = new Set<PendingBlock>();

  public constructor(private app: App, private plugin: VaultQueryPlugin) {}

  async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-container' });

    try {
      const blockInfo: PendingBlock = { container, source, el, ctx, type: 'vaultquery-chart' };

      const { ready } = checkIndexingAndWait({
        getApi: () => this.plugin.api,
        container,
        pendingBlocks: this.pendingBlocks,
        blockInfo,
        onReady: () => this.processChartBlock(source, container, ctx)
      });

      if (ready) {
        await this.processChartBlock(source, container, ctx);
      }
    }
    catch (error: unknown) {
      BaseRenderer.renderQueryError(this.app, container, error, source);
    }
  }

  private async processChartBlock(source: string, container: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    try {
      const parsed = this.parseChartBlock(source);
      await this.executeChart(container, parsed, source, ctx);
    }
    catch (error: unknown) {
      container.createDiv({
        cls: 'vaultquery-error',
        text: getErrorMessage(error) || 'Unknown error occurred'
      });
    }
  }

  private async executeChart(container: HTMLElement, parsed: ParsedChartBlock, source: string, ctx: MarkdownPostProcessorContext): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    const results = await api.query(parsed.query, ctx.sourcePath);

    if (!results || !Array.isArray(results) || results.length === 0) {
      container.createDiv({
        cls: 'vaultquery-empty',
        text: 'No results to display'
      });
      return;
    }

    ChartRenderer.renderChart({ results, container, config: parsed.config });

    const buttonContainer = container.createDiv({ cls: 'vaultquery-floating-buttons' });
    BaseRenderer.addRefreshButton(buttonContainer, async () => {
      container.empty();
      await this.executeChart(container, parsed, source, ctx);
    });
  }

  private parseChartBlock(source: string): ParsedChartBlock {
    const content = source.trim();
    const semicolonIndex = content.indexOf(';');

    if (semicolonIndex === -1) {
      throw new Error('SQL query must end with semicolon (;) followed by config section');
    }

    const query = content.substring(0, semicolonIndex).trim();
    const configSection = content.substring(semicolonIndex + 1).trim();

    if (!configSection.startsWith('config:')) {
      throw new Error('Config section required. Example: config:\\ntype: bar');
    }

    const config = this.parseConfig(configSection.substring(7).trim());

    if (!config.type) {
      throw new Error('Chart type required. Add "type: bar" (or line, pie, doughnut, scatter)');
    }

    return { query, config };
  }

  private parseConfig(configText: string): ChartConfig {
    const parsed = parseConfigSection(configText);
    const config: Partial<ChartConfig> = {};

    if (parsed.type && ['bar', 'line', 'pie', 'doughnut', 'scatter'].includes(parsed.type)) {
      config.type = parsed.type as ChartConfig['type'];
    }
    if (parsed.title) config.title = parsed.title;
    if (parsed.xlabel) config.xLabel = parsed.xlabel;
    if (parsed.ylabel) config.yLabel = parsed.ylabel;
    if (parsed.datasetlabel) config.datasetLabel = parsed.datasetlabel;
    if (parsed.datasetbackgroundcolor) config.datasetBackgroundColor = parsed.datasetbackgroundcolor;
    if (parsed.datasetbordercolor) config.datasetBorderColor = parsed.datasetbordercolor;

    return config as ChartConfig;
  }

  getPendingBlocks(): Set<PendingBlock> {
    return this.pendingBlocks;
  }

  clearPendingBlocks(): void {
    this.pendingBlocks.clear();
  }
}
