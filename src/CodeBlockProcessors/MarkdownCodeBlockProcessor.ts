import { App, MarkdownPostProcessorContext, MarkdownRenderer, Component } from 'obsidian';
import { checkIndexingAndWait } from '../utils/IndexingUtils';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import VaultQueryPlugin from '../main';
import type { PendingBlock } from '../utils/IndexingUtils';

interface MarkdownConfig {
  alignment?: ('left' | 'center' | 'right')[];
}

interface ParsedMarkdownQuery {
  query: string;
  config: MarkdownConfig;
}

export class MarkdownCodeBlockProcessor {
  private pendingBlocks = new Set<PendingBlock>();

  public constructor(private app: App, private plugin: VaultQueryPlugin) {}

  public async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-container' });

    try {
      const parsed = this.parseMarkdownBlock(source);

      if (!parsed.query) {
        container.createDiv({
          cls: 'vaultquery-empty',
          text: 'No query provided. Use ```vaultquery-help``` for examples.'
        });
        return;
      }

      const blockInfo: PendingBlock = { container, source, el, ctx, type: 'vaultquery-markdown' };

      const { ready } = checkIndexingAndWait({
        getApi: () => this.plugin.api,
        container,
        pendingBlocks: this.pendingBlocks,
        blockInfo,
        onReady: () => this.processQueryInContainer(container, parsed, ctx)
      });

      if (ready) {
        await this.processQueryInContainer(container, parsed, ctx);
      }
    }

    catch (error: unknown) {
      BaseRenderer.renderQueryError(this.app, container, error, source);
    }
  }

  private parseMarkdownBlock(source: string): ParsedMarkdownQuery {
    const lines = source.split('\n');
    const configIndex = lines.findIndex(line => line.trim().toLowerCase() === 'config:');

    let query: string;
    let config: MarkdownConfig = {};

    if (configIndex === -1) {
      query = source.trim();
    }

    else {
      query = lines.slice(0, configIndex).join('\n').trim();
      const configLines = lines.slice(configIndex + 1);

      for (const line of configLines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();

        if (key === 'alignment') {
          config.alignment = value.split(',').map(a => {
            const aligned = a.trim().toLowerCase();
            if (aligned === 'center' || aligned === 'right') return aligned;
            return 'left';
          });
        }
      }
    }

    return { query, config };
  }

  private async processQueryInContainer(container: HTMLElement, parsed: ParsedMarkdownQuery, ctx: MarkdownPostProcessorContext): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    try {
      const results = await api.query(parsed.query, ctx.sourcePath);

      if (!results || !Array.isArray(results)) {
        container.createDiv({
          cls: 'vaultquery-error',
          text: `Query error: Invalid results (${typeof results})`
        });
        return;
      }

      await this.renderMarkdownOutput(container, results, parsed.config, parsed.query, ctx);
    }

    catch (error: unknown) {
      BaseRenderer.renderQueryError(this.app, container, error, parsed.query);
    }
  }

  private async renderMarkdownOutput(container: HTMLElement, results: Record<string, unknown>[], config: MarkdownConfig, query: string, ctx: MarkdownPostProcessorContext): Promise<void> {
    container.empty();

    if (results.length === 0) {
      container.createDiv({
        cls: 'vaultquery-empty',
        text: 'Query returned no results'
      });
      return;
    }

    const renderComponent = new Component();
    renderComponent.load();
    this.plugin.register(() => renderComponent.unload());

    // Create HTML table directly to support markdown rendering in cells
    const columns = Object.keys(results[0]);
    const table = container.createEl('table', { cls: 'vaultquery-markdown-table' });

    // Create header row
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    for (let i = 0; i < columns.length; i++) {
      const align = config.alignment?.[i];
      const alignClass = align === 'center' ? 'vaultquery-align-center' : align === 'right' ? 'vaultquery-align-right' : '';
      const th = headerRow.createEl('th', { cls: alignClass || undefined });
      th.textContent = columns[i];
    }

    // Create body rows with markdown-rendered content
    const tbody = table.createEl('tbody');
    for (const row of results) {
      const tr = tbody.createEl('tr');
      for (let i = 0; i < columns.length; i++) {
        const align = config.alignment?.[i];
        const alignClass = align === 'center' ? 'vaultquery-align-center' : align === 'right' ? 'vaultquery-align-right' : '';
        const td = tr.createEl('td', { cls: alignClass || undefined });
        const value = row[columns[i]];
        const content = value == null ? '' : String(value);

        if (content) {
          // Render markdown content in each cell
          await MarkdownRenderer.render(this.app, content, td, ctx.sourcePath, renderComponent);
        }
      }
    }

    const buttonContainer = container.createDiv('vaultquery-floating-buttons');
    BaseRenderer.addCopyAsMarkdownButton(buttonContainer, results);
  }

  private resultsToMarkdown(results: Record<string, unknown>[], config: MarkdownConfig): string {
    if (results.length === 0) {
      return '(no results)';
    }

    const columns = Object.keys(results[0]);
    if (columns.length === 0) {
      return '(no columns)';
    }

    const alignments = columns.map((_, index) => {
      const align = config.alignment?.[index] || 'left';
      if (align === 'center') return ':---:';
      if (align === 'right') return '---:';
      return '---';
    });

    const headerRow = '| ' + columns.join(' | ') + ' |';
    const separatorRow = '| ' + alignments.join(' | ') + ' |';
    const dataRows = results.map(row => {
      const cells = columns.map(col => {
        const value = row[col];
        const str = value == null ? '' : String(value);
        return str.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      });
      return '| ' + cells.join(' | ') + ' |';
    });

    return [headerRow, separatorRow, ...dataRows].join('\n');
  }
}
