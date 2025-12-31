import { App, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import { checkIndexingAndWait } from '../utils/IndexingUtils';
import { parseQueryBlock } from '../utils/QueryParsingUtils';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { QueryRenderer, RenderContext } from '../Renderers/QueryRenderer';
import { getErrorMessage } from '../utils/ErrorMessages';
import VaultQueryPlugin from '../main';
import type { PendingBlock } from '../utils/IndexingUtils';
import type { ParsedQuery } from '../utils/QueryParsingUtils';

export class QueryCodeBlockProcessor {
  private pendingBlocks = new Set<PendingBlock>();

  public constructor(private app: App, private plugin: VaultQueryPlugin) {}

  public async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-container' });

    try {
      const parsed = parseQueryBlock(source);

      if (!parsed.query) {
        container.createDiv({
          cls: 'vaultquery-empty',
          text: 'No query provided. Use ```vaultquery-help``` for examples.'
        });
        return;
      }

      const blockInfo: PendingBlock = { container, source, el, ctx, type: 'vaultquery' };

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

  private async processQueryInContainer(container: HTMLElement, parsed: ParsedQuery, ctx: MarkdownPostProcessorContext): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    try {
      if (this.containsWriteOperations(parsed.query)) {
        container.createDiv({
          cls: 'vaultquery-error',
          text: 'Write operations (INSERT, UPDATE, DELETE) are not allowed in regular vaultquery blocks. Use vaultquery-write blocks for write operations.'
        });
        return;
      }

      const results = await api.query(parsed.query, ctx.sourcePath);

      if (!results || !Array.isArray(results)) {
        console.error('VaultQuery: Invalid results from query:', typeof results, results);
        container.createDiv({
          cls: 'vaultquery-error',
          text: `Query error: Invalid results (${typeof results})`
        });
        return;
      }

      this.renderWithTemplate(container, results, parsed, ctx.sourcePath);
    }
    catch (error: unknown) {
      BaseRenderer.renderQueryError(this.app, container, error, parsed.query);
    }
  }

  private renderWithTemplate(container: HTMLElement, results: Record<string, unknown>[], parsed: ParsedQuery, sourcePath?: string): void {
    const renderContext: RenderContext = {
      results,
      parsed,
      container,
      app: this.app,
      openFile: (path: string) => this.app.workspace.openLinkText(path, ''),
      MarkdownRenderer,
      pluginContext: this.plugin,
      settings: this.plugin.settings,
      sourcePath,
      onRefresh: async () => {
        await this.refreshQuery(container, parsed, sourcePath);
      }
    };

    QueryRenderer.render(renderContext);
  }

  private async refreshQuery(container: HTMLElement, parsed: ParsedQuery, sourcePath?: string): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    try {
      container.empty();
      const results = await api.query(parsed.query, sourcePath);

      const renderContext: RenderContext = {
        results,
        parsed,
        container,
        app: this.app,
        openFile: (path: string) => this.app.workspace.openLinkText(path, ''),
        MarkdownRenderer,
        pluginContext: this.plugin,
        settings: this.plugin.settings,
        sourcePath,
        onRefresh: async () => {
          await this.refreshQuery(container, parsed, sourcePath);
        }
      };

      QueryRenderer.render(renderContext);
    }
    catch (error: unknown) {
      container.createDiv({
        cls: 'vaultquery-error',
        text: `Query error: ${getErrorMessage(error) || 'Unknown error occurred'}`
      });
    }
  }

  private containsWriteOperations(query: string): boolean {
    const upperQuery = query.toUpperCase().trim();
    const writeOperations = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER'];
    
    return writeOperations.some(op => {
      const regex = new RegExp(`\\b${op}\\b`, 'i');
      return regex.test(upperQuery);
    });
  }

  public getPendingBlocks(): Set<PendingBlock> {
    return this.pendingBlocks;
  }

  public clearPendingBlocks(): void {
    this.pendingBlocks.clear();
  }
}
