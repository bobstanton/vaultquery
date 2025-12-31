import { Plugin, loadPrism } from 'obsidian';
import { VaultQueryAPI } from './VaultQueryAPI';
import { VaultQuerySettings, DEFAULT_SETTINGS, validateSettings } from './Settings/Settings';
import { VaultQuerySettingTab } from './Settings/SettingsTab';
import { SlickGridRenderer } from './Renderers/SlickGridRenderer';
import { IndexingStateManager } from './Managers/IndexingStateManager';
import { QueryCodeBlockProcessor } from './CodeBlockProcessors/QueryCodeBlockProcessor';
import { WriteCodeBlockProcessor } from './CodeBlockProcessors/WriteCodeBlockProcessor';
import { ChartCodeBlockProcessor } from './CodeBlockProcessors/ChartCodeBlockProcessor';
import { HelpCodeBlockProcessor } from './CodeBlockProcessors/HelpCodeBlockProcessor';
import { SchemaCodeBlockProcessor } from './CodeBlockProcessors/SchemaCodeBlockProcessor';
import { MarkdownCodeBlockProcessor } from './CodeBlockProcessors/MarkdownCodeBlockProcessor';
import { ViewCodeBlockProcessor } from './CodeBlockProcessors/ViewCodeBlockProcessor';
import { FunctionCodeBlockProcessor } from './CodeBlockProcessors/FunctionCodeBlockProcessor';
import { FunctionHelpCodeBlockProcessor } from './CodeBlockProcessors/FunctionHelpCodeBlockProcessor';
import { ExamplesCodeBlockProcessor } from './CodeBlockProcessors/ExamplesCodeBlockProcessor';
import { ApiGuideCodeBlockProcessor } from './CodeBlockProcessors/ApiGuideCodeBlockProcessor';
import { sqlHighlightPlugin, disableAutoPairInVaultquery } from './Editor/SqlHighlightExtension';
import { createInlineButtonExtension, processReadingViewInlineButtons } from './Editor/InlineButtonExtension';
import { renderIndexingProgress } from './utils/IndexingUtils';
import { SQL_HIGHLIGHTED_LANGUAGES, JS_HIGHLIGHTED_LANGUAGES } from './Constants/EditorConstants';
import type { IndexingStatus } from './types';
import type { BlockProcessor } from './utils/IndexingUtils';

import './styles.css';
import './slickgrid-obsidian-theme.css';

declare const activeWindow: Window;

export default class VaultQueryPlugin extends Plugin {
  public api: VaultQueryAPI;
  public settings: VaultQuerySettings;
  public indexingStateManager: IndexingStateManager;
  private queryBlockProcessor: QueryCodeBlockProcessor;
  private writeBlockProcessor: WriteCodeBlockProcessor;
  private chartBlockProcessor: ChartCodeBlockProcessor;
  private helpBlockProcessor: HelpCodeBlockProcessor;
  private schemaBlockProcessor: SchemaCodeBlockProcessor;
  private markdownBlockProcessor: MarkdownCodeBlockProcessor;
  private viewBlockProcessor: ViewCodeBlockProcessor;
  private functionBlockProcessor: FunctionCodeBlockProcessor;
  private functionHelpCodeBlockProcessor: FunctionHelpCodeBlockProcessor;
  private examplesBlockProcessor: ExamplesCodeBlockProcessor;
  private apiGuideBlockProcessor: ApiGuideCodeBlockProcessor;
  private progressUpdateInterval: number | null = null;
  private gridRestoreInterval: number | null = null;
  private scrollHandler: (() => void) | null = null;

  public async loadSettings() {
    const savedData = await this.loadData() || {};

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...savedData,
      enabledFeatures: {
        ...DEFAULT_SETTINGS.enabledFeatures,
        ...(savedData.enabledFeatures || {})
      },
      wasm: {
        ...DEFAULT_SETTINGS.wasm,
        ...(savedData.wasm || {})
      }
    };

    validateSettings(this.settings);
  }

  public async saveSettings() {
    validateSettings(this.settings);
    await this.saveData(this.settings);
  }

  private registerPrismLanguages(): void {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises, @typescript-eslint/no-explicit-any -- Fire-and-forget Prism registration
    loadPrism().then((Prism: any) => {

      if (Prism.languages['sql']) {
        for (const lang of SQL_HIGHLIGHTED_LANGUAGES) {
          Prism.languages[lang] = Prism.languages['sql'];
        }
      }

      if (Prism.languages['javascript']) {
        for (const lang of JS_HIGHLIGHTED_LANGUAGES) {
          Prism.languages[lang] = Prism.languages['javascript'];
        }
      }
    });
  }

  public async onload(): Promise<void> {
    try {
      await this.loadSettings();

      this.registerEditorExtension(sqlHighlightPlugin);
      this.registerEditorExtension(disableAutoPairInVaultquery);
      this.registerEditorExtension(createInlineButtonExtension(this));

      this.registerPrismLanguages();

      this.addSettingTab(new VaultQuerySettingTab(this.app, this));

      this.indexingStateManager = new IndexingStateManager(this.app, this);

      this.queryBlockProcessor = new QueryCodeBlockProcessor(this.app, this);
      this.writeBlockProcessor = new WriteCodeBlockProcessor(this.app, this, this.settings);
      this.chartBlockProcessor = new ChartCodeBlockProcessor(this.app, this);
      this.helpBlockProcessor = new HelpCodeBlockProcessor(this.app, this);
      this.schemaBlockProcessor = new SchemaCodeBlockProcessor(this.app, this);
      this.markdownBlockProcessor = new MarkdownCodeBlockProcessor(this.app, this);
      this.viewBlockProcessor = new ViewCodeBlockProcessor(this.app, this);
      this.functionBlockProcessor = new FunctionCodeBlockProcessor(this.app, this);
      this.functionHelpCodeBlockProcessor = new FunctionHelpCodeBlockProcessor(this.app, this);
      this.examplesBlockProcessor = new ExamplesCodeBlockProcessor(this.app, this);
      this.apiGuideBlockProcessor = new ApiGuideCodeBlockProcessor(this.app, this);

      this.registerMarkdownCodeBlockProcessor('vaultquery', (source, el, ctx) => this.queryBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-help', (source, el, ctx) => this.helpBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-chart', (source, el, ctx) => this.chartBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-write', (source, el, ctx) => this.writeBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-schema', (source, el, ctx) => this.schemaBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-markdown', (source, el, ctx) => this.markdownBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-view', (source, el, ctx) => this.viewBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-function', (source, el, ctx) => this.functionBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-function-help', (source, el, ctx) => this.functionHelpCodeBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-examples', (source, el, ctx) => this.examplesBlockProcessor.process(source, el, ctx));
      this.registerMarkdownCodeBlockProcessor('vaultquery-api-help', (source, el, ctx) => this.apiGuideBlockProcessor.process(source, el, ctx));

      this.registerMarkdownPostProcessor((element, context) => {
        processReadingViewInlineButtons(this, element, context.sourcePath);
      });

      this.app.workspace.onLayoutReady(() => {
        void this.initializePlugin();
      });

    }

    catch (error) {
      console.error('Failed to load VaultQuery plugin:', error);
    }
  }


  /**
   * Wait for Obsidian's metadata cache to be fully populated.
   * This ensures we have access to cached headings, links, tags, etc.
   * before starting indexing, which significantly improves performance.
   */
  private waitForMetadataCache(): Promise<void> {
    return new Promise((resolve) => {
      // Check if already resolved (cache is ready)
      if (this.app.metadataCache.resolvedLinks) {
        const hasEntries = Object.keys(this.app.metadataCache.resolvedLinks).length > 0;
        if (hasEntries) {
          resolve();
          return;
        }
      }

      // Wait for the resolved event
      const eventRef = this.app.metadataCache.on('resolved', () => {
        this.app.metadataCache.offref(eventRef);
        resolve();
      });

      // Fallback timeout in case resolved event never fires
      activeWindow.setTimeout(() => {
        this.app.metadataCache.offref(eventRef);
        resolve();
      }, 5000);
    });
  }

  private async initializePlugin(): Promise<void> {
    try {
      this.api = await VaultQueryAPI.create(this.app, this.settings);

      this.indexingStateManager.setupFileWatchers();

      if (this.settings.indexingInterval === 'startup' || this.settings.indexingInterval === 'realtime') {
        // Wait for metadata cache before indexing for better performance
        await this.waitForMetadataCache();

        const timeout = activeWindow.setTimeout(async () => {
          if (!this.api) return;

          this.startUpdatingPendingCodeBlocks();
          await this.indexAllNotes();
          await this.processPendingCodeBlocks();
          this.indexingStateManager.clearStartupIndexingTimeout();
        }, 0);
        this.indexingStateManager.setStartupIndexingTimeout(timeout);
      }
      else {
        await this.processPendingCodeBlocks();
      }

      this.setupGridRestoration();

    }

    catch (error) {
      console.error('VaultQuery: Failed to initialize plugin:', error);
    }
  }


  private async processBlocksForProcessor(processor: BlockProcessor, processorName: string): Promise<void> {
    const blocks = Array.from(processor.getPendingBlocks());

    for (const block of blocks) {
      try {
        block.el.empty();
        await processor.process(block.source, block.el, block.ctx);
      }
      catch (error) {
        console.error(`[VaultQuery] Error processing pending ${processorName} block:`, error);
      }
    }
    processor.clearPendingBlocks();
  }

  private async processPendingCodeBlocks(): Promise<void> {
    await this.processBlocksForProcessor(this.queryBlockProcessor, 'query');
    await this.processBlocksForProcessor(this.writeBlockProcessor, 'write');
    await this.processBlocksForProcessor(this.chartBlockProcessor, 'chart');
  }

  private updateLoadingDiv(loadingDiv: HTMLElement, progress: { current: number; total: number; currentFile: string }): void {
    renderIndexingProgress(loadingDiv, progress);
  }

  private updateProcessorBlocks(processor: BlockProcessor, indexingStatus: IndexingStatus): void {
    for (const block of processor.getPendingBlocks()) {
      if (!block.el || !block.el.parentNode || !block.container) continue;
      const loadingDiv = block.container.querySelector('.vaultquery-loading');
      if (loadingDiv && loadingDiv.instanceOf(HTMLElement) && indexingStatus.progress) {
        this.updateLoadingDiv(loadingDiv, indexingStatus.progress);
      }
    }
  }

  private startUpdatingPendingCodeBlocks(): void {
    this.progressUpdateInterval = activeWindow.setInterval(() => {
      if (!this.api) {
        return;
      }

      const indexingStatus = this.api.getIndexingStatus();

      this.updateProcessorBlocks(this.queryBlockProcessor, indexingStatus);
      this.updateProcessorBlocks(this.writeBlockProcessor, indexingStatus);
      this.updateProcessorBlocks(this.chartBlockProcessor, indexingStatus);

      if (!indexingStatus.isIndexing) {
        if (this.progressUpdateInterval) {
          activeWindow.clearInterval(this.progressUpdateInterval);
          this.progressUpdateInterval = null;
        }
        void this.processPendingCodeBlocks();
      }
    }, 500);
  }

  private setupGridRestoration(): void {
    let scrollTimeout: number | null = null;

    this.scrollHandler = () => {
      if (scrollTimeout) {
        activeWindow.clearTimeout(scrollTimeout);
      }
      scrollTimeout = activeWindow.setTimeout(() => {
        SlickGridRenderer.checkAndRestoreGrids();
      }, 150);
    };

    const workspaceEl = this.app.workspace.containerEl;
    if (workspaceEl) {
      workspaceEl.addEventListener('scroll', this.scrollHandler, { capture: true, passive: true });
    }

    this.gridRestoreInterval = activeWindow.setInterval(() => {
      SlickGridRenderer.checkAndRestoreGrids();
    }, 2000);
  }

  private cleanupGridRestoration(): void {
    if (this.scrollHandler) {
      const workspaceEl = this.app.workspace.containerEl;
      if (workspaceEl) {
        workspaceEl.removeEventListener('scroll', this.scrollHandler, { capture: true });
      }
      this.scrollHandler = null;
    }

    if (this.gridRestoreInterval) {
      activeWindow.clearInterval(this.gridRestoreInterval);
      this.gridRestoreInterval = null;
    }
  }

  public async onunload() {
    try {
      this.cleanupGridRestoration();

      if (this.progressUpdateInterval) {
        activeWindow.clearInterval(this.progressUpdateInterval);
        this.progressUpdateInterval = null;
      }

      if (this.api) {
        this.api.setIndexingStatus(false);
      }

      this.indexingStateManager.cleanup();

      this.queryBlockProcessor.clearPendingBlocks();
      this.writeBlockProcessor.clearPendingBlocks();
      this.chartBlockProcessor.clearPendingBlocks();

      try {
        if (this.api) {
          await this.api.close();
        }
      }
      catch (error) {
        console.error('VaultQuery: Error closing database:', error);
      }

      this.api = undefined!;

    }

    catch (error) {
      console.error('VaultQuery: Error during plugin unload:', error);
    }
  }

  private async indexAllNotes() {
    if (!this.api) {
      return;
    }

    const status = this.api.getIndexingStatus();
    if (status.isIndexing) {
      return;
    }

    const indexedFiles = await this.api.getIndexedFiles();
    const isFirstRun = indexedFiles.length === 0;

    if (isFirstRun) {
      await this.api.forceReindexVault();
    }
    else {
      await this.api.reindexVault();
    }
  }
}
