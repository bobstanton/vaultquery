import { App, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import { checkIndexingAndWait } from '../utils/IndexingUtils';
import { parseQueryBlock } from '../utils/QueryParsingUtils';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { QueryRenderer, RenderContext } from '../Renderers/QueryRenderer';
import { createVaultQueryCodeBlockContainer } from './ProcessorUtils';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import type { PendingBlock } from '../utils/IndexingUtils';
import type { ParsedQuery, ParseQueryBlockOptions } from '../utils/QueryParsingUtils';

type ReadQueryOutputKind = NonNullable<ParseQueryBlockOptions['forceOutputKind']>;

export abstract class BaseReadQueryCodeBlockProcessor {
  protected pendingBlocks = new Set<PendingBlock>();
  private activeRequests = new WeakMap<HTMLElement, number>();

  protected constructor(protected app: App, protected plugin: VaultQueryPluginContext) {}

  protected abstract getBlockType(): string;

  protected getParseOptions(): ParseQueryBlockOptions {
    return {};
  }

  protected validateParsedQuery(_container: HTMLElement, _parsed: ParsedQuery): boolean {
    return true;
  }

  public async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const container = createVaultQueryCodeBlockContainer(el);
    if (!container) {
      return;
    }

    try {
      const parsed = parseQueryBlock(source, this.getParseOptions());

      if (!parsed.query) {
        container.createDiv({
          cls: 'vaultquery-empty',
          text: 'No query provided. Use ```vaultquery-help``` for examples.'
        });
        return;
      }

      if (!this.validateParsedQuery(container, parsed)) {
        return;
      }

      const blockInfo: PendingBlock = { container, source, el, ctx, type: this.getBlockType() };

      const { ready } = checkIndexingAndWait({
        getApi: () => this.plugin.api,
        container,
        pendingBlocks: this.pendingBlocks,
        blockInfo
      });

      if (ready) {
        await this.processQueryInContainer(container, parsed, ctx);
      }
    }
    catch (error: unknown) {
      QueryRenderer.resetContainer(container);
      BaseRenderer.renderQueryError(this.app, container, error, source);
    }
  }

  protected async processQueryInContainer(container: HTMLElement, parsed: ParsedQuery, ctx: MarkdownPostProcessorContext): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    const requestId = Date.now() + Math.random();
    this.activeRequests.set(container, requestId);

    try {
      const results = await api.query(parsed.query, ctx.sourcePath);

      if (this.activeRequests.get(container) !== requestId || !container.isConnected) {
        return;
      }

      if (!results || !Array.isArray(results)) {
        BaseRenderer.renderError(container, {
          title: 'Query Error',
          message: `Invalid results (${typeof results})`
        });
        return;
      }

      const renderContext: RenderContext = {
        results,
        parsed,
        container,
        app: this.app,
        openFile: (path: string) => { void this.app.workspace.openLinkText(path, ''); },
        MarkdownRenderer,
        pluginContext: this.plugin,
        settings: this.plugin.settings,
        sourcePath: ctx.sourcePath,
        onRefresh: async () => {
          await this.processQueryInContainer(container, parsed, ctx);
        }
      };

      await QueryRenderer.render(renderContext);
    }
    catch (error: unknown) {
      if (this.activeRequests.get(container) !== requestId || !container.isConnected) {
        return;
      }
      QueryRenderer.resetContainer(container);
      BaseRenderer.renderQueryError(this.app, container, error, parsed.query);
    }
  }

  public getPendingBlocks(): Set<PendingBlock> {
    return this.pendingBlocks;
  }

  public clearPendingBlocks(): void {
    this.pendingBlocks.clear();
  }
}

export function createForcedOutputProcessor(blockType: string, outputKind: ReadQueryOutputKind) {
  return class ForcedOutputCodeBlockProcessor extends BaseReadQueryCodeBlockProcessor {
    public constructor(app: App, plugin: VaultQueryPluginContext) {
      super(app, plugin);
    }

    protected getBlockType(): string {
      return blockType;
    }

    protected getParseOptions(): ParseQueryBlockOptions {
      return { forceOutputKind: outputKind };
    }
  };
}
