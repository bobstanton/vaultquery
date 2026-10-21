import { processQueryBlock } from './QueryBlockLifecycle';
import { App, MarkdownPostProcessorContext, MarkdownRenderer } from 'obsidian';
import { parseQueryBlock } from '../utils/QueryParsingUtils';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { QueryRenderer, RenderContext } from '../Renderers/QueryRenderer';
import { cleanupRenderedOutput } from '../Renderers/RendererCleanup';
import { createOpenFileHandler, RenderVersionGuard } from './ProcessorUtils';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import type { ParsedQuery, ParseQueryBlockOptions } from '../utils/QueryParsingUtils';
import { logger as rootLogger } from '../utils/logger';
import { hashString } from '../utils/StringUtils';
import { waitForConnected } from '../utils/DomAttachment';
import { QueryRefreshRegistry } from '../Renderers/QueryRefreshRegistry';
import type { VaultQueryAPI, QueryResult } from '../VaultQueryAPI';
import { ProviderSnapshotUnavailableError } from '../Providers/ProviderSnapshotUnavailableError';
import { isProviderTableArriving, renderProviderFreshness, renderProviderWaiting } from '../Renderers/ProviderStatusNotice';
import type { ProviderWaitingHandle } from '../Renderers/ProviderStatusNotice';

const logger = rootLogger.scope('QueryPerformance');

type ReadQueryOutputKind = NonNullable<ParseQueryBlockOptions['forceOutputKind']>;

const inFlightQueries = new Map<string, { revision: number; rows: Promise<QueryResult[]> }>();

export abstract class BaseReadQueryCodeBlockProcessor {
  private renderGuard = new RenderVersionGuard();
  private renderedContainers = new WeakSet<HTMLElement>();

  public constructor(protected app: App, protected plugin: VaultQueryPluginContext) {}

  protected getParseOptions(): ParseQueryBlockOptions {
    return {};
  }

  protected validateParsedQuery(_container: HTMLElement, _parsed: ParsedQuery): boolean {
    return true;
  }

  protected afterRender(_container: HTMLElement): void {
    return;
  }

  protected executeQuery(api: VaultQueryAPI, query: string, sourcePath: string): Promise<QueryResult[]> {
    const key = `${sourcePath}\u0000${query}`;
    const revision = QueryRefreshRegistry.dataRevision();
    const shared = inFlightQueries.get(key);
    if (shared && shared.revision === revision) return shared.rows;

    const rows = api.query(query, sourcePath);
    inFlightQueries.set(key, { revision, rows });
    const release = (): void => { if (inFlightQueries.get(key)?.rows === rows) inFlightQueries.delete(key); };
    rows.then(release, release);

    return rows;
  }

  public async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    await processQueryBlock(source, el, ctx, {
      app: this.app,
      plugin: this.plugin,
      prepare: container => {
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

        return parsed;
      },
      render: (container, parsed) => this.processQueryInContainer(container, parsed, ctx)
    });
  }

  private readonly waitStartedAt = new WeakMap<HTMLElement, number>();
  private readonly waiting = new WeakMap<HTMLElement, ProviderWaitingHandle>();

  protected async processQueryInContainer(container: HTMLElement, parsed: ParsedQuery, ctx: MarkdownPostProcessorContext): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    const renderVersion = this.renderGuard.begin(container);

    try {
      await api.waitForInitialQueryReadiness();
      if (!await waitForConnected(container, () => this.renderGuard.isCurrent(container, renderVersion))) return;
      const queryHash = hashString(parsed.query);
      const isFirstRender = !this.renderedContainers.has(container);
      const queryStartedAt = performance.now();
      const results = await this.executeQuery(api, parsed.query, ctx.sourcePath);
      const dataFileColumns = await api.getDataFileColumnNames(results);
      const queryMs = performance.now() - queryStartedAt;

      if (!this.renderGuard.isCurrent(container, renderVersion)) {
        return;
      }

      const renderContext: RenderContext = {
        results,
        dataFileColumns,
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
      this.stopWaiting(container);
      this.waitStartedAt.delete(container);

      try {
        renderProviderFreshness(container, await api.getQueryProviderStatus(parsed.query));
      }
      catch (error) {
        logger.debug('Provider freshness is unavailable', error);
      }

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
      this.afterRender(container);
    }
    catch (error: unknown) {
      if (!this.renderGuard.isCurrent(container, renderVersion)) {
        return;
      }

      cleanupRenderedOutput(container);
      this.stopWaiting(container);

      if (error instanceof ProviderSnapshotUnavailableError) {
        if (!await this.showProviderWaiting(container, error)) {
          BaseRenderer.renderQueryError(this.app, container, error, parsed.query);
        }

        QueryRefreshRegistry.register(container, {
          onRefresh: () => this.processQueryInContainer(container, parsed, ctx),
          autoRefresh: true,
        });

        return;
      }

      this.waitStartedAt.delete(container);
      BaseRenderer.renderQueryError(this.app, container, error, parsed.query);
    }
  }

  private async showProviderWaiting(container: HTMLElement, error: ProviderSnapshotUnavailableError): Promise<boolean> {
    const api = this.plugin.api;
    if (!api || !error.tableName) return false;
    const startedAt = this.waitStartedAt.get(container) ?? Date.now();

    try {
      const statuses = await api.getTableProviderStatus();
      const key = error.tableName.toLowerCase();
      const status = statuses.find(candidate => candidate.tableName.toLowerCase() === key);
      if (!isProviderTableArriving(status, Date.now() - startedAt)) return false;
      this.waitStartedAt.set(container, startedAt);
      this.waiting.set(container, renderProviderWaiting(container, status!, startedAt));

      return true;
    }
    catch (statusError) {
      logger.debug('Provider status is unavailable while waiting', statusError);

      return false;
    }
  }

  private stopWaiting(container: HTMLElement): void {
    this.waiting.get(container)?.stop();
    this.waiting.delete(container);
  }

}

export function createForcedOutputProcessor(outputKind: ReadQueryOutputKind) {
  return class ForcedOutputCodeBlockProcessor extends BaseReadQueryCodeBlockProcessor {
    protected getParseOptions(): ParseQueryBlockOptions {
      return { forceOutputKind: outputKind };
    }
  };
}
