import { App, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import { checkIndexingAndWait } from '../utils/IndexingUtils';
import { parseQueryBlock } from '../utils/QueryParsingUtils';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { QueryRenderer, RenderContext } from '../Renderers/QueryRenderer';
import { cleanupRenderedOutput } from '../Renderers/RendererCleanup';
import { createOpenFileHandler, createVaultQueryCodeBlockContainer, RenderVersionGuard } from './ProcessorUtils';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import type { PendingBlock } from '../utils/IndexingUtils';
import type { ParsedQuery, ParseQueryBlockOptions } from '../utils/QueryParsingUtils';
import { logger as rootLogger } from '../utils/logger';
import { hashString } from '../utils/StringUtils';

const logger = rootLogger.scope('QueryPerformance');

type ReadQueryOutputKind = NonNullable<ParseQueryBlockOptions['forceOutputKind']>;

export abstract class BaseReadQueryCodeBlockProcessor {
  protected pendingBlocks = new Set<PendingBlock>();
  private renderGuard = new RenderVersionGuard();
  private renderedContainers = new WeakSet<HTMLElement>();

  public constructor(protected app: App, protected plugin: VaultQueryPluginContext) {}

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
      cleanupRenderedOutput(container);
      BaseRenderer.renderQueryError(this.app, container, error, source);
    }
  }

  protected async processQueryInContainer(container: HTMLElement, parsed: ParsedQuery, ctx: MarkdownPostProcessorContext): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    const renderVersion = this.renderGuard.begin(container);

    try {
      await api.waitForInitialQueryReadiness();
      const queryHash = hashString(parsed.query);
      const isFirstRender = !this.renderedContainers.has(container);
      const queryStartedAt = performance.now();
      const results = await api.query(parsed.query, ctx.sourcePath);
      const queryMs = performance.now() - queryStartedAt;

      if (!this.renderGuard.isCurrent(container, renderVersion) || !container.isConnected) {
        return;
      }

      const renderContext: RenderContext = {
        results,
        parsed,
        container,
        app: this.app,
        openFile: createOpenFileHandler(this.app),
        MarkdownRenderer,
        pluginContext: this.plugin,
        settings: this.plugin.settings,
        sourcePath: ctx.sourcePath,
        onRefresh: async () => {
          await this.processQueryInContainer(container, parsed, ctx);
        }
      };

      const renderStartedAt = performance.now();
      await QueryRenderer.render(renderContext);
      logger.debug('Query refresh phases', {
        queryHash,
        cacheState: isFirstRender ? 'cold' : 'warm',
        rows: results.length,
        columns: results.length > 0 ? Object.keys(results[0]).length : 0,
        queryMs: Math.round(queryMs),
        renderMs: Math.round(performance.now() - renderStartedAt),
        sourcePath: ctx.sourcePath,
      });
      this.renderedContainers.add(container);
    }
    catch (error: unknown) {
      if (!this.renderGuard.isCurrent(container, renderVersion) || !container.isConnected) {
        return;
      }
      cleanupRenderedOutput(container);
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
    protected getBlockType(): string {
      return blockType;
    }

    protected getParseOptions(): ParseQueryBlockOptions {
      return { forceOutputKind: outputKind };
    }
  };
}
