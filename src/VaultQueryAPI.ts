import { App, MarkdownPostProcessorContext, TFile, normalizePath } from 'obsidian';
import { VaultDatabase } from './Database/DatabaseService';
import { WorkerDatabase } from './Database/WorkerDatabaseService';
import { VaultQuerySettings, EnabledFeatures } from './Settings/Settings';
import { IndexingService } from './Services/IndexingService';
import { WriteSyncService } from './Services/WriteSyncService';
import { TriggerFunctions, TriggerService, TRIGGER_FUNCTION_NAMES } from './Triggers';
import { resolveQueryTemplate } from './Services/QueryTemplator';
import { getErrorMessage, ERROR_MESSAGES } from './utils/ErrorMessages';
import { quoteIdentifier } from './utils/SqlIdentifierUtils';
import { containsBlockedSqlInStripped, parseDroppedSQLObjectName, parseSQLObjectName, stripSqlComments, stripSqlStringLiterals } from './utils/SQLParsingUtils';
import type { IndexingStats, IndexingStatus, NoteSource } from './types';
import type { PreviewResult } from './Services/PreviewService';
import { TableProviderService } from './Providers/TableProviderService';
import { QueryRefreshRegistry } from './Renderers/QueryRefreshRegistry';
import { getIndexedFilesFromDatabase } from './Database/IndexedFiles';
import { mergeDeclaredProviderTables } from './utils/AutocompleteSchemaUtils';
import type { AutocompleteSchemaColumnInfo, AutocompleteSchemaRelationInfo, AutocompleteSchemaShape } from './utils/AutocompleteSchemaUtils';
import { insertRowsChunked, relationExists } from './Database/SqlHelpers';
import { renderSchemaTableDoc, taskColumnDocs, BLOCKS_COLUMNS, EMBEDS_COLUMNS, HEADINGS_COLUMNS, HEADINGS_VIEW_COLUMNS, LINKS_COLUMNS, LIST_ITEMS_COLUMNS, LIST_ITEMS_VIEW_COLUMNS, NOTES_COLUMNS, PROPERTIES_COLUMNS, TABLE_CELLS_COLUMNS, TABLE_ROWS_COLUMNS, TAGS_COLUMNS, TASKS_VIEW_COLUMNS, UNRESOLVED_LINKS_COLUMNS } from './Database/SchemaDocumentation';
import { CustomSQLFunctions } from './Database/CustomSQLFunctions';
import { EventBus } from './utils/EventBus';
import type { EventRef } from './utils/EventBus';
import { logger as rootLogger } from './utils/logger';
import { formatUnknownValue } from './utils/ResultFormatUtils';
import type { TableProviderRegistration, TableProviderStatus, ProviderDefinitionCompletionConfig, ProviderTablesChangedEvent, VaultQueryTableProvider } from './Providers/TableProviderTypes';

const logger = rootLogger.scope('API');

const PROVIDER_TABLE_RETRY_TIMEOUT_MS = 2_000;
const PROVIDER_TABLE_RETRY_INTERVAL_MS = 100;

export interface FileIndexedEvent {
  path: string;
  isUpdate: boolean;
}

export interface FileRemovedEvent {
  path: string;
}

export interface VaultIndexedEvent {
  filesIndexed: number;
  filesRemoved: number;
  isForced: boolean;
}

export interface DatabaseLostEvent {
  error: string;
  timestamp: number;
}

export interface DatabaseRestoredEvent {
  timestamp: number;
}

export interface DatabaseHealth {
  healthy: boolean;
  error?: string;
  diagnostics: Record<string, unknown>;
}

const TABLE_FEATURE_CONFIG: Record<string, {
  setting: keyof EnabledFeatures;
  featureName: string;
  settingLabel: string;
}> = {
  'properties': { setting: 'indexFrontmatter', featureName: 'Property indexing', settingLabel: 'Index frontmatter' },
  'notes_with_properties': { setting: 'indexFrontmatter', featureName: 'Property indexing', settingLabel: 'Index frontmatter' },
  'note_properties': { setting: 'indexFrontmatter', featureName: 'Property indexing', settingLabel: 'Index frontmatter' },
  'tables': { setting: 'indexTables', featureName: 'Table indexing', settingLabel: 'Index tables' },
  'table_cells': { setting: 'indexTables', featureName: 'Table indexing', settingLabel: 'Index tables' },
  'table_rows': { setting: 'indexTables', featureName: 'Table indexing', settingLabel: 'Index tables' },
  'table_columns': { setting: 'indexTables', featureName: 'Table indexing', settingLabel: 'Index tables' },
  'tasks': { setting: 'indexTasks', featureName: 'Task indexing', settingLabel: 'Index tasks' },
  'tasks_view': { setting: 'indexTasks', featureName: 'Task indexing', settingLabel: 'Index tasks' },
  'headings': { setting: 'indexHeadings', featureName: 'Heading indexing', settingLabel: 'Index headings' },
  'headings_view': { setting: 'indexHeadings', featureName: 'Heading indexing', settingLabel: 'Index headings' },
  'links': { setting: 'indexLinks', featureName: 'Link indexing', settingLabel: 'Index links' },
  'unresolved_links': { setting: 'indexUnresolvedLinks', featureName: 'Unresolved link indexing', settingLabel: 'Index unresolved links' },
  'embeds': { setting: 'indexEmbeds', featureName: 'Embed indexing', settingLabel: 'Index embeds' },
  'tags': { setting: 'indexTags', featureName: 'Tag indexing', settingLabel: 'Index tags' },
  'blocks': { setting: 'indexBlocks', featureName: 'Block indexing', settingLabel: 'Index blocks' },
  'list_items': { setting: 'indexListItems', featureName: 'List item indexing', settingLabel: 'Index list items' },
  'list_items_view': { setting: 'indexListItems', featureName: 'List item indexing', settingLabel: 'Index list items' }
};


export interface QueryResult {
  [key: string]: string | number | boolean | null;
}

export interface VaultQueryCapabilities {
  writeEnabled: boolean;
  fileDeleteEnabled: boolean;
  thirdPartyProviderTablesEnabled: boolean;
  indexing: {
    content: boolean;
    frontmatter: boolean;
    tables: boolean;
    tasks: boolean;
    headings: boolean;
    links: boolean;
    unresolvedLinks: boolean;
    embeds: boolean;
    tags: boolean;
    blocks: boolean;
    listItems: boolean;
  };
}

export interface QueryMirrorStatus {
  active: boolean;
  reason?: string;
}

export interface IVaultQueryAPI {
  /**
   * Run a read query against the indexed vault data.
   * Pass a note when the query uses `{this.*}` placeholders.
   */
  query(sql: string, noteSource?: NoteSource): Promise<QueryResult[]>;

  /**
   * Reindex files that have changed since the last run.
   */
  reindexVault(): Promise<void>;

  /**
   * Clear the index and rebuild it from every markdown file.
   */
  forceReindexVault(): Promise<void>;

  /**
   * Reindex one note by vault-relative path.
   */
  reindexNote(notePath: string): Promise<void>;

  /**
   * Process any pending actions queued by vq_* SQL functions.
   */
  processPendingTriggerActions(): Promise<void>;

  /**
   * Current indexing state and progress, if indexing is running.
   */
  getIndexingStatus(): IndexingStatus;

  /**
   * Wait until indexing is idle. The canonical way to wait for the index.
   * Useful before a plugin runs queries that need the full vault, not a
   * partially built startup index.
   */
  waitForIndexing(timeoutMs?: number): Promise<void>;

  /**
   * Check whether the database is currently usable.
   */
  checkDatabaseHealthAsync(): Promise<DatabaseHealth>;

  /**
   * Remove one note from the index. The file is left alone.
   */
  removeNote(notePath: string): Promise<void>;

  /**
   * Indexed files and the modification time recorded for each one.
   */
  getIndexedFiles(): Promise<Array<{ path: string; modified: number }>>;

  /**
   * True when the file is missing from the index or its mtime has changed.
   */
  needsIndexing(file: TFile): Promise<boolean>;

  /**
   * Index one note. Provide content if you already have it.
   */
  indexNote(file: TFile, content?: string): Promise<void>;

  /**
   * Markdown schema reference used by the schema code block.
   */
  getSchemaInfo(): Promise<string>;

  /**
   * Live schema data for editor autocomplete.
   */
  getAutocompleteSchema(): Promise<AutocompleteSchemaShape>;

  /**
   * True when a file passes the indexing filters in settings.
   */
  shouldIndexFile(file: TFile): boolean;

  /**
   * Timing details from the last indexing run.
   */
  getPerformanceStats(): IndexingStats | null;

  /**
   * Recreate dynamic markdown-table views from `table_cells`.
   */
  rebuildTableViews(): Promise<void>;

  /**
   * Run a non-query statement. For writes that should sync to files, prefer
   * `previewQuery()` followed by `applyPreview()`.
   */
  execute(sql: string): Promise<number>;

  /**
   * Enabled features and write permissions for the current settings.
   */
  getCapabilities(): VaultQueryCapabilities;

  getQueryMirrorStatus(): QueryMirrorStatus;

  /**
   * Register or replace a JavaScript-backed SQL function.
   */
  registerCustomFunction(name: string, source: string): Promise<void>;

  registerTableProvider(provider: VaultQueryTableProvider): Promise<TableProviderRegistration>;
  unregisterTableProvider(providerId: string): Promise<void>;
  getTableProviderStatus(providerId?: string): Promise<TableProviderStatus[]>;
  getProviderDefinitionCompletions(language: string): ProviderDefinitionCompletionConfig | null;

  /**
   * Preview an INSERT, UPDATE, or DELETE without committing it.
   */
  previewQuery(sql: string, params?: unknown[], noteSource?: NoteSource): Promise<PreviewResult>;

  /**
   * Commit a preview and sync the resulting edits to vault files.
   */
  applyPreview(previewResult: PreviewResult): Promise<string[]>;

  /**
   * Fired after one file has been indexed.
   */
  on(event: 'file-indexed', callback: (event: FileIndexedEvent) => void): EventRef;

  /**
   * Fired after one file has been removed from the index.
   */
  on(event: 'file-removed', callback: (event: FileRemovedEvent) => void): EventRef;

  /**
   * Fired after a full or incremental vault reindex completes.
   */
  on(event: 'vault-indexed', callback: (event: VaultIndexedEvent) => void): EventRef;

  /**
   * Fired when VaultQuery detects a lost database connection.
   */
  on(event: 'database-lost', callback: (event: DatabaseLostEvent) => void): EventRef;

  /**
   * Fired after VaultQuery recreates the database and reindexes.
   */
  on(event: 'database-restored', callback: (event: DatabaseRestoredEvent) => void): EventRef;

  /**
   * Fired after a third-party provider table refresh has been materialized.
   */
  on(event: 'provider-tables-changed', callback: (event: ProviderTablesChangedEvent) => void): EventRef;

  /**
   * Remove a listener returned from `on()`.
   */
  off(ref: EventRef): void;

}

/**
 * Internal event map for typed subscriptions.
 */
interface VaultQueryEvents {
  'file-indexed': FileIndexedEvent;
  'file-removed': FileRemovedEvent;
  'vault-indexed': VaultIndexedEvent;
  'database-lost': DatabaseLostEvent;
  'database-restored': DatabaseRestoredEvent;
  'provider-tables-changed': ProviderTablesChangedEvent;
}

export type { EventRef };

export class VaultQueryAPI implements IVaultQueryAPI {
  private app: App;
  private database: VaultDatabase | WorkerDatabase;
  private indexingService: IndexingService;
  private writeSyncService: WriteSyncService;
  private triggerFunctions: TriggerFunctions;
  private triggerService: TriggerService | null = null;
  private indexingWorker: WorkerDatabase | null = null;
  private queryMirror: WorkerDatabase | null = null;
  private queryMirrorDisabledReason: string | null = 'not started';
  private providerMirrorSync: Promise<void> | null = null;
  private providerRefreshWave: Promise<void> | null = null;
  private tableProviderService: TableProviderService;
  private registeredCustomViews = new Map<string, string>();

  private eventBus: EventBus<VaultQueryEvents>;

  private triggerActionProcessing: Promise<void> | null = null;

  /**
   * Per-statement analysis (comment/literal stripping + referenced tables),
   * cached because block SQL strings repeat on every render and auto-refresh.
   */
  private static readonly SQL_ANALYSIS_CACHE_LIMIT = 200;
  private sqlAnalysisCache = new Map<string, { stripped: string; referencedTables: Set<string> }>();

  private constructor(app: App, private settings: VaultQuerySettings, database: VaultDatabase | WorkerDatabase, indexingService: IndexingService, writeSyncService: WriteSyncService, triggerFunctions: TriggerFunctions, eventBus?: EventBus<VaultQueryEvents>) {
    // Reuse the previous instance's bus during database recovery so that
    // third-party subscriptions (e.g. 'database-restored') survive the API
    // being recreated.
    this.eventBus = eventBus ?? new EventBus<VaultQueryEvents>([
      'file-indexed',
      'file-removed',
      'vault-indexed',
      'database-lost',
      'database-restored',
      'provider-tables-changed',
    ], (event, error) => {
      logger.error(`Error in event listener for '${event}'`, error);
    });
    this.app = app;
    this.database = database;
    this.indexingService = indexingService;
    this.writeSyncService = writeSyncService;
    this.triggerFunctions = triggerFunctions;
    this.tableProviderService = new TableProviderService(database, this.settings.enableThirdPartyProviderTables);
    this.tableProviderService.setOnAllQueriesRefresh(() => QueryRefreshRegistry.refreshAll({ force: true }));
    this.tableProviderService.setOnRefreshWaveComplete(async tables => {
      await this.queueProviderTableMirrorSync(tables);
      // The initial refresh wave performs one refresh after its readiness
      // promise is cleared, so dependent queries do not wait on themselves.
      if (!this.providerRefreshWave) {
        await QueryRefreshRegistry.refreshAll({ force: true });
      }
    });
    this.tableProviderService.setOnProviderTablesChanged(event => {
      this.emit('provider-tables-changed', event);
    });
    this.indexingService.setProviderDefinitionBlockHandler(this.tableProviderService);

    this.indexingService.setEventEmitter({
      emitFileIndexed: (path: string, isUpdate: boolean) => {
        this.emit('file-indexed', { path, isUpdate });
        this.processTriggerActions();
      },
      emitFileRemoved: (path: string) => {
        this.emit('file-removed', { path });
      },
      emitVaultIndexed: (filesIndexed: number, filesRemoved: number, isForced: boolean) => {
        if (this.settings.enableThirdPartyProviderTables) {
          this.startInitialProviderRefreshWave();
        }
        this.emit('vault-indexed', { filesIndexed, filesRemoved, isForced });
      },
      // Transfer database from worker to main thread BEFORE vault-indexed event fires
      // so third-party plugins registering views/functions get the main thread database
      onBeforeVaultIndexed: async () => {
        await this.transferToMainThread();
        // Register user-defined functions after database transfer (create_function doesn't persist in binary)
        if (this.settings.enableJavaScriptFunctions) {
          this.registerUserFunctions();
        }
        // Recreate third-party views registered through execute(); worker-to-main transfer can replace the database.
        await this.registerCustomViews();
        // Register user-defined SQLite triggers after indexing completes (if enabled)
        if (this.settings.enableTriggers) {
          this.registerUserTriggers();
          await this.syncMirrorTriggers();
        }
      }
    });
  }

  private processTriggerActions(): void {
    void this.processPendingTriggerActions();
  }

  public async processPendingTriggerActions(): Promise<void> {
    if (this.triggerActionProcessing) {
      return this.triggerActionProcessing;
    }

    this.triggerActionProcessing = this.runTriggerProcessingLoop().finally(() => {
      this.triggerActionProcessing = null;
    });
    return this.triggerActionProcessing;
  }

  private async runTriggerProcessingLoop(): Promise<void> {
    if (!this.triggerService) return;
    try {
      while (this.triggerFunctions.hasPendingActions()) {
        await this.triggerService.processPendingActions();
      }
    } catch (error) {
      logger.error('Error processing trigger actions', error);
    }
  }

  /**
   * Called after indexing completes to activate triggers for future file changes.
   */
  private registerUserTriggers(): void {
    if (this.database instanceof VaultDatabase) {
      this.database.registerUserTriggers();
    }
  }

  /**
   * Called after database transfer from worker to main thread; functions need
   * re-registration because create_function is in-memory only.
   */
  private registerUserFunctions(): void {
    if (this.settings.enableJavaScriptFunctions && this.database instanceof VaultDatabase) {
      this.database.registerUserFunctions();
    }
  }

  /**
   * CREATE VIEW statements from API execute() calls may have been applied to
   * the worker database during background indexing, so replay them after the
   * main-thread database replaces it.
   *
   * Unlike syncCustomViewsToQueryMirror, per-view errors are swallowed here:
   * this replays onto the authoritative database, where one broken view should
   * not stop the remaining views from being restored. The mirror replay
   * propagates instead, because any divergence there must disable the mirror.
   */
  private async registerCustomViews(): Promise<void> {
    for (const [viewName, sql] of this.registeredCustomViews) {
      try {
        await this.database.run(`DROP VIEW IF EXISTS ${quoteIdentifier(viewName)}`);
        await this.database.run(sql);
      }
      catch (error) {
        logger.error(`Failed to register custom view "${viewName}"`, error);
      }
    }
  }

  private startInitialProviderRefreshWave(): void {
    if (this.providerRefreshWave) return;
    const refreshExistingQueries = QueryRefreshRegistry.hasEntries();
    const wave = this.tableProviderService.refreshStaleDefinitions();
    this.providerRefreshWave = wave;
    void wave
      .catch(error => logger.error('Provider TTL refresh failed after indexing', error))
      .finally(() => {
        if (this.providerRefreshWave === wave) {
          this.providerRefreshWave = null;
        }
        if (refreshExistingQueries) {
          void QueryRefreshRegistry.refreshAll({ force: true });
        }
      });
  }

  public async waitForInitialQueryReadiness(): Promise<void> {
    if (this.providerRefreshWave) {
      await this.providerRefreshWave;
    }
    if (this.providerMirrorSync) {
      await this.providerMirrorSync;
    }
  }

  private static createFileAdapter(app: App) {
    return {
      readBinary: (path: string) => app.vault.adapter.readBinary(path),
      writeBinary: (path: string, data: ArrayBuffer) => app.vault.adapter.writeBinary(path, data),
      exists: (path: string) => app.vault.adapter.exists(path),
      mkdir: (path: string) => app.vault.adapter.mkdir(path)
    };
  }

  private static getPluginDir(app: App) {
    return `${app.vault.configDir}/plugins/vaultquery`;
  }

  public static async create(app: App, settings: VaultQuerySettings, options: { eventBus?: EventBus<VaultQueryEvents> } = {}): Promise<VaultQueryAPI> {
    const useMemoryStorage = settings.databaseStorage === 'memory';
    const fileAdapter = useMemoryStorage ? null : VaultQueryAPI.createFileAdapter(app);
    const wasmAdapter = VaultQueryAPI.createFileAdapter(app);
    const pluginDir = VaultQueryAPI.getPluginDir(app);

    const backgroundIndexing = settings.backgroundIndexing;

    const triggerFunctions = new TriggerFunctions();

    let database: VaultDatabase | WorkerDatabase;
    let indexingWorker: WorkerDatabase | null = null;

    if (backgroundIndexing) {
      indexingWorker = await WorkerDatabase.create(
        app.vault.configDir,
        fileAdapter,
        useMemoryStorage,
        undefined,
        pluginDir,
        wasmAdapter,
        settings.wasm
      );
      database = indexingWorker;
    } else {
      database = await VaultDatabase.create(app, app.vault.configDir, {
        fileAdapter,
        useMemoryStorage,
        pluginDir,
        wasmAdapter,
        wasmSettings: settings.wasm
      });
      database.registerTriggerFunctions(triggerFunctions);
    }

    const indexingService = new IndexingService(app, database, settings);
    const writeSyncService = new WriteSyncService(app, database, settings);

    const api = new VaultQueryAPI(app, settings, database, indexingService, writeSyncService, triggerFunctions, options.eventBus);
    api.indexingWorker = indexingWorker;

    api.triggerService = new TriggerService({
      app,
      triggerFunctions,
      reindexFile: (path: string) => api.reindexNote(path)
    });

    return api;
  }

  /**
   * Transfer database from worker to main thread after indexing completes.
   * Only used when backgroundIndexing is enabled.
   */
  public async transferToMainThread(): Promise<void> {
    if (!this.indexingWorker) {
      return;
    }

    const data = await this.indexingWorker.exportDatabase();

    const useMemoryStorage = this.settings.databaseStorage === 'memory';
    const fileAdapter = useMemoryStorage ? null : VaultQueryAPI.createFileAdapter(this.app);
    const wasmAdapter = VaultQueryAPI.createFileAdapter(this.app);
    const pluginDir = VaultQueryAPI.getPluginDir(this.app);

    const mainThreadDb = await VaultDatabase.createFromBinary(this.app, this.app.vault.configDir, data, {
      fileAdapter,
      useMemoryStorage,
      pluginDir,
      wasmAdapter,
      wasmSettings: this.settings.wasm
    });

    await this.rebuildBootstrapNotePropertiesView(mainThreadDb);

    const finishedWorker = this.indexingWorker;
    this.indexingWorker = null;

    this.database = mainThreadDb;
    await this.tableProviderService.setDatabase(mainThreadDb);
    this.indexingService.setDatabase(mainThreadDb);
    this.writeSyncService.setDatabase(mainThreadDb);

    mainThreadDb.registerTriggerFunctions(this.triggerFunctions);

    await this.adoptQueryMirror(finishedWorker, mainThreadDb);
  }

  /**
   * A 25k-note SELECT blocks the UI for over a second when run on the main
   * thread, hence the mirror. The built-in resolve_link() is main-thread-only
   * (Obsidian API); queries using it error on the mirror and fall back.
   */
  private async adoptQueryMirror(worker: WorkerDatabase, mainThreadDb: VaultDatabase): Promise<void> {
    if (!this.settings.workerQueries) {
      await worker.close();
      return;
    }

    try {
      // Provider tables refresh against the main database only; serving their
      // disk-loaded rows from the mirror would be silently stale. Dropping them
      // makes provider queries error on the mirror and fall back to main.
      for (const tableName of this.tableProviderService.getRegisteredTableNames()) {
        await worker.run(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
      }
      if (this.settings.enabledFeatures.indexFrontmatter) {
        await worker.schema.rebuildPropertiesView();
      }
      if (this.settings.enableTriggers) {
        // No-op stubs for the trigger action functions: mirror-side trigger DDL
        // fires with identical SQL effects while file-writing actions run on the
        // main thread only (their file changes flow back via index forwarding).
        for (const name of TRIGGER_FUNCTION_NAMES) {
          await worker.registerCustomFunction(name, '() => 0');
        }
      }

      this.queryMirror = worker;
      this.queryMirrorDisabledReason = null;
      this.attachMirrorForwarding(mainThreadDb);
      logger.info('Query mirror active - read queries run off the main thread');
    } catch (error) {
      logger.warn('Query mirror setup failed - queries stay on the main thread', error);
      this.queryMirror = null;
      this.queryMirrorDisabledReason = `setup failed: ${getErrorMessage(error)}`;
      await VaultQueryAPI.closeQuietly(worker);
    }
  }

  private static async closeQuietly(mirror: WorkerDatabase): Promise<void> {
    await mirror.close().catch(() => undefined);
  }

  private attachMirrorForwarding(mainThreadDb: VaultDatabase): void {
    // Missing tables/views are expected (provider tables live main-side only);
    // a missing FUNCTION on a forwarded write means a trigger stub is absent and
    // the write was rejected - that is silent staleness, so it disables the mirror.
    const EXPECTED_DIVERGENCE = /no such (table|column|view)/i;
    const forward = (work: () => Promise<unknown>): (() => Promise<void>) | void => {
      if (!this.queryMirror) return;
      return async () => work().then(() => undefined).catch(error => {
        const message = getErrorMessage(error);
        if (EXPECTED_DIVERGENCE.test(message)) return;
        this.disableQueryMirror(`write forwarding failed: ${message}`);
      });
    };
    const mentionsProviderTable = (sql: string): boolean => {
      const lowered = sql.toLowerCase();
      return this.tableProviderService.getRegisteredTableNames().some(name => lowered.includes(name.toLowerCase()));
    };

    const originalIndexNote = mainThreadDb.indexNote.bind(mainThreadDb);
    mainThreadDb.indexNote = async (data) => {
      const result = await originalIndexNote(data);
      const forwarded = forward(() => this.queryMirror!.indexNote(data));
      // Note reindexes can drop mirror trigger DDL (the worker indexing path
      // stores but never activates triggers), so re-sync from main is required.
      if (forwarded) void forwarded().then(() => this.syncMirrorTriggers());
      return result;
    };

    const originalIndexBatch = mainThreadDb.indexNotesBatch.bind(mainThreadDb);
    mainThreadDb.indexNotesBatch = async (notesData, isInitialIndexing, skipDiskSave) => {
      const result = await originalIndexBatch(notesData, isInitialIndexing, skipDiskSave);
      const forwarded = forward(() => this.queryMirror!.indexNotesBatch(notesData, isInitialIndexing ?? false, true));
      if (forwarded) void forwarded().then(() => this.syncMirrorTriggers());
      return result;
    };

    const originalRun = mainThreadDb.run.bind(mainThreadDb);
    mainThreadDb.run = async (sql, params) => {
      const result = await originalRun(sql, params);
      if (!mentionsProviderTable(sql)) {
        const forwarded = forward(() => this.queryMirror!.run(sql, params));
        // execute() callers commonly query a newly-created view immediately;
        // do not return until the mirror has applied the same schema change.
        if (forwarded) await forwarded();
      }
      return result;
    };
  }

  private async syncMirrorTriggers(): Promise<void> {
    const mirror = this.queryMirror;
    if (!mirror || !this.settings.enableTriggers) return;
    try {
      const mirrorTriggers = await mirror.all(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_vq_user_%'`);
      for (const row of mirrorTriggers) {
        await mirror.run(`DROP TRIGGER IF EXISTS ${quoteIdentifier(String(row.name))}`);
      }
      const mainTriggers = await this.database.all(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_vq_user_%'`);
      for (const row of mainTriggers) {
        if (typeof row.sql === 'string' && row.sql) {
          await mirror.run(row.sql);
        }
      }
    } catch (error) {
      this.disableQueryMirror(`trigger sync failed: ${getErrorMessage(error)}`);
    }
  }

  private async queueProviderTableMirrorSync(tableNames: string[]): Promise<void> {
    const previous = this.providerMirrorSync ?? Promise.resolve();
    const sync = previous.catch(() => undefined).then(() => this.syncProviderTablesToQueryMirror(tableNames));
    this.providerMirrorSync = sync;
    try {
      await sync;
    } finally {
      if (this.providerMirrorSync === sync) {
        this.providerMirrorSync = null;
      }
    }
  }

  private async syncProviderTablesToQueryMirror(tableNames: string[]): Promise<void> {
    const mirror = this.queryMirror;
    if (!mirror || tableNames.length === 0) return;

    const registered = new Set(this.tableProviderService.getRegisteredTableNames());
    const tables = Array.from(new Set(tableNames)).filter(tableName => registered.has(tableName));
    if (tables.length === 0) return;

    const startedAt = performance.now();
    let rowCount = 0;
    try {
      await mirror.withTx(async () => {
        for (const tableName of tables) {
          const quotedTable = quoteIdentifier(tableName);
          const schemaRows = await this.database.all(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? AND sql IS NOT NULL`,
            [tableName]
          );
          const createSql = schemaRows[0]?.sql;
          if (typeof createSql !== 'string' || !createSql) {
            throw new Error(`Provider table schema is missing: ${tableName}`);
          }

          const indexRows = await this.database.all(
            `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`,
            [tableName]
          );
          const rows = await this.database.all(`SELECT * FROM ${quotedTable}`);

          await mirror.run(`DROP TABLE IF EXISTS ${quotedTable}`);
          await mirror.run(createSql);

          if (rows.length > 0) {
            const columns = Object.keys(rows[0]);
            const quotedColumns = columns.map(quoteIdentifier).join(', ');
            const paramRows = rows.map(row => columns.map((column): string | number | null => {
              const value = row[column];
              if (value === null) return null;
              if (typeof value === 'string' || typeof value === 'number') return value;
              throw new Error(`Unsupported provider mirror value in ${tableName}.${column}`);
            }));
            await insertRowsChunked(
              mirror,
              placeholders => `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${placeholders}`,
              paramRows,
              columns.length
            );
          }

          for (const indexRow of indexRows) {
            if (typeof indexRow.sql === 'string' && indexRow.sql) {
              await mirror.run(indexRow.sql);
            }
          }
          rowCount += rows.length;
        }
      });
      await this.syncCustomViewsToQueryMirror(mirror);
      logger.debug('Provider query mirror synchronized', {
        tables,
        rows: rowCount,
        syncMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      this.disableQueryMirror(`provider table sync failed: ${getErrorMessage(error)}`);
    }
  }

  private async syncCustomViewsToQueryMirror(mirror: WorkerDatabase): Promise<void> {
    for (const [viewName, sql] of this.registeredCustomViews) {
      await mirror.run(`DROP VIEW IF EXISTS ${quoteIdentifier(viewName)}`);
      await mirror.run(sql);
    }
  }

  private disableQueryMirror(reason: string): void {
    const mirror = this.queryMirror;
    if (!mirror) return;
    this.queryMirror = null;
    this.queryMirrorDisabledReason = reason;
    logger.warn(`Query mirror disabled - ${reason}; queries run on the main thread`);
    void VaultQueryAPI.closeQuietly(mirror);
  }

  public getQueryMirrorStatus(): QueryMirrorStatus {
    if (this.queryMirror) return { active: true };
    return { active: false, reason: this.queryMirrorDisabledReason ?? 'not started' };
  }

  private async rebuildBootstrapNotePropertiesView(database: VaultDatabase): Promise<void> {
    if (!this.settings.enabledFeatures.indexFrontmatter) {
      return;
    }

    const columns = database.schema.getViewColumns('note_properties');
    if (columns.includes('key') && columns.includes('value') && columns.includes('value_type')) {
      database.schema.rebuildPropertiesView();
      await database.saveToDisk();
    }
  }

  public async reindexVault(): Promise<void> {
    // Full reindexes can rewrite schema and bulk data on the main database;
    // per-note forwarding cannot keep the mirror coherent through that.
    this.disableQueryMirror('full vault reindex');
    return this.indexingService.reindexVault();
  }

  public async forceReindexVault(): Promise<void> {
    this.disableQueryMirror('forced full vault reindex');
    return this.indexingService.forceReindexVault();
  }

  public async reindexNote(notePath: string): Promise<void> {
    return this.indexingService.reindexNote(notePath);
  }

  public async indexNote(file: TFile, content?: string): Promise<void> {
    return this.indexingService.indexNote(file, content);
  }

  public getIndexingStatus(): IndexingStatus {
    return this.indexingService.getIndexingStatus();
  }

  public async waitForIndexing(timeoutMs?: number): Promise<void> {
    return this.indexingService.waitForIndexing(timeoutMs);
  }

  public setIndexingStatus(isIndexing: boolean): void {
    this.indexingService.setIndexingStatus(isIndexing);
  }

  public async removeNote(notePath: string): Promise<void> {
    await this.indexingService.removeNote(notePath);
  }

  public async saveToDisk(): Promise<void> {
    return this.database.saveToDisk();
  }

  public shouldIndexFile(file: TFile): boolean {
    return this.indexingService.shouldIndexFile(file);
  }

  public getPerformanceStats(): IndexingStats | null {
    return this.indexingService.getPerformanceStats();
  }

  public async rebuildTableViews(): Promise<void> {
    await this.database.schema.rebuildTableViews(this.settings.enableDynamicTableViews);
  }

  public async execute(sql: string): Promise<number> {
    // Allow DDL operations (CREATE INDEX, CREATE VIEW, etc.) through execute()
    if (this.containsBlockedSQL(sql, true)) {
      throw new Error(ERROR_MESSAGES.QUERY_UNSAFE_OPERATIONS);
    }

    const customViewRegistration = this.getCustomViewRegistration(sql);
    const droppedCustomViewName = this.getDroppedCustomViewName(sql);
    const previousViewSql = customViewRegistration
      ? this.registeredCustomViews.get(customViewRegistration.viewName)
      : undefined;

    if (customViewRegistration) {
      this.registeredCustomViews.set(customViewRegistration.viewName, customViewRegistration.sql);
    }

    try {
      const rowsModified = await this.database.run(sql);

      if (droppedCustomViewName) {
        this.registeredCustomViews.delete(droppedCustomViewName);
      }

      return rowsModified;
    }
    catch (error) {
      if (customViewRegistration) {
        if (previousViewSql !== undefined) {
          this.registeredCustomViews.set(customViewRegistration.viewName, previousViewSql);
        }
        else {
          this.registeredCustomViews.delete(customViewRegistration.viewName);
        }
      }

      throw error;
    }
  }

  private getCustomViewRegistration(sql: string): { viewName: string; sql: string } | null {
    const statement = stripSqlComments(sql);
    if (!/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\b/i.test(statement)) {
      return null;
    }

    const normalizedStatement = statement.replace(/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\b/i, 'CREATE VIEW');
    const viewName = parseSQLObjectName(normalizedStatement, 'VIEW');
    if (!viewName) {
      return null;
    }

    return { viewName, sql: statement };
  }

  private getDroppedCustomViewName(sql: string): string | null {
    return parseDroppedSQLObjectName(stripSqlComments(sql), 'VIEW');
  }

  public setProviderBlockLanguageRegistrar(registerBlockLanguage: (language: string) => void): void {
    this.tableProviderService.setBlockLanguageRegistrar(registerBlockLanguage);
  }

  public setThirdPartyProviderTablesEnabled(enabled: boolean): void {
    this.tableProviderService.setEnabled(enabled);
  }

  public async registerTableProvider(provider: VaultQueryTableProvider): Promise<TableProviderRegistration> {
    return await this.tableProviderService.registerProvider(provider);
  }

  public getRegisteredTableProviders(): VaultQueryTableProvider[] {
    return this.tableProviderService.getRegisteredProviders();
  }

  public async unregisterTableProvider(providerId: string): Promise<void> {
    this.tableProviderService.unregisterProvider(providerId);
  }

  public async getTableProviderStatus(providerId?: string): Promise<TableProviderStatus[]> {
    return this.tableProviderService.getStatus(providerId);
  }

  public getProviderDefinitionCompletions(language: string): ProviderDefinitionCompletionConfig | null {
    return this.tableProviderService.getProviderDefinitionCompletions(language);
  }

  public async renderTableProviderDefinitionBlock(language: string, source: string, container: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    await this.tableProviderService.renderDefinitionBlock(language, source, container, ctx);
  }

  public getCapabilities(): VaultQueryCapabilities {
    return {
      writeEnabled: this.settings.allowWriteOperations,
      fileDeleteEnabled: this.settings.allowDeleteNotes,
      thirdPartyProviderTablesEnabled: this.settings.enableThirdPartyProviderTables,
      indexing: {
        content: this.settings.enabledFeatures.indexContent,
        frontmatter: this.settings.enabledFeatures.indexFrontmatter,
        tables: this.settings.enabledFeatures.indexTables,
        tasks: this.settings.enabledFeatures.indexTasks,
        headings: this.settings.enabledFeatures.indexHeadings,
        links: this.settings.enabledFeatures.indexLinks,
        unresolvedLinks: this.settings.enabledFeatures.indexUnresolvedLinks,
        embeds: this.settings.enabledFeatures.indexEmbeds,
        tags: this.settings.enabledFeatures.indexTags,
        blocks: this.settings.enabledFeatures.indexBlocks,
        listItems: this.settings.enabledFeatures.indexListItems,
      },
    };
  }

  public async registerCustomFunction(name: string, source: string): Promise<void> {
    if (!this.settings.enableJavaScriptFunctions) {
      throw new Error('JavaScript SQL functions are disabled in VaultQuery settings.');
    }

    await this.database.registerCustomFunction(name, source);
  }

  /**
   * Check if a view needs to be recreated (SQL has changed).
   */
  public viewNeedsRecreation(viewName: string, newSql: string): boolean {
    return this.database.viewNeedsRecreation(viewName, newSql);
  }

  /**
   * Check if a function needs to be recreated (source has changed).
   */
  public functionNeedsRecreation(functionName: string, newSource: string): boolean {
    return this.database.functionNeedsRecreation(functionName, newSource);
  }

  /**
   * Check if a trigger needs to be recreated (SQL has changed).
   */
  public triggerNeedsRecreation(triggerName: string, newSql: string): boolean {
    return this.database.triggerNeedsRecreation(triggerName, newSql);
  }

  /**
   * Get all user-defined views from the database.
   * These are discovered from vaultquery-view code blocks during indexing.
   */
  public async getAllUserViews(): Promise<Array<{view_name: string; path: string; sql: string}>> {
    return await this.database.getAllUserViews();
  }

  /**
   * Get all user-defined functions from the database.
   * These are discovered from vaultquery-function code blocks during indexing.
   */
  public async getAllUserFunctions(): Promise<Array<{function_name: string; path: string; source: string}>> {
    return await this.database.getAllUserFunctions();
  }

  /**
   * Get all user-defined triggers from the database.
   * These are discovered from vaultquery-trigger code blocks during indexing.
   */
  public async getAllUserTriggers(): Promise<Array<{trigger_name: string; path: string; trigger_sql: string; enabled: number}>> {
    return await this.database.getAllUserTriggers();
  }

  /**
   * Register a trigger at render time.
   * Called by TriggerCodeBlockProcessor when a trigger block is rendered.
   */
  public async registerTrigger(triggerName: string, triggerSql: string, sourcePath?: string): Promise<void> {
    await this.database.registerTrigger(triggerName, triggerSql, sourcePath);
  }

  public async query(sql: string, noteSource?: NoteSource): Promise<QueryResult[]> {
    if (noteSource) {
      sql = await resolveQueryTemplate(sql, this.app, noteSource);
    }

    if (this.containsBlockedSQL(sql, false)) {
      throw new Error(ERROR_MESSAGES.QUERY_UNSAFE_OPERATIONS);
    }

    const unindexedDataWarning = this.checkForUnindexedData(sql);
    if (unindexedDataWarning) {
      throw new Error(unindexedDataWarning);
    }

    // Don't wait for indexing - queries can run with partial data
    // Users see results immediately and can refresh after indexing completes

    if (this.providerMirrorSync) {
      await this.providerMirrorSync;
    }
    if (this.providerRefreshWave && this.queryDependsOnProviderReadiness(sql)) {
      await this.providerRefreshWave;
    }

    if (this.queryMirror) {
      try {
        return await this.queryMirror.all(sql) as QueryResult[];
      } catch (error) {
        const message = getErrorMessage(error);
        // Missing tables/functions/columns are EXPECTED on the mirror (provider
        // tables, post-boot views/functions live on the main database only).
        if (/no such (table|function|column|view)/i.test(message)) {
          logger.debug('Query mirror cannot serve this query - falling back to main thread', { message });
        } else {
          this.disableQueryMirror(`query failed: ${message}`);
        }
      }
    }

    return await this.executeQuerySafely(() => this.database.all(sql)) as QueryResult[];
  }

  private queryDependsOnProviderReadiness(sql: string): boolean {
    const referencedTables = this.getSqlAnalysis(sql).referencedTables;
    const dependencies = new Set([
      ...this.tableProviderService.getRegisteredTableNames(),
      ...this.registeredCustomViews.keys(),
    ].map(name => name.toLowerCase()));
    for (const tableName of referencedTables) {
      if (dependencies.has(tableName.toLowerCase())) return true;
    }
    return false;
  }


  public async getIndexedFiles(): Promise<Array<{ path: string; modified: number }>> {
    return getIndexedFilesFromDatabase(this.database);
  }

  public async needsIndexing(file: TFile): Promise<boolean> {
    try {
      const results = await this.database.all('SELECT modified FROM notes WHERE path = ?', [file.path]);
      if (results.length > 0) {
        const dbModified = results[0].modified as number;
        return file.stat.mtime !== dbModified;
      }
      else {
        return true;
      }
    }
    catch (error) {
      logger.error('Error checking if file needs indexing', error);
      return true;
    }
  }

  public async close(): Promise<void> {
    try {
      if (this.triggerService) {
        this.triggerService.destroy();
      }
      if (this.queryMirror) {
        const mirror = this.queryMirror;
        this.queryMirror = null;
        this.queryMirrorDisabledReason = 'plugin shutdown';
        await VaultQueryAPI.closeQuietly(mirror);
      }
      await this.database.close();
    }
    finally {
      CustomSQLFunctions.clearSyncHandlers();
    }
  }

  public async checkDatabaseHealthAsync(): Promise<DatabaseHealth> {
    return this.database.checkHealth();
  }

  public async getSchemaInfo(): Promise<string> {
    const sections: string[] = [];

    sections.push(renderSchemaTableDoc('notes', NOTES_COLUMNS));

    if (this.settings.enabledFeatures.indexFrontmatter) {
      sections.push(renderSchemaTableDoc('properties', PROPERTIES_COLUMNS));

      const viewColumns = await this.database.schema.getViewColumns('notes_with_properties');
      if (viewColumns.length > 0) {
        const viewCols = viewColumns.map((col: string) => ({
          name: col,
          type: ['path', 'title', 'content'].includes(col) ? 'TEXT' :
                ['created', 'modified', 'size'].includes(col) ? 'INTEGER' : 'TEXT',
          description: ['path', 'title', 'content', 'created', 'modified', 'size'].includes(col)
            ? '(from notes)' : '(property column)',
        }));
        sections.push(renderSchemaTableDoc('notes_with_properties', viewCols, true) +
          '\n> Supports INSERT, UPDATE, DELETE (syncs to frontmatter)\n');
      }

      const notePropsColumns = await this.database.schema.getViewColumns('note_properties');
      if (notePropsColumns.length > 0) {
        const notePropsViewCols = notePropsColumns.map((col: string) => ({
          name: col,
          type: 'TEXT',
          description: col === 'path' ? 'File path' : '(property column)',
        }));
        sections.push(renderSchemaTableDoc('note_properties', notePropsViewCols, true) +
          '\n> Properties only (no notes columns). Supports INSERT (existing notes only), UPDATE, DELETE.\n');
      }
    }

    if (this.settings.enabledFeatures.indexTasks) {
      sections.push(renderSchemaTableDoc('tasks', taskColumnDocs()));
      sections.push(renderSchemaTableDoc('tasks_view', TASKS_VIEW_COLUMNS, true) +
        '\n> Supports INSERT, UPDATE, DELETE. When no tasks exist, new tasks insert at line 1 (beginning of file).\n');
    }

    if (this.settings.enabledFeatures.indexHeadings) {
      sections.push(renderSchemaTableDoc('headings', HEADINGS_COLUMNS));
      sections.push(renderSchemaTableDoc('headings_view', HEADINGS_VIEW_COLUMNS, true) +
        '\n> Supports INSERT, UPDATE, DELETE. When no headings exist, new headings insert at line 1 (beginning of file).\n');
    }

    if (this.settings.enabledFeatures.indexTags) {
      sections.push(renderSchemaTableDoc('tags', TAGS_COLUMNS));
    }

    if (this.settings.enabledFeatures.indexLinks) {
      sections.push(renderSchemaTableDoc('links', LINKS_COLUMNS));
    }

    if (this.settings.enabledFeatures.indexUnresolvedLinks) {
      sections.push(renderSchemaTableDoc('unresolved_links', UNRESOLVED_LINKS_COLUMNS));
    }

    if (this.settings.enabledFeatures.indexEmbeds) {
      sections.push(renderSchemaTableDoc('embeds', EMBEDS_COLUMNS));
    }

    if (this.settings.enabledFeatures.indexBlocks) {
      sections.push(renderSchemaTableDoc('blocks', BLOCKS_COLUMNS));
    }

    if (this.settings.enabledFeatures.indexListItems) {
      sections.push(renderSchemaTableDoc('list_items', LIST_ITEMS_COLUMNS));
      sections.push(renderSchemaTableDoc('list_items_view', LIST_ITEMS_VIEW_COLUMNS, true) +
        '\n> Supports INSERT, UPDATE, DELETE. When no list items exist, new items insert at line 1 (beginning of file).\n');
    }

    if (this.settings.enabledFeatures.indexTables) {
      sections.push(renderSchemaTableDoc('table_cells', TABLE_CELLS_COLUMNS));
      sections.push(renderSchemaTableDoc('table_rows', TABLE_ROWS_COLUMNS, true) +
        '\n> Supports INSERT, UPDATE, DELETE\n');
    }

    const views = await this.database.schema.getViewNames();
    const builtInViews = ['notes_with_properties', 'headings_view', 'list_items_view', 'tasks_view', 'table_rows', 'table_columns', 'note_properties'];
    const dynamicViews = views.filter((v: string) => !builtInViews.includes(v));
    if (dynamicViews.length > 0) {
      sections.push('## Dynamic Table Views\n');
      sections.push('> These views are auto-generated from markdown tables in the vault. Enable "Dynamic table views" in settings.\n');
      for (const viewName of dynamicViews) {
        const viewColumns = await this.database.schema.getViewColumns(viewName);
        if (viewColumns.length > 0) {
          const viewCols = viewColumns.map((col: string) => ({
            name: col,
            type: ['path', 'table_name'].includes(col) ? 'TEXT' :
                  ['table_index', 'row_index'].includes(col) ? 'INTEGER' : 'TEXT',
            description: ['path', 'table_index', 'row_index', 'table_name'].includes(col)
              ? '(metadata)' : '(table column)',
          }));
          sections.push(renderSchemaTableDoc(viewName, viewCols, true) + '\n> Supports INSERT, UPDATE, DELETE\n');
        }
      }
    }

    const disabledFeatures: string[] = [];
    if (!this.settings.enabledFeatures.indexFrontmatter) disabledFeatures.push('properties');
    if (!this.settings.enabledFeatures.indexTables) disabledFeatures.push('table_cells');
    if (!this.settings.enabledFeatures.indexTasks) disabledFeatures.push('tasks');
    if (!this.settings.enabledFeatures.indexHeadings) disabledFeatures.push('headings');
    if (!this.settings.enabledFeatures.indexLinks) disabledFeatures.push('links');
    if (!this.settings.enabledFeatures.indexUnresolvedLinks) disabledFeatures.push('unresolved_links');
    if (!this.settings.enabledFeatures.indexEmbeds) disabledFeatures.push('embeds');
    if (!this.settings.enabledFeatures.indexTags) disabledFeatures.push('tags');
    if (!this.settings.enabledFeatures.indexBlocks) disabledFeatures.push('blocks');
    if (!this.settings.enabledFeatures.indexListItems) disabledFeatures.push('list_items');
    if (disabledFeatures.length > 0) {
      sections.push(`\n> [!note] Disabled Tables\n> ${disabledFeatures.join(', ')} - enable in Settings → VaultQuery\n`);
    }

    const providerSchema = this.tableProviderService.getSchemaMarkdown();
    if (providerSchema) {
      sections.push(providerSchema);
    }

    return sections.join('\n');
  }

  public async getAutocompleteSchema(): Promise<AutocompleteSchemaShape> {
    const relationRows = await this.database.all(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name"
    ) as Array<{ name?: unknown; type?: unknown }>;

    const relations = relationRows
      .map((row) => ({
        name: typeof row.name === 'string' ? row.name : '',
        type: row.type === 'view' ? 'view' as const : 'table' as const,
      }))
      .filter((row) => this.shouldIncludeAutocompleteRelation(row));

    // Fire all PRAGMA lookups together: in worker mode each is a message
    // round-trip, so sequential awaits serialize dozens of hops.
    const pragmaResults = await Promise.all(relations.map(async (relation) => {
      try {
        const pragmaRows = await this.database.all(
          `PRAGMA table_info(${quoteIdentifier(relation.name)})`
        ) as Array<{ name?: unknown; type?: unknown }>;
        return { relationName: relation.name, pragmaRows };
      }
      catch {
        return { relationName: relation.name, pragmaRows: [] as Array<{ name?: unknown; type?: unknown }> };
      }
    }));

    const columns: AutocompleteSchemaColumnInfo[] = [];
    for (const { relationName, pragmaRows } of pragmaResults) {
      for (const row of pragmaRows) {
        if (typeof row.name !== 'string' || !row.name) {
          continue;
        }

        columns.push({
          relation: relationName,
          name: row.name,
          type: typeof row.type === 'string' ? row.type : '',
        });
      }
    }

    let functions: string[] = [];
    try {
      const functionRows = await this.database.all(
        'SELECT function_name FROM _user_functions ORDER BY function_name'
      ) as Array<{ function_name?: unknown }>;

      functions = functionRows
        .map((row) => typeof row.function_name === 'string' ? row.function_name : '')
        .filter((name) => name.length > 0);
    }
    catch {
      functions = [];
    }

    // Provider tables that exist only as declarations (never refreshed yet)
    // are invisible to sqlite_master; merge them so first-query autocomplete works.
    return mergeDeclaredProviderTables({ relations, columns, functions }, this.tableProviderService.getDeclaredTables());
  }

  private shouldIncludeAutocompleteRelation(relation: AutocompleteSchemaRelationInfo): boolean {
    if (!relation.name || relation.name.startsWith('_') || relation.name.startsWith('sqlite_')) {
      return false;
    }

    const config = TABLE_FEATURE_CONFIG[relation.name];
    if (!config) {
      return true;
    }

    return this.settings.enabledFeatures[config.setting];
  }

  private async executeQuerySafely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    }
    catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      const missingTable = this.getMissingTableName(errorMessage);
      if (missingTable && await this.waitForProviderTableIfRegistering(missingTable)) {
        logger.debug(`Retrying query after provider table became available: ${missingTable}`);
        return await this.retryQueryWithFriendlyError(operation);
      }

      const friendlyError = this.getFriendlyErrorMessage(errorMessage);
      throw new Error(friendlyError);
    }
  }

  private async retryQueryWithFriendlyError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    }
    catch (error: unknown) {
      throw new Error(this.getFriendlyErrorMessage(getErrorMessage(error)));
    }
  }

  private getMissingTableName(errorMessage: string): string | null {
    if (errorMessage.includes('no such table')) {
      const tableMatch = errorMessage.match(/no such table: (\w+)/);
      return tableMatch?.[1]?.toLowerCase() ?? null;
    }

    return null;
  }

  private async waitForProviderTableIfRegistering(tableName: string): Promise<boolean> {
    if (!this.settings.enableThirdPartyProviderTables || TABLE_FEATURE_CONFIG[tableName]) {
      return false;
    }

    for (let remainingMs = PROVIDER_TABLE_RETRY_TIMEOUT_MS; remainingMs > 0; remainingMs -= PROVIDER_TABLE_RETRY_INTERVAL_MS) {
      try {
        if (await relationExists(this.database, tableName, { matchViewsCaseInsensitive: true })) {
          return true;
        }
      }
      catch (error) {
        logger.warn(`Provider table availability check failed for "${tableName}"`, error);
        return false;
      }

      await new Promise<void>(resolve => window.setTimeout(resolve, PROVIDER_TABLE_RETRY_INTERVAL_MS));
    }

    return false;
  }

  private getFriendlyErrorMessage(errorMessage: string): string {
    const tableName = this.getMissingTableName(errorMessage);
    if (tableName) {
      const config = TABLE_FEATURE_CONFIG[tableName];
      if (config && !this.settings.enabledFeatures[config.setting]) {
        return `${errorMessage}\n\nNote: ${config.featureName} is disabled. Enable it in Settings → VaultQuery → ${config.settingLabel}`;
      }

      if (this.settings.enableThirdPartyProviderTables) {
        return `${errorMessage}\n\nNote: If "${tableName}" is provided by another plugin, its table provider may still be registering. Refresh the block after provider registration completes.`;
      }
    }

    return errorMessage;
  }

  private getSqlAnalysis(sql: string): { stripped: string; referencedTables: Set<string> } {
    const cached = this.sqlAnalysisCache.get(sql);
    if (cached) {
      // Refresh insertion order so eviction below is least-recently-used.
      this.sqlAnalysisCache.delete(sql);
      this.sqlAnalysisCache.set(sql, cached);
      return cached;
    }

    const stripped = stripSqlStringLiterals(stripSqlComments(sql));
    const analysis = { stripped, referencedTables: VaultQueryAPI.extractReferencedTables(stripped) };

    this.sqlAnalysisCache.set(sql, analysis);
    while (this.sqlAnalysisCache.size > VaultQueryAPI.SQL_ANALYSIS_CACHE_LIMIT) {
      const oldestKey = this.sqlAnalysisCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.sqlAnalysisCache.delete(oldestKey);
    }

    return analysis;
  }

  private static extractReferencedTables(strippedSql: string): Set<string> {
    const tableMatches = strippedSql.match(/(?:FROM|JOIN)\s+(\w+)/gi);
    if (!tableMatches) return new Set();

    return tableMatches
      .map(match => match.replace(/(?:FROM|JOIN)\s+/i, '').toLowerCase())
      .reduce((set, name) => set.add(name), new Set<string>());
  }

  private checkForUnindexedData(sql: string): string | null {
    const tableNames = this.getSqlAnalysis(sql).referencedTables;

    const warnings = Object.entries(TABLE_FEATURE_CONFIG)
      .filter(([table, config]) =>
        tableNames.has(table) && !this.settings.enabledFeatures[config.setting])
      .map(([table, config]) =>
        `${table.charAt(0).toUpperCase() + table.slice(1)} table is referenced but ${config.featureName.toLowerCase()} is disabled. Enable it in Settings → VaultQuery → ${config.settingLabel}`
      );

    return warnings.length > 0 ? warnings.join('\n\n') : null;
  }

  public async previewQuery(sql: string, params: unknown[] = [], noteSource?: NoteSource): Promise<PreviewResult> {
    if (noteSource) {
      sql = await resolveQueryTemplate(sql, this.app, noteSource);
    }

    if (this.containsBlockedSQL(sql, true)) {
      throw new Error(ERROR_MESSAGES.PREVIEW_UNSAFE_OPERATIONS);
    }

    if (!this.settings.allowWriteOperations) {
      throw new Error(ERROR_MESSAGES.WRITE_OPERATIONS_DISABLED);
    }

    // Don't wait for indexing - previews are read-only (they rollback)
    // and can work with partial data

    if (!(this.database instanceof VaultDatabase)) {
      throw new Error('Preview is not supported in web worker mode');
    }

    try {
      const result = await this.database.previewDML(sql, params);

      this.validatePreviewResult(result);

      return result;
    }
    catch (error: unknown) {
      // Don't log syntax errors to console - they're expected during editing
      throw new Error(ERROR_MESSAGES.PREVIEW_FAILED(getErrorMessage(error)));
    }
  }

  /**
   * Validate preview result against actual vault state.
   * Throws if there are conflicts that would cause apply to fail.
   */
  private validatePreviewResult(result: PreviewResult): void {
    const errors: string[] = [];

    const validateSingleResult = (r: PreviewResult) => {
      if (r.table === 'notes' || r.table === 'notes_with_properties') {
        for (const row of r.after) {
          if (row.path) {
            const pathStr = formatUnknownValue(row.path);
            const file = this.app.vault.getAbstractFileByPath(normalizePath(pathStr));
            if (file && r.op === 'insert') {
              errors.push(`File already exists: ${pathStr}`);
            }
          }
        }
      }
    };

    if (result.op === 'multi' && result.multiResults) {
      result.multiResults.forEach(validateSingleResult);
    } else {
      validateSingleResult(result);
    }

    if (errors.length > 0) {
      throw new Error(errors.join('\n'));
    }
  }

  public async applyPreview(previewResult: PreviewResult): Promise<string[]> {
    if (!this.settings.allowWriteOperations) {
      throw new Error(ERROR_MESSAGES.WRITE_OPERATIONS_DISABLED_APPLY);
    }

    if (!(this.database instanceof VaultDatabase)) {
      throw new Error('Apply preview is not supported in web worker mode');
    }

    // Don't wait for indexing - user clicked Apply on an already-generated preview
    // The preview data is already captured; just apply it

    let affectedPaths: string[] = [];
    try {
      affectedPaths = await this.writeSyncService.syncChanges(previewResult);
      await this.database.applyDML(previewResult);
      await this.processPendingTriggerActions();
    }
    catch (error: unknown) {
      logger.error('Could not apply preview', error);
      throw new Error(ERROR_MESSAGES.APPLY_FAILED(getErrorMessage(error)));
    }

    return affectedPaths;
  }

  private containsBlockedSQL(sql: string, allowWriteOperations: boolean = false): boolean {
    return containsBlockedSqlInStripped(this.getSqlAnalysis(sql).stripped, allowWriteOperations);
  }


  public on(event: 'file-indexed', callback: (event: FileIndexedEvent) => void): EventRef;
  public on(event: 'file-removed', callback: (event: FileRemovedEvent) => void): EventRef;
  public on(event: 'vault-indexed', callback: (event: VaultIndexedEvent) => void): EventRef;
  public on(event: 'database-lost', callback: (event: DatabaseLostEvent) => void): EventRef;
  public on(event: 'database-restored', callback: (event: DatabaseRestoredEvent) => void): EventRef;
  public on(event: 'provider-tables-changed', callback: (event: ProviderTablesChangedEvent) => void): EventRef;
  public on<EventName extends keyof VaultQueryEvents>(
    event: EventName,
    callback: (event: VaultQueryEvents[EventName]) => void
  ): EventRef {
    return this.eventBus.on(event, callback);
  }

  public off(ref: EventRef): void {
    this.eventBus.off(ref);
  }

  /**
   * Internal: used by DatabaseRecoveryManager to carry subscriptions over to
   * the replacement API instance after database loss.
   */
  public getEventBus(): EventBus<VaultQueryEvents> {
    return this.eventBus;
  }

  /**
   * Emit database lost event (called by plugin when database loss is detected).
   * Third-party plugins should reset any cached state that depends on the database.
   */
  public emitDatabaseLost(error: string): void {
    this.emit('database-lost', { error, timestamp: Date.now() });
  }

  /**
   * Emit database restored event (called by plugin after successful recovery).
   * Third-party plugins can resume normal operations.
   */
  public emitDatabaseRestored(): void {
    this.emit('database-restored', { timestamp: Date.now() });
  }

  private emit<EventName extends keyof VaultQueryEvents>(
    event: EventName,
    data: VaultQueryEvents[EventName]
  ): void {
    this.eventBus.emit(event, data);
  }

}
