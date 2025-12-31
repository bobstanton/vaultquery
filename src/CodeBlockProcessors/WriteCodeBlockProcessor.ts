import { App, MarkdownPostProcessorContext, TFile, normalizePath, setIcon } from 'obsidian';
import { VaultQuerySettings } from '../Settings/Settings';
import { getErrorMessage } from '../utils/ErrorMessages';
import { checkIndexingAndWait, createLoadingIndicator } from '../utils/IndexingUtils';
import { parseQueryBlock } from '../utils/QueryParsingUtils';
import VaultQueryPlugin from '../main';
import { PreviewGridRenderer } from '../Renderers/PreviewGridRenderer';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { SlickGridRenderer } from '../Renderers/SlickGridRenderer';
import type { PendingBlock } from '../utils/IndexingUtils';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import type { PreviewRenderContext } from '../Renderers/PreviewGridRenderer';
import type { PreviewResult } from '../Services/PreviewService';

export class WriteCodeBlockProcessor {
  private pendingBlocks = new Set<PendingBlock>();
  private activeRequests = new WeakMap<HTMLElement, number>();

  public constructor(private app: App, private plugin: VaultQueryPlugin, private settings: VaultQuerySettings) {}

  async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-container' });

    try {
      const parsed = parseQueryBlock(source);

      if (!parsed.query) {
        container.createDiv({
          cls: 'vaultquery-empty',
          text: 'No write query provided. Add a SQL statement to the code block.'
        });
        return;
      }

      if (!this.settings.allowWriteOperations) {
        const warningDiv = container.createDiv({ cls: 'vaultquery-write-warning' });
        const header = warningDiv.createDiv({ cls: 'vaultquery-message-header' });
        const icon = header.createSpan({ cls: 'vaultquery-message-icon' });
        setIcon(icon, 'alert-triangle');
        header.createEl('strong', { text: 'Write operations disabled' });
        warningDiv.createEl('p', { text: 'Write operations are disabled in plugin settings. Enable them to use insert, update, and delete operations.' });

        const writeContainer = container.createDiv({ cls: 'vaultquery-write-container' });
        const queryEl = writeContainer.createDiv({ cls: 'vaultquery-write-query' });
        queryEl.createEl('h4', { text: 'Write query:' });
        BaseRenderer.renderSqlCodeBlock(this.app, queryEl, parsed.query);
        return;
      }

      const blockInfo: PendingBlock = { container, source, el, ctx, type: 'vaultquery-write' };

      const { ready } = checkIndexingAndWait({
        getApi: () => this.plugin.api,
        container,
        pendingBlocks: this.pendingBlocks,
        blockInfo,
        onReady: () => this.processWriteBlockInContainer(container, parsed, ctx.sourcePath)
      });

      if (ready) {
        await this.processWriteBlockInContainer(container, parsed, ctx.sourcePath);
      }
    }
    catch (error: unknown) {
      BaseRenderer.renderQueryError(this.app, container, error, source);
    }
  }

  private async processWriteBlockInContainer(container: HTMLElement, parsed: ParsedQuery, sourcePath?: string): Promise<void> {
    const api = this.plugin.api;
    if (!api) return;

    const requestId = Date.now() + Math.random();
    this.activeRequests.set(container, requestId);

    container.empty();

    const writeContainer = container.createDiv({ cls: 'vaultquery-write-container' });

    let currentPreviewResult: PreviewResult | null = null;
    let previewContainer: HTMLElement | null = null;

    const loading = createLoadingIndicator(writeContainer, 'Generating preview...');

    try {
      currentPreviewResult = await api.previewQuery(parsed.query, [], sourcePath);

      if (this.activeRequests.get(container) !== requestId) {
        return;
      }

      if (!writeContainer.parentElement) {
        return;
      }

      previewContainer = writeContainer;

      const previewContext: PreviewRenderContext = {
        results: [],
        container: previewContainer,
        app: this.app,
        pluginContext: this.plugin,
        settings: this.settings,
        parsed: parsed,
        openFile: (path: string) => {
          const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
          if (file instanceof TFile) {
            void this.app.workspace.getLeaf().openFile(file);
          }
        },
        onApply: async () => {
          await this.applyPreview(currentPreviewResult!, previewContainer!, parsed, sourcePath);
        },
        onCancel: () => {
          if (previewContainer) {
            previewContainer.remove();
            previewContainer = null;
          }
          currentPreviewResult = null;
        },
        onRefresh: async () => {
          await this.refreshWritePreview(writeContainer, parsed, sourcePath);
        }
      };

      PreviewGridRenderer.renderPreview(currentPreviewResult, previewContext);

    }

    catch (error: unknown) {
      loading.remove();

      const errorMsg = getErrorMessage(error);
      const isSyntaxError = errorMsg.includes('syntax error') ||
                            errorMsg.includes('incomplete input') ||
                            errorMsg.includes('no such column') ||
                            errorMsg.includes('no such table');

      if (isSyntaxError) {
        const syntaxErrorDiv = writeContainer.createDiv({ cls: 'vaultquery-error' });
        syntaxErrorDiv.textContent = errorMsg;
        return;
      }

      const errorContainer = writeContainer.createDiv({ cls: 'vaultquery-error' });
      errorContainer.textContent = errorMsg;

      const buttonContainer = container.createDiv('vaultquery-floating-buttons');
      BaseRenderer.addRefreshButton(buttonContainer, async () => {
        await this.refreshWritePreview(writeContainer, parsed, sourcePath);
      });
    }
  }

  private async applyPreview(previewResult: PreviewResult, previewContainer: HTMLElement, parsed?: ParsedQuery, sourcePath?: string): Promise<void> {
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

      let freshPreviewResult = previewResult;
      if (parsed?.query) {
        if (hasPendingIndexing) {
          loading.setText('Regenerating preview...');
        }
        freshPreviewResult = await api.previewQuery(parsed.query, [], sourcePath);
      }
      affectedPaths = await api.applyPreview(freshPreviewResult);

      if (previewContainer.id) {
        SlickGridRenderer.unregisterRefreshCallback(previewContainer.id);
      }

      previewContainer.empty();
      const successDiv = previewContainer.createDiv({ cls: 'vaultquery-success' });

      let affectedRows = 0;
      let operationSummary = '';

      if (freshPreviewResult.op === 'multi' && freshPreviewResult.multiResults) {
        affectedRows = freshPreviewResult.multiResults.reduce((total, result) =>
          total + Math.max(result.before.length, result.after.length), 0);

        const operationCounts = new Map<string, number>();
        freshPreviewResult.multiResults.forEach(result => {
          const key = `${result.op}s on ${result.table}`;
          const rows = Math.max(result.before.length, result.after.length);
          operationCounts.set(key, (operationCounts.get(key) || 0) + rows);
        });

        const summaries = Array.from(operationCounts.entries()).map(([key, count]) =>
          `${count} ${key}`);
        operationSummary = `Multi-statement operation: ${summaries.join(', ')}.`;
      }
      else {
        affectedRows = Math.max(freshPreviewResult.before.length, freshPreviewResult.after.length);
        operationSummary = `${freshPreviewResult.op.toUpperCase()} operation completed on table "${freshPreviewResult.table}".`;
      }

      const header = successDiv.createDiv({ cls: 'vaultquery-message-header' });
      const icon = header.createSpan({ cls: 'vaultquery-message-icon' });
      setIcon(icon, 'check-circle');
      header.createEl('strong', {text: 'Changes applied successfully'});
      successDiv.createEl('p', {text: operationSummary});
      successDiv.createEl('p', {text: `Affected rows: ${affectedRows}`});

    }

    catch (error: unknown) {
      console.error('[VaultQuery] Apply preview failed:', error);

      previewContainer.empty();
      const errorDiv = previewContainer.createDiv({ cls: 'vaultquery-error' });
      const header = errorDiv.createDiv({ cls: 'vaultquery-message-header' });
      const icon = header.createSpan({ cls: 'vaultquery-message-icon' });
      setIcon(icon, 'x-circle');
      header.createEl('strong', {text: 'Apply failed'});
      errorDiv.createEl('p', {text: `Failed to apply changes: ${getErrorMessage(error)}`});
    }
    finally {
      if (affectedPaths.length > 0) {
        for (const path of affectedPaths) {
          this.plugin.indexingStateManager.queueIndexing(path);
        }
      }
    }
  }

  private async refreshWritePreview(writeContainer: HTMLElement, parsed: ParsedQuery, sourcePath?: string): Promise<void> {
    try {
      const parentContainer = writeContainer.parentElement;
      if (!parentContainer || !parentContainer.hasClass('vaultquery-container')) {
        throw new Error('Could not find parent container for refresh');
      }

      parentContainer.empty();
      await this.processWriteBlockInContainer(parentContainer, parsed, sourcePath);
    }
    catch (error: unknown) {
      const parentContainer = writeContainer.parentElement;

      writeContainer.empty();
      const errorContainer = writeContainer.createDiv({ cls: 'vaultquery-error' });
      errorContainer.textContent = getErrorMessage(error);

      if (parentContainer && parentContainer.hasClass('vaultquery-container')) {
        const buttonContainer = parentContainer.createDiv('vaultquery-floating-buttons');
        BaseRenderer.addRefreshButton(buttonContainer, async () => {
          await this.refreshWritePreview(writeContainer, parsed, sourcePath);
        });
      }
    }
  }

  getPendingBlocks(): Set<PendingBlock> {
    return this.pendingBlocks;
  }

  clearPendingBlocks(): void {
    this.pendingBlocks.clear();
  }
}
