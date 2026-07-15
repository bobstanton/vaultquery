import { MarkdownPostProcessorContext, MarkdownView, Plugin, loadPrism, Notice } from 'obsidian';
import { normalizeConsoleLogLevel } from 'obsidian-debug-logger';
import { VaultQueryAPI } from './VaultQueryAPI';
import type { EventRef } from './VaultQueryAPI';
import { VaultQuerySettings, DEFAULT_SETTINGS, normalizeSettings } from './Settings/Settings';
import { VaultQuerySettingTab } from './Settings/SettingsTab';
import { SlickGridRenderer } from './Renderers/SlickGridRenderer';
import { cleanupRenderedOutput } from './Renderers/RendererCleanup';
import { DatabaseRecoveryManager } from './Managers/DatabaseRecoveryManager';
import { IndexingStateManager } from './Managers/IndexingStateManager';
import { QueryCodeBlockProcessor } from './CodeBlockProcessors/QueryCodeBlockProcessor';
import { WriteCodeBlockProcessor } from './CodeBlockProcessors/WriteCodeBlockProcessor';
import { ChartCodeBlockProcessor } from './CodeBlockProcessors/ChartCodeBlockProcessor';
import { BaseHelpCodeBlockProcessor } from './CodeBlockProcessors/BaseHelpCodeBlockProcessor';
import { HelpCodeBlockProcessor } from './CodeBlockProcessors/HelpCodeBlockProcessor';
import { SchemaCodeBlockProcessor } from './CodeBlockProcessors/SchemaCodeBlockProcessor';
import { MarkdownCodeBlockProcessor } from './CodeBlockProcessors/MarkdownCodeBlockProcessor';
import { CalendarCodeBlockProcessor } from './CodeBlockProcessors/CalendarCodeBlockProcessor';
import { ViewCodeBlockProcessor } from './CodeBlockProcessors/ViewCodeBlockProcessor';
import { FunctionCodeBlockProcessor } from './CodeBlockProcessors/FunctionCodeBlockProcessor';
import { FunctionHelpCodeBlockProcessor } from './CodeBlockProcessors/FunctionHelpCodeBlockProcessor';
import { ExamplesCodeBlockProcessor } from './CodeBlockProcessors/ExamplesCodeBlockProcessor';
import { ApiGuideCodeBlockProcessor } from './CodeBlockProcessors/ApiGuideCodeBlockProcessor';
import { TriggerCodeBlockProcessor } from './CodeBlockProcessors/TriggerCodeBlockProcessor';
import { TriggerHelpCodeBlockProcessor } from './CodeBlockProcessors/TriggerHelpCodeBlockProcessor';
import { sqlHighlightPlugin, disableAutoPairInVaultquery, vaultQueryEditorAttributesExtension } from './Editor/SqlHighlightExtension';
import { registerProviderDefinitionLanguage } from './Constants/EditorConstants';
import { createInlineButtonExtension, processReadingViewInlineButtons } from './Editor/InlineButtonExtension';
import { createInlineQueryExtension, processReadingViewInlineQueries } from './Editor/InlineQueryExtension';
import { createVaultQueryCompletionExtension } from './Editor/VaultQueryCompletionExtension';
import { registerVaultQueryCliHandlers } from './Services/CliQueryService';
import { renderIndexingProgress } from './utils/IndexingUtils';
import { LifecycleManager } from './utils/LifecycleManager';
import { logger as rootLogger } from './utils/logger';
import { SQL_HIGHLIGHTED_LANGUAGES, JS_HIGHLIGHTED_LANGUAGES } from './Constants/EditorConstants';
import type { IndexingStatus } from './types';
import type { BlockProcessor } from './utils/IndexingUtils';
import * as chartHelp from './generated-help/vaultquery-chart-help.generated';
import * as calendarHelp from './generated-help/vaultquery-calendar-help.generated';

import './styles.css';
import './slickgrid-obsidian-theme.css';

import { VAULTQUERY_API_READY_EVENT } from './helpers';
export { getVaultQueryAPI, waitForVaultQueryAPI, registerVaultQueryTableProviders, VAULTQUERY_API_READY_EVENT } from './helpers';
export type {
  ManagedVaultQueryTableProviderRegistration,
  RegisterVaultQueryTableProvidersOptions,
  VaultQueryAppLike,
  VaultQueryProviderRegistrationLogger,
  VaultQueryProviderRegistrationState,
  WaitForAPIOptions,
} from './helpers';

declare const activeDocument: Document;

type PrismGrammar = Record<string, unknown>;
interface PrismApi {
  languages: Record<string, PrismGrammar | undefined>;
}

const logger = {
  lifecycle: rootLogger.scope('Lifecycle'),
  provider: rootLogger.scope('ProviderTables'),
};

interface MarkdownBlockProcessor {
  process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void | Promise<void>;
}

interface UnloadableProcessor {
  unload(): void;
}

interface ProcessorRegistration {
  language: string;
  processor: MarkdownBlockProcessor;
  pendingName?: string;
  updateDuringIndexing?: boolean;
  unloadOnPluginUnload?: boolean;
}

function mergeSettings(savedData: Partial<VaultQuerySettings>): VaultQuerySettings {
  return {
    ...DEFAULT_SETTINGS,
    ...savedData,
    enabledFeatures: {
      ...DEFAULT_SETTINGS.enabledFeatures,
      ...savedData.enabledFeatures
    },
    wasm: {
      ...DEFAULT_SETTINGS.wasm,
      ...savedData.wasm
    }
  };
}

export default class VaultQueryPlugin extends Plugin {
  private static readonly SETTINGS_REINDEX_DEBOUNCE_MS = 1000;
  private static readonly SETTINGS_REINDEX_RETRY_MS = 1000;
  private static readonly TIMER_SETTINGS_REINDEX = 'settings-reindex';
  private static readonly TIMER_PROGRESS_UPDATE = 'progress-update';
  private static readonly TIMER_GRID_RESTORE = 'grid-restore';
  private static readonly TIMER_SCROLL_RESTORE = 'scroll-restore';

  public api!: VaultQueryAPI;
  public settings!: VaultQuerySettings;
  public indexingStateManager!: IndexingStateManager;
  private databaseRecoveryManager!: DatabaseRecoveryManager;
  private invalidateCompletionSchemaCache: (() => void) | null = null;
  private settingsReindexPending = false;
  private registeredProviderBlockLanguages = new Set<string>();
  private schemaEventRefs: EventRef[] = [];
  private lifecycle = new LifecycleManager();
  private processorRegistrations: ProcessorRegistration[] = [];
  private pendingBlockProcessors: Array<{ name: string; processor: BlockProcessor }> = [];
  private indexingProgressProcessors: BlockProcessor[] = [];
  private unloadableProcessors: UnloadableProcessor[] = [];

  public async loadSettings() {
    const savedData = (await this.loadData() as Partial<VaultQuerySettings> | null) ?? {};

    this.settings = mergeSettings(savedData);

    this.settings.debugConsoleLogLevel = normalizeConsoleLogLevel(this.settings.debugConsoleLogLevel);
    normalizeSettings(this.settings);
    rootLogger.configure(this.settings.debugConsoleLogLevel);
  }

  public async saveSettings(options: { requiresFullReindex?: boolean } = {}) {
    this.settings.debugConsoleLogLevel = normalizeConsoleLogLevel(this.settings.debugConsoleLogLevel);
    normalizeSettings(this.settings);
    rootLogger.configure(this.settings.debugConsoleLogLevel);
    await this.saveData(this.settings);
    this.api?.setThirdPartyProviderTablesEnabled(this.settings.enableThirdPartyProviderTables);

    if (options.requiresFullReindex) {
      this.scheduleSettingsReindex();
    }
  }

  private scheduleSettingsReindex(delayMs: number = VaultQueryPlugin.SETTINGS_REINDEX_DEBOUNCE_MS): void {
    this.settingsReindexPending = true;

    this.lifecycle.scheduleTimeout(VaultQueryPlugin.TIMER_SETTINGS_REINDEX, () => {
      void this.runPendingSettingsReindex();
    }, delayMs);
  }

  private async runPendingSettingsReindex(): Promise<void> {
    if (!this.settingsReindexPending) {
      return;
    }

    if (!this.api || this.api.getIndexingStatus().isIndexing || this.indexingStateManager?.hasPendingFileModifications()) {
      this.scheduleSettingsReindex(VaultQueryPlugin.SETTINGS_REINDEX_RETRY_MS);
      return;
    }

    this.settingsReindexPending = false;
    new Notice('VaultQuery: Rebuilding index for settings changes...', 4000);

    try {
      this.startUpdatingPendingCodeBlocks();
      await this.api.forceReindexVault();
      await this.processPendingCodeBlocks();
      new Notice('VaultQuery: Settings rebuild complete', 3000);
    }
    catch (error) {
      logger.lifecycle.error('Failed to rebuild index after settings change', error);
      this.settingsReindexPending = true;
      new Notice('VaultQuery: Failed to rebuild index after settings change', 6000);
    }
  }

  private registerCodeBlockProcessors(): void {
    const queryProcessor = new QueryCodeBlockProcessor(this.app, this);
    const writeProcessor = new WriteCodeBlockProcessor(this.app, this, this.settings);
    const chartProcessor = new ChartCodeBlockProcessor(this.app, this);
    const chartHelpProcessor = new BaseHelpCodeBlockProcessor(this.app, this, 'vaultquery-chart-help', chartHelp);
    const helpProcessor = new HelpCodeBlockProcessor(this.app, this);
    const schemaProcessor = new SchemaCodeBlockProcessor(this.app, this);
    const markdownProcessor = new MarkdownCodeBlockProcessor(this.app, this);
    const calendarProcessor = new CalendarCodeBlockProcessor(this.app, this);
    const calendarHelpProcessor = new BaseHelpCodeBlockProcessor(this.app, this, 'vaultquery-calendar-help', calendarHelp);
    const viewProcessor = new ViewCodeBlockProcessor(this.app, this);
    const functionProcessor = new FunctionCodeBlockProcessor(this.app, this);
    const functionHelpProcessor = new FunctionHelpCodeBlockProcessor(this.app, this);
    const examplesProcessor = new ExamplesCodeBlockProcessor(this.app);
    const apiGuideProcessor = new ApiGuideCodeBlockProcessor(this.app, this);
    const triggerProcessor = new TriggerCodeBlockProcessor(this.app, this);
    const triggerHelpProcessor = new TriggerHelpCodeBlockProcessor(this.app, this);

    this.processorRegistrations = [
      { language: 'vaultquery', processor: queryProcessor, pendingName: 'query', updateDuringIndexing: true },
      { language: 'vaultquery-help', processor: helpProcessor, unloadOnPluginUnload: true },
      { language: 'vaultquery-chart', processor: chartProcessor, pendingName: 'chart', updateDuringIndexing: true },
      { language: 'vaultquery-chart-help', processor: chartHelpProcessor, unloadOnPluginUnload: true },
      { language: 'vaultquery-write', processor: writeProcessor, pendingName: 'write', updateDuringIndexing: true },
      { language: 'vaultquery-schema', processor: schemaProcessor },
      { language: 'vaultquery-markdown', processor: markdownProcessor, pendingName: 'markdown', updateDuringIndexing: true },
      { language: 'vaultquery-markdown-help', processor: helpProcessor },
      { language: 'vaultquery-calendar', processor: calendarProcessor, pendingName: 'calendar', updateDuringIndexing: true },
      { language: 'vaultquery-calendar-help', processor: calendarHelpProcessor, unloadOnPluginUnload: true },
      { language: 'vaultquery-view', processor: viewProcessor, unloadOnPluginUnload: true },
      { language: 'vaultquery-function', processor: functionProcessor, unloadOnPluginUnload: true },
      { language: 'vaultquery-function-help', processor: functionHelpProcessor, unloadOnPluginUnload: true },
      { language: 'vaultquery-examples', processor: examplesProcessor },
      { language: 'vaultquery-api-help', processor: apiGuideProcessor, unloadOnPluginUnload: true },
      { language: 'vaultquery-trigger', processor: triggerProcessor, unloadOnPluginUnload: true },
      { language: 'vaultquery-trigger-help', processor: triggerHelpProcessor, unloadOnPluginUnload: true },
    ];

    this.pendingBlockProcessors = this.processorRegistrations
      .filter((registration): registration is ProcessorRegistration & { pendingName: string; processor: BlockProcessor } =>
        registration.pendingName !== undefined
      )
      .map(registration => ({ name: registration.pendingName, processor: registration.processor }));

    this.indexingProgressProcessors = this.processorRegistrations
      .filter((registration): registration is ProcessorRegistration & { processor: BlockProcessor } =>
        registration.updateDuringIndexing === true
      )
      .map(registration => registration.processor);

    this.unloadableProcessors = this.processorRegistrations
      .filter((registration): registration is ProcessorRegistration & { processor: UnloadableProcessor } =>
        registration.unloadOnPluginUnload === true
      )
      .map(registration => registration.processor);

    for (const { language, processor } of this.processorRegistrations) {
      this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => processor.process(source, el, ctx));
    }
  }

  private async registerPrismLanguages(): Promise<void> {
    const Prism = await loadPrism() as PrismApi;

    if (Prism.languages['sql']) {
      for (const lang of SQL_HIGHLIGHTED_LANGUAGES) {
        Prism.languages[lang] = Prism.languages['sql'];
      }

      const sqlWithConfig = {
        'config-section': {
          pattern: /^config:[\s\S]*$/m,
          inside: {
            'config-delimiter': /^config:/m,
            'config-key': {
              pattern: /^[a-zA-Z][a-zA-Z0-9_-]*(?=\s*:)/m,
              alias: 'property'
            },
            'config-value': {
              pattern: /:\s*.+$/m,
              inside: {
                'punctuation': /^:/,
                'color': /rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/,
                'number': /\b\d+(\.\d+)?(%|px|em|rem)?\b/,
                'boolean': /\b(true|false)\b/i,
                'string': /.+/
              }
            }
          }
        },
        'template-section': {
          pattern: /^template:[\s\S]*$/m,
          inside: {
            'template-delimiter': /^template:/m,
            'template-code': /[\s\S]+/
          }
        },
        ...Prism.languages['sql']
      };

      Prism.languages['vaultquery'] = sqlWithConfig;
      Prism.languages['vaultquery-chart'] = sqlWithConfig;
      Prism.languages['vaultquery-markdown'] = sqlWithConfig;
      Prism.languages['vaultquery-calendar'] = sqlWithConfig;
    }

    if (Prism.languages['javascript']) {
      for (const lang of JS_HIGHLIGHTED_LANGUAGES) {
        Prism.languages[lang] = Prism.languages['javascript'];
      }
    }
  }

  private async registerProviderDefinitionPrismLanguage(language: string): Promise<void> {
    const Prism = await loadPrism() as PrismApi;

    if (Prism.languages[language]) {
      return;
    }

    Prism.languages[language] = {
      comment: /#.*/,
      property: /^[ \t]*[^:\n]+(?=\s*:)/m,
      punctuation: /:/,
      color: /rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/,
      boolean: /\b(true|false|yes|no)\b/i,
      number: /\b\d+(\.\d+)?\b/,
      string: /.+/
    };
  }

  public async onload(): Promise<void> {
    try {
      await this.loadSettings();

      this.registerEditorExtension(sqlHighlightPlugin);
      this.registerEditorExtension(vaultQueryEditorAttributesExtension);
      this.registerEditorExtension(disableAutoPairInVaultquery);
      this.registerEditorExtension(createInlineButtonExtension(this));
      this.registerEditorExtension(createInlineQueryExtension(this));
      registerVaultQueryCliHandlers(this);
      const completion = createVaultQueryCompletionExtension(this);
      this.invalidateCompletionSchemaCache = completion.invalidateSchemaCache;
      this.registerEditorExtension(completion.extension);

      this.addCommand({
        id: 'copy-debug-log',
        name: 'Copy debug log to clipboard',
        callback: async () => {
          try {
            const entryCount = await rootLogger.copyToClipboard();
            new Notice(`VaultQuery: Debug log copied (${entryCount} entries)`, 3000);
          }
          catch (error) {
            rootLogger.scope('DebugLog').error('Failed to copy debug log', error);
            new Notice('VaultQuery: Failed to copy debug log', 5000);
          }
        },
      });

      await this.registerPrismLanguages();

      this.addSettingTab(new VaultQuerySettingTab(this.app, this));

      this.indexingStateManager = new IndexingStateManager(this.app, this);
      this.databaseRecoveryManager = new DatabaseRecoveryManager({
        app: this.app,
        settings: this.settings,
        getApi: () => this.api ?? null,
        setApi: (api) => { this.api = api; },
        onApiRecreated: () => this.attachProviderIntegrationHooks(),
        reindexVault: () => this.indexAllNotes(),
        rerenderMarkdownPreviews: () => this.rerenderMarkdownPreviews(),
      });

      this.registerCodeBlockProcessors();

      this.registerMarkdownPostProcessor((element, context) => {
        processReadingViewInlineQueries(this, element, context.sourcePath);
        processReadingViewInlineButtons(this, element, context.sourcePath);
      });

      this.app.workspace.onLayoutReady(() => {
        void this.initializePlugin();
      });

    }

    catch (error) {
      logger.lifecycle.error('Failed to load VaultQuery plugin', error);
    }
  }


  /**
   * Wait for Obsidian's metadata cache to be fully populated.
   * Indexing after this point can use cached headings, links, tags, etc.,
   * which significantly improves performance.
   */
  private waitForMetadataCache(): Promise<void> {
    return new Promise((resolve) => {
      if (this.app.metadataCache.resolvedLinks) {
        const hasEntries = Object.keys(this.app.metadataCache.resolvedLinks).length > 0;
        if (hasEntries) {
          resolve();
          return;
        }
      }

      const timeout = window.setTimeout(() => {
        this.app.metadataCache.offref(eventRef);
        resolve();
      }, 5000);

      const eventRef = this.app.metadataCache.on('resolved', () => {
        window.clearTimeout(timeout);
        this.app.metadataCache.offref(eventRef);
        resolve();
      });
    });
  }

  private scheduleStartupIndexing(): void {
    // Use a cancellable macrotask so Obsidian can finish layout work before indexing starts.
    const timeout = window.setTimeout(() => {
      void (async () => {
        if (!this.api) return;

        try {
          await this.indexAllNotes();
        }
        catch (error) {
          logger.lifecycle.error('Startup indexing failed', error);
        }
        finally {
          this.indexingStateManager.clearStartupIndexingTimeout();
        }
      })();
    }, 0);
    this.indexingStateManager.setStartupIndexingTimeout(timeout);
  }

  private async initializePlugin(): Promise<void> {
    try {
      this.api = await VaultQueryAPI.create(this.app, this.settings);
      logger.lifecycle.info(`API created: thirdPartyProviderTablesEnabled=${this.settings.enableThirdPartyProviderTables}`);
      this.attachProviderIntegrationHooks();

      this.indexingStateManager.setupFileWatchers();

      this.setupGridRestoration();
      this.setupVisibilityHandler();
      await this.databaseRecoveryManager.recordCurrentHealth();

      if (this.settings.indexingInterval === 'startup' || this.settings.indexingInterval === 'realtime') {
        await this.waitForMetadataCache();
        this.scheduleStartupIndexing();
      }
      else {
        await this.processPendingCodeBlocks();
      }
    }

    catch (error) {
      logger.lifecycle.error('Failed to initialize plugin', error);
    }
  }

  private registerProviderDefinitionBlockLanguage(language: string): void {
    if (this.registeredProviderBlockLanguages.has(language)) {
      logger.provider.debug(`Provider definition block language already registered: ${language}`);
      return;
    }

    logger.provider.info(`Registering provider definition block language: ${language}`);
    this.registeredProviderBlockLanguages.add(language);
    registerProviderDefinitionLanguage(language);
    this.invalidateCompletionSchemaCache?.();
    void this.registerProviderDefinitionPrismLanguage(language);
    this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
      logger.provider.debug(`Provider definition code block processor fired: language=${language}, sourcePath=${ctx.sourcePath}, sourceLength=${source.length}`);
      void this.api.renderTableProviderDefinitionBlock(language, source, el, ctx);
    });
    this.rerenderMarkdownPreviews();
  }

  private rerenderMarkdownPreviews(): void {
    let rerendered = 0;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.getMode() === 'preview') {
        leaf.view.previewMode.rerender(true);
        rerendered++;
      }
    }
    logger.provider.debug(`Rerendered ${rerendered} markdown preview(s) after provider language registration`);
  }


  private async processBlocksForProcessor(processor: BlockProcessor, processorName: string): Promise<void> {
    const blocks = Array.from(processor.getPendingBlocks());

    for (const block of blocks) {
      try {
        cleanupRenderedOutput(block.el);
        await processor.process(block.source, block.el, block.ctx);
      }
      catch (error) {
        logger.lifecycle.error(`Error processing pending ${processorName} block`, error);
      }
    }
    processor.clearPendingBlocks();
  }

  private async processPendingCodeBlocks(): Promise<void> {
    for (const { processor, name } of this.pendingBlockProcessors) {
      await this.processBlocksForProcessor(processor, name);
    }
  }

  private updateProcessorBlocks(processor: BlockProcessor, indexingStatus: IndexingStatus): void {
    for (const block of processor.getPendingBlocks()) {
      if (!block.el || !block.el.parentNode || !block.container) continue;
      const loadingDiv = block.container.querySelector('.vaultquery-loading');
      if (loadingDiv && loadingDiv.instanceOf(HTMLElement) && indexingStatus.progress) {
        renderIndexingProgress(loadingDiv, indexingStatus.progress);
      }
    }
  }

  private startUpdatingPendingCodeBlocks(): void {
    this.lifecycle.scheduleInterval(VaultQueryPlugin.TIMER_PROGRESS_UPDATE, () => {
      if (!this.api) {
        return;
      }

      const indexingStatus = this.api.getIndexingStatus();

      for (const processor of this.indexingProgressProcessors) {
        this.updateProcessorBlocks(processor, indexingStatus);
      }

      if (!indexingStatus.isIndexing) {
        this.lifecycle.cancelInterval(VaultQueryPlugin.TIMER_PROGRESS_UPDATE);
        void this.processPendingCodeBlocks();
      }
    }, 500);
  }

  private setupGridRestoration(): void {
    const scrollHandler = () => {
      this.lifecycle.scheduleTimeout(VaultQueryPlugin.TIMER_SCROLL_RESTORE, () => {
        SlickGridRenderer.checkAndRestoreGrids();
      }, 150);
    };

    const workspaceEl = this.app.workspace.containerEl;
    if (workspaceEl) {
      this.registerDomEvent(workspaceEl, 'scroll', scrollHandler, { capture: true, passive: true });
    }

    this.lifecycle.scheduleInterval(VaultQueryPlugin.TIMER_GRID_RESTORE, () => {
      SlickGridRenderer.checkAndRestoreGrids();
    }, 2000);
  }

  private cleanupGridRestoration(): void {
    this.lifecycle.cancelTimeout(VaultQueryPlugin.TIMER_SCROLL_RESTORE);
    this.lifecycle.cancelInterval(VaultQueryPlugin.TIMER_GRID_RESTORE);
  }

  private setupVisibilityHandler(): void {
    this.registerDomEvent(activeDocument, 'visibilitychange', () => {
      if (activeDocument.visibilityState === 'visible') {
        void this.databaseRecoveryManager.handleResume();
      }
    });
  }

  private cleanupLifecycle(): void {
    this.lifecycle.cleanup();
  }

  public onunload() {
    try {
      this.cleanupGridRestoration();
      this.cleanupLifecycle();

      if (this.api) {
        this.api.setIndexingStatus(false);
      }

      this.indexingStateManager.cleanup();
      this.schemaEventRefs.forEach(ref => this.api?.off(ref));
      this.schemaEventRefs = [];

      for (const { processor } of this.pendingBlockProcessors) {
        processor.clearPendingBlocks();
      }

      for (const processor of this.unloadableProcessors) {
        processor.unload();
      }
      SlickGridRenderer.cleanup();

      if (this.api) {
        void this.api.close();
      }

      this.api = undefined!;

    }

    catch (error) {
      logger.lifecycle.error('Error during plugin unload', error);
    }
  }

  private setupAutocompleteSchemaInvalidation(): void {
    if (!this.api || !this.invalidateCompletionSchemaCache) {
      return;
    }

    this.schemaEventRefs.forEach(ref => this.api?.off(ref));
    this.schemaEventRefs = [
      this.api.on('vault-indexed', () => {
        this.invalidateCompletionSchemaCache?.();
      }),
      this.api.on('file-indexed', () => {
        this.invalidateCompletionSchemaCache?.();
      }),
      this.api.on('database-restored', () => {
        this.invalidateCompletionSchemaCache?.();
      }),
    ];
  }

  private attachProviderIntegrationHooks(): void {
    if (!this.api) {
      return;
    }

    this.api.setPipelineStateProvider(this.indexingStateManager);
    this.api.setProviderBlockLanguageRegistrar((language) => {
      this.registerProviderDefinitionBlockLanguage(language);
    });
    this.setupAutocompleteSchemaInvalidation();

    this.app.workspace.trigger(VAULTQUERY_API_READY_EVENT);
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

    this.startUpdatingPendingCodeBlocks();
    if (isFirstRun) {
      await this.api.forceReindexVault();
    }
    else {
      await this.api.reindexVault();
    }
    await this.processPendingCodeBlocks();
  }
}
