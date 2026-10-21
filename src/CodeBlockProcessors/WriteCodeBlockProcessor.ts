import { processQueryBlock } from './QueryBlockLifecycle';
import { App, MarkdownPostProcessorContext, MarkdownRenderChild, setIcon } from 'obsidian';
import { getErrorMessage } from '../utils/ErrorMessages';
import { createLoadingIndicator } from '../utils/IndexingUtils';
import { parseQueryBlock } from '../utils/QueryParsingUtils';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { PreviewGridRenderer } from '../Renderers/PreviewGridRenderer';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { SlickGridRenderer } from '../Renderers/SlickGridRenderer';
import { addFloatingButtons } from '../Renderers/OutputChrome';
import { createOpenFileHandler, RenderVersionGuard } from './ProcessorUtils';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import type { PreviewRenderContext } from '../Renderers/PreviewGridRenderer';
import { previewRowCount, previewTotalRowCount } from '../Services/PreviewService';
import type { PreviewResult } from '../Services/PreviewService';
import { logger as rootLogger } from '../utils/logger';
import { FilePreviewStaleError, FileWriteApplyError } from '../WriteSync/FileWriteTypes';

const logger = rootLogger.scope('WriteBlocks');

interface PreviewLifecycle {
  child: MarkdownRenderChild;
  planId: string;
}

export class WriteCodeBlockProcessor {
  private renderGuard = new RenderVersionGuard();
  private previewLifecycles = new WeakMap<HTMLElement, PreviewLifecycle>();

  public constructor(private app: App, private plugin: VaultQueryPluginContext) {}

  async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    await processQueryBlock(source, el, ctx, {
      app: this.app,
      plugin: this.plugin,
      prepare: container => {
        const parsed = parseQueryBlock(source);

        if (!parsed.query) {
          container.createDiv({
            cls: 'vaultquery-empty',
            text: 'No write query provided. Add a SQL statement to the code block.'
          });

          return;
        }

        if (!this.plugin.settings.allowWriteOperations) {
          this.renderDisabledWrite(container, parsed.query);

          return;
        }

        return parsed;
      },
      cleanup: container => SlickGridRenderer.cleanupContainer(container),
      render: (container, parsed) => this.processWriteBlockInContainer(container, parsed, ctx.sourcePath, ctx)
    });
  }

  public async processGeneratedQuery(container: HTMLElement, parsed: ParsedQuery, ctx: MarkdownPostProcessorContext): Promise<void> {
    if (!this.plugin.settings.allowWriteOperations) {
      this.renderDisabledWrite(container, parsed.query);

      return;
    }

    await this.processWriteBlockInContainer(container, parsed, ctx.sourcePath, ctx);
  }

  private renderDisabledWrite(container: HTMLElement, query: string): void {
    const warningDiv = container.createDiv({ cls: 'vaultquery-write-warning' });
    const header = warningDiv.createDiv({ cls: 'vaultquery-message-header' });
    const icon = header.createSpan({ cls: 'vaultquery-message-icon' });
    setIcon(icon, 'alert-triangle');
    header.createEl('strong', { text: 'Write operations disabled' });
    warningDiv.createEl('p', { text: 'Write operations are disabled in plugin settings. Enable them to use insert, update, and delete operations.' });

    const writeContainer = container.createDiv({ cls: 'vaultquery-write-container' });
    const queryEl = writeContainer.createDiv({ cls: 'vaultquery-write-query' });
    queryEl.createEl('h4', { text: 'Write query:' });
    BaseRenderer.renderSqlCodeBlock(this.app, queryEl, query);
  }

  private async processWriteBlockInContainer(container: HTMLElement, parsed: ParsedQuery, sourcePath?: string, ctx?: MarkdownPostProcessorContext, planNotice?: string): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    const renderVersion = this.renderGuard.begin(container);

    SlickGridRenderer.cleanupContainer(container);

    const writeContainer = container.createDiv({ cls: 'vaultquery-write-container' });

    let currentPreviewResult: PreviewResult | null = null;
    let previewContainer: HTMLElement | null = null;
    let applying = false;

    const loading = createLoadingIndicator(writeContainer, 'Generating preview...');

    try {
      currentPreviewResult = await api.previewQuery(parsed.query, [], sourcePath);
      const planId = currentPreviewResult.planId;

      if (!this.renderGuard.isCurrent(container, renderVersion)) {
        if (planId) api.discardPreview(planId);

        return;
      }

      if (!writeContainer.parentElement) {
        if (planId) api.discardPreview(planId);

        return;
      }

      if (planId && ctx) this.trackPreviewPlan(container, planId, ctx);

      previewContainer = writeContainer;

      const previewContext: PreviewRenderContext = {
        results: [],
        container: previewContainer,
        app: this.app,
        pluginContext: this.plugin,
        settings: this.plugin.settings,
        parsed: parsed,
        openFile: createOpenFileHandler(this.app),
        onApply: () => {
          if (applying) return;
          applying = true;

          const recoverStale = planId ? async () => {
            if (!this.renderGuard.isCurrent(container, renderVersion)) return;

            await this.replacePreparedPreview(container, writeContainer, planId, parsed, sourcePath, ctx,
              'The file preview changed or expired. Review this fresh preview and apply again.');
          } : undefined;

          void this.applyPreview(currentPreviewResult!, previewContainer!, recoverStale)
            .finally(() => { applying = false; });
        },
        onCancel: () => {
          if (currentPreviewResult?.planId) api.discardPreview(currentPreviewResult.planId);

          if (previewContainer) {
            SlickGridRenderer.cleanupContainer(previewContainer);
            previewContainer.remove();
            previewContainer = null;
          }

          currentPreviewResult = null;
        },
        onRefresh: async () => {
          await this.replacePreparedPreview(container, writeContainer, planId, parsed, sourcePath, ctx);
        }
      };

      PreviewGridRenderer.renderPreview(currentPreviewResult, previewContext);

      if (planNotice) {
        const notice = writeContainer.createDiv({ cls: 'vaultquery-preview-notice', text: planNotice });
        notice.setAttribute('role', 'status');
        writeContainer.prepend(notice);
      }
    }

    catch (error: unknown) {
      loading.remove();

      BaseRenderer.renderError(writeContainer, {
        title: 'Preview Error',
        message: getErrorMessage(error)
      });

      addFloatingButtons(container, {
        onRefresh: async () => {
          await this.replacePreparedPreview(container, writeContainer, undefined, parsed, sourcePath, ctx, planNotice);
        }
      });
    }
  }

  /**
   * Every refresh prepares a new plan in the same container, so one child per
   * container follows whichever plan is current instead of piling up a child
   * per preview.
   */
  private trackPreviewPlan(container: HTMLElement, planId: string, ctx: MarkdownPostProcessorContext): void {
    const existing = this.previewLifecycles.get(container);

    if (existing) {
      existing.planId = planId;

      return;
    }

    const lifecycle: PreviewLifecycle = { child: new MarkdownRenderChild(container), planId };

    lifecycle.child.register(() => {
      this.previewLifecycles.delete(container);
      if (lifecycle.planId) this.plugin.api?.discardPreview(lifecycle.planId);
    });

    this.previewLifecycles.set(container, lifecycle);
    ctx.addChild(lifecycle.child);
  }

  private async replacePreparedPreview(
    container: HTMLElement, oldPreview: HTMLElement, planId: string | undefined, parsed: ParsedQuery,
    sourcePath?: string, ctx?: MarkdownPostProcessorContext, notice?: string
  ): Promise<void> {
    if (oldPreview.parentElement !== container) return;
    if (planId) this.plugin.api?.discardPreview(planId);
    SlickGridRenderer.cleanupContainer(container);
    container.empty();
    await this.processWriteBlockInContainer(container, parsed, sourcePath, ctx, notice);
  }

  private async applyPreview(previewResult: PreviewResult, previewContainer: HTMLElement, recoverStale?: () => Promise<void>): Promise<void> {
    const api = this.plugin.api;
    let affectedPaths: string[] = [];

    try {
      const loading = createLoadingIndicator(previewContainer, 'Applying changes...');

      if (!api) {
        throw new Error('VaultQuery API is not initialized. Plugin may have been unloaded.');
      }

      const hasPendingIndexing = this.plugin.indexingStateManager.isIndexing();

      if (hasPendingIndexing) {
        loading.setText('Waiting for indexing to complete...');
      }

      await this.plugin.indexingStateManager.waitForIndexingComplete();

      affectedPaths = await api.applyPreview(previewResult);

      SlickGridRenderer.cleanupContainer(previewContainer);

      previewContainer.empty();
      const successDiv = previewContainer.createDiv({ cls: 'vaultquery-success' });

      let affectedRows = 0;
      let operationSummary = '';

      if (previewResult.op === 'multi' && previewResult.multiResults) {
        affectedRows = previewTotalRowCount(previewResult.multiResults);

        const operationCounts = new Map<string, number>();

        previewResult.multiResults.forEach(result => {
          const key = `${result.op}s on ${result.table}`;
          const rows = previewRowCount(result);
          operationCounts.set(key, (operationCounts.get(key) || 0) + rows);
        });

        const summaries = Array.from(operationCounts.entries()).map(([key, count]) => `${count} ${key}`);

        operationSummary = `Multi-statement operation: ${summaries.join(', ')}.`;
      }
      else {
        affectedRows = previewRowCount(previewResult);
        operationSummary = `${previewResult.op.toUpperCase()} operation completed on table "${previewResult.table}".`;
      }

      const header = successDiv.createDiv({ cls: 'vaultquery-message-header' });
      const icon = header.createSpan({ cls: 'vaultquery-message-icon' });
      setIcon(icon, 'check-circle');
      header.createEl('strong', {text: 'Changes applied successfully'});
      successDiv.createEl('p', {text: operationSummary});
      successDiv.createEl('p', {text: `Affected rows: ${affectedRows}`});
    }

    catch (error: unknown) {
      if (error instanceof FilePreviewStaleError && recoverStale) {
        await recoverStale();

        return;
      }

      if (error instanceof FileWriteApplyError) affectedPaths = [...error.completedPaths, ...error.unknownPaths];

      const message = error instanceof FileWriteApplyError
        ? `${error.message}\n${error.completedPaths.map(path => `Changed: ${path}`).join('\n')}\n${error.unknownPaths.map(path => `Outcome unknown: ${path}`).join('\n')}\n${error.untouchedPaths.map(path => `Unchanged: ${path}`).join('\n')}`
        : `Failed to apply changes: ${getErrorMessage(error)}`;

      logger.error('Apply preview failed', message, error);

      SlickGridRenderer.cleanupContainer(previewContainer);

      BaseRenderer.renderError(previewContainer, {
        title: error instanceof FileWriteApplyError && error.completedPaths.length ? 'Files changed with errors' : 'Apply failed',
        message
      });
    }
    finally {
      if (affectedPaths.length > 0) {
        for (const path of affectedPaths) {
          this.plugin.indexingStateManager.queueIndexing(path);
        }
      }
    }
  }

}
