import { isDataFilePath } from './Tabular/TabularTableOwnership';
import { pathExtension } from './utils/PathUtils';
import type { QueryValue } from './Database/QueryValues';
import { awaitQueryOperation, consumeQuerySnapshot, QueryIterationInvalidatedError, throwIfQueryAborted } from './Database/QueryIteration';
import type { QueryIterationOptions } from './Database/QueryIteration';
import { App, MarkdownPostProcessorContext, TFile, normalizePath, requestUrl } from 'obsidian';
import { VaultDatabase } from './Database/DatabaseService';
import { WorkerDatabase, WorkerUnavailableError } from './Database/WorkerDatabaseService';
import { DataFileIndexingService, csvPublicationPath } from './Tabular/TabularIndexingService';
import { PathExclusions } from './utils/PathExclusions';
import { CsvQueryDependencies } from './Tabular/TabularQueryDependencies';
import type { CsvQueryDependenciesResult } from './Tabular/TabularQueryDependencies';
import { dataFileParseLimits } from './Tabular/TabularLimits';
import { ProviderSnapshotCoordinator } from './Providers/ProviderSnapshotCoordinator';
import { createWebDataProvider, webProviderId } from './Providers/WebDataProvider';
import { NativeWebCsvTransport } from './Providers/WebCsvTransport';
import { publishProviderSnapshots } from './Providers/ProviderSnapshotMirror';
import { extractSqlDdlObject, splitSqlStatements } from './utils/SQLParsingUtils';
import type { IndexedDataFile } from './Tabular/TabularDatabaseOperations';
import { publishCsvToMirror } from './Tabular/TabularMirrorPublisher';
import { dataFileSchemaTables } from './Tabular/TabularSchema';
import { CsvWriteService, csvWriteTarget } from './Tabular/TabularWriteService';
import { PreparedFileWriteRegistry } from './WriteSync/PreparedFileWriteRegistry';
import { FilePreviewStaleError, FileWriteApplyError } from './WriteSync/FileWriteTypes';
import { OtherFileWriteService } from './OtherFiles/OtherFileWriteService';
import { otherFileWriteStatements } from './utils/SQLParsingUtils';
import { assertDataFileReads } from './Tabular/TabularAccess';
import { VaultQuerySettings, EnabledFeatures } from './Settings/Settings';
import { IndexingService } from './Services/IndexingService';
import type { PreparedMarkdownChanges } from './Services/WriteSyncService';
import { WriteSyncService } from './Services/WriteSyncService';
import { TriggerFunctions, TriggerService, TRIGGER_FUNCTION_NAMES } from './Triggers';
import { resolveQueryTemplate } from './Services/QueryTemplator';
import { getErrorMessage, ERROR_MESSAGES } from './utils/ErrorMessages';
import { quoteIdentifier, sqliteIdentifierKey } from './utils/SqlIdentifierUtils';
import { detectDmlOperationInSql, detectSqlOperation, disallowedSqlStatement, extractSqlMutationTarget, extractSqlReferencedTables, hasSqlActionFunctions, hasSqlFileActionFunctions, isSelectOnly, parseDroppedSQLObjectName, parseSQLObjectName, stripSqlComments } from './utils/SQLParsingUtils';
import type { IndexingStats, IndexingStatus, NoteSource } from './types';
import type { PreviewResult } from './Services/PreviewService';
import { copyPreviewForApply } from './Services/PreviewService';
import { TableProviderService } from './Providers/TableProviderService';
import { QueryRefreshRegistry } from './Renderers/QueryRefreshRegistry';
import { getIndexedFilesFromDatabase } from './Database/IndexedFiles';
import { describeAutocompleteSchema, mergeDeclaredProviderTables } from './utils/AutocompleteSchemaUtils';
import { renderSchemaTables } from './Database/SchemaDocumentation';
import type { SchemaTable } from './Database/SchemaDocumentation';
import { schemaTables, disabledSchemaTables, CachedSchemaViews } from './Database/SchemaMarkdown';
import type { SchemaViews } from './Database/SchemaMarkdown';
import type { AutocompleteSchemaColumnInfo, AutocompleteSchemaRelationInfo, AutocompleteSchemaShape } from './utils/AutocompleteSchemaUtils';
import { insertRowsChunked, relationExists } from './Database/SqlHelpers';
import { CustomSQLFunctions } from './Database/CustomSQLFunctions';
import { EventBus } from './utils/EventBus';
import { OTHER_FILE_SCHEMA } from './OtherFiles/OtherFileSchema';
import { OtherFileIndexingService } from './OtherFiles/OtherFileIndexingService';
import { ImageIndexingService } from './Images/ImageIndexingService';
import { ExternalRootService } from './External/ExternalRootService';
import type { ExternalRefreshScope } from './External/ExternalRootService';
import type { ExternalRootFailure, ExternalRootStatus } from './External/ExternalRootService';
import { EXTERNAL_FOLDERS_VIEW, publishExternalFolders } from './External/ExternalFolderSchema';
import { comparablePath, normalizeRootPath, retainsRows } from './External/ExternalRootSettings';
import { externalScopeContains, mergeExternalRefreshScope } from './External/ExternalRefreshScopes';
import { createExternalRuntime } from './External/ExternalRuntime';
import { IMAGE_SCHEMA } from './Images/ImageSchema';
import { publishImages } from './Images/ImageDatabaseOperations';
import { publishOtherFiles } from './OtherFiles/OtherFileDatabaseOperations';
import type { EventRef } from './utils/EventBus';
import { logger as rootLogger } from './utils/logger';
import { formatUnknownValue } from './utils/ResultFormatUtils';
import { resolveVaultFile } from './utils/VaultUtils';
import { ProviderSnapshotUnavailableError } from './Providers/ProviderSnapshotUnavailableError';
import type { TableProviderRegistration, TableProviderStatus, ProviderDefinitionCompletionConfig, ProviderTablesChangedEvent, VaultQueryTableProvider } from './Providers/TableProviderTypes';

const logger = rootLogger.scope('API');

const PROVIDER_TABLE_RETRY_TIMEOUT_MS = 2_000;
const QUERY_RETRY_ATTEMPTS = 2;
const QUERY_RETRY_DELAY_MS = 40;
const PROVIDER_TABLE_RETRY_INTERVAL_MS = 100;

export interface FileIndexedEvent {
  path: string;
  isUpdate: boolean;
  source: FileIndexedSource;
}

export type FileIndexedSource = 'note' | 'other-file' | 'image' | 'csv';

export interface FilesIndexedEvent {
  paths: string[];
  isUpdate: boolean;
  source: FileIndexedSource;
}

export interface ExternalRootsChangedEvent {
  roots: ExternalRootStatus[];
}

export interface QueryRelations {
  relations: string[];
  complete: boolean;
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

const EXTERNAL_RECONCILE_DEBOUNCE_MS = 750;
const EXTERNAL_STATUS_POLL_MS = 5_000;

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
  [key: string]: QueryValue;
}

export interface VaultQueryCapabilities {
  writeEnabled: boolean;
  fileDeleteEnabled: boolean;
  thirdPartyProviderTablesEnabled: boolean;
  sources: {
    otherFiles: boolean;
    images: boolean;
    externalRoots: boolean;
    csv: boolean;
    remoteData: boolean;
    providerTables: boolean;
  };
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
  iterateQueryBatches(sql: string, noteSource?: NoteSource, options?: QueryIterationOptions): AsyncIterableIterator<QueryResult[]>;
  /**
   * Run a single SELECT against the indexed vault data, excluding action functions.
   * Pass a note when the query uses `{this.*}` placeholders.
   */
  query(sql: string, noteSource?: NoteSource): Promise<QueryResult[]>;

  /**
   * Reindex files that have changed since the last run.
   */
  reindexVault(): Promise<void>;

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
   * partially built startup index. Rejects if timeoutMs expires before it is ready.
   */
  waitForIndexing(timeoutMs?: number): Promise<void>;

  /**
   * Check whether the database is currently usable.
   */
  checkDatabaseHealthAsync(): Promise<DatabaseHealth>;

  /**
   * Remove one file from the index without deleting it.
   */
  deindex(path: string): Promise<void>;

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
  getSchemaTables(): Promise<SchemaTable[]>;

  /**
   * Live schema data for editor autocomplete.
   */
  getAutocompleteSchema(): Promise<AutocompleteSchemaShape>;

  /**
   * True when a file passes the indexing filters in settings.
   */
  shouldIndexFile(file: TFile): boolean;
  getDataFileSources(): readonly IndexedDataFile[];
  invalidateDataFile(path: string, waitForPending?: () => Promise<void>): void;
  invalidateProviderDefinitions(path: string): void;
  renameProviderDefinitions(previousPath: string, currentPath: string): string[];
  discardPreview(id: string): void;
  getDataFileColumnNames(results: readonly Record<string, unknown>[]): Promise<readonly string[] | undefined>;

  /**
   * Timing details from the last indexing run.
   */
  getPerformanceStats(): IndexingStats | null;

  /**
   * Recreate dynamic markdown-table views from `table_cells`.
   */
  rebuildTableViews(): Promise<void>;

  /**
   * Execute schema SQL or explicit action functions and await immediate queued actions.
   * File actions require write access and real-time indexing. For INSERT, UPDATE,
   * and DELETE changes to vault files, use `previewQuery()` and `applyPreview()`.
   */
  execute(sql: string, params?: unknown[], noteSource?: NoteSource): Promise<number>;

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
  getQueryProviderStatus(sql: string): Promise<TableProviderStatus[]>;
  getProviderDefinitionCompletions(language: string): ProviderDefinitionCompletionConfig | null;

  getQueryRelations(sql: string): Promise<QueryRelations>;

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

  on(event: 'files-indexed', callback: (event: FilesIndexedEvent) => void): EventRef;

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

  on(event: 'external-roots-changed', callback: (event: ExternalRootsChangedEvent) => void): EventRef;

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
  'files-indexed': FilesIndexedEvent;
  'file-removed': FileRemovedEvent;
  'vault-indexed': VaultIndexedEvent;
  'database-lost': DatabaseLostEvent;
  'database-restored': DatabaseRestoredEvent;
  'provider-tables-changed': ProviderTablesChangedEvent;
  'external-roots-changed': ExternalRootsChangedEvent;
}

export type { EventRef };

const MIRROR_READ_LOST_RACE = /abort due to ROLLBACK/i;

export class VaultQueryAPI implements IVaultQueryAPI {
  private readonly otherFileIndex: OtherFileIndexingService;
  private otherFileSettingsKey = '';
  private readonly imageIndex: ImageIndexingService;
  private readonly snapshotIndexes: ReadonlyArray<readonly [ImageIndexingService | OtherFileIndexingService, string]>;
  private imageSettingsKey = '';
  private imageSweep?: Promise<void>;
  private fileSweep?: Promise<void>;
  private externalReconcileTimer?: number;
  private externalReconcileRunning = false;
  private readonly pendingExternalScopes = new Map<string, ExternalRefreshScope>();
  private pendingExternalFullRefresh = false;
  private externalStatusWrite: Promise<void> = Promise.resolve();
  private externalStatusSignature = '';
  private readonly externalStatusPoll: number;
  private readonly externalScheduleTimers = new Map<string, { timer: number; minutes: number }>();
  private readonly externalRoots: ExternalRootService;
  private externalSettingsKey = '';
  private skippedCounts = new Map<string, number>();
  private skippedSignature = '';
  private externalRefresh?: Promise<void>;
  private mainThreadTransfer: Promise<void> | null = null;
  private app: App;
  private database: VaultDatabase | WorkerDatabase;
  private readonly queryIterationAbort = new AbortController();
  private indexingService: IndexingService;
  private csvIndexingService?: DataFileIndexingService;
  private csvWriteService?: CsvWriteService;
  private otherFileWriteService?: OtherFileWriteService;
  private csvStartupError: unknown;
  private tabularFileReadsEnabled = false;
  private readonly csvExclusions = new PathExclusions();
  private csvPendingIndexWaiter?: () => Promise<void>;
  private writeSyncService: WriteSyncService;
  private triggerFunctions: TriggerFunctions;
  private triggerService: TriggerService | null = null;
  private indexingWorker: WorkerDatabase | null = null;
  private queryMirror: WorkerDatabase | null = null;
  private queryMirrorDisabledReason: string | null = 'not started';
  private readonly mirrorForwardingDatabases = new WeakSet<VaultDatabase>();
  private pendingMirrorWrites = 0;
  private mirrorRestoration: Promise<void> | null = null;
  private reindexQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private providerMirrorSync: Promise<void> | null = null;
  private mirrorTriggerSync: Promise<void> | null = null;
  private providerRefreshWave: Promise<void> | null = null;
  private tableProviderService: TableProviderService;
  private readonly preparedWrites: PreparedFileWriteRegistry;
  private readonly providerSnapshots: ProviderSnapshotCoordinator;
  private remoteDataRegistration?: Promise<void>;
  private registeredCustomViews = new Map<string, string>();

  private eventBus: EventBus<VaultQueryEvents>;

  private triggerActionProcessing: Promise<void> | null = null;

  /**
   * Per-statement analysis (comment/literal stripping + referenced tables),
   * cached because block SQL strings repeat on every render and auto-refresh.
   */
  private static readonly SQL_ANALYSIS_CACHE_LIMIT = 200;
  private sqlAnalysisCache = new Map<string, { referencedTables: Set<string>; exactReferences: Set<string>; mutationTargets?: string[] }>();
  private readonly csvDependencies: CsvQueryDependencies;
  private readonly dataFileColumns = new WeakMap<readonly Record<string, unknown>[], readonly string[] | undefined>();
  private customViewKeys?: ReadonlySet<string>;
  private schemaViews?: { database: VaultDatabase | WorkerDatabase; version: string; views: CachedSchemaViews };

  private constructor(app: App, private settings: VaultQuerySettings, database: VaultDatabase | WorkerDatabase, indexingService: IndexingService, writeSyncService: WriteSyncService, triggerFunctions: TriggerFunctions, eventBus?: EventBus<VaultQueryEvents>) {
    // Reuse the previous instance's bus during database recovery so that
    // third-party subscriptions (e.g. 'database-restored') survive the API
    // being recreated.
    this.eventBus = eventBus ?? new EventBus<VaultQueryEvents>([
      'file-indexed',
      'files-indexed',
      'file-removed',
      'vault-indexed',
      'database-lost',
      'database-restored',
      'provider-tables-changed',
      'external-roots-changed',
    ], (event, error) => {
      logger.error(`Error in event listener for '${event}'`, error);
    });

    this.app = app;
    this.database = database;

    this.preparedWrites = new PreparedFileWriteRegistry(settings,
      () => !this.closing && this.database instanceof VaultDatabase ? this.database : undefined);

    this.indexingService = indexingService;
    this.writeSyncService = writeSyncService;
    this.triggerFunctions = triggerFunctions;
    this.tabularFileReadsEnabled = settings.enableDataFileReads;

    const getFile = (path: string): TFile | null => resolveVaultFile(this.app.vault, path);

    this.externalRoots = new ExternalRootService(settings, createExternalRuntime(app), scope => this.scheduleExternalReconcile(scope),
      () => this.publishExternalRootStatus());

    this.externalStatusPoll = window.setInterval(() => {
      if (this.externalRoots.configured) this.publishExternalRootStatus();
    }, EXTERNAL_STATUS_POLL_MS);

    const externalMembership = {
      selects: (path: string) => this.externalRoots.selects(path),
      sourceFor: (path: string) => this.externalRoots.sourceFor(path),
      retains: (path: string) => this.externalRoots.retains(path),
    };

    const isExternal = (path: string) => this.externalRoots.has(path);
    const indexDatabase = () => this.database instanceof VaultDatabase ? this.database : undefined;

    const files = {
      getFiles: () => [...this.app.vault.getFiles(), ...this.externalRoots.files()],
      getFile: (path: string) => isExternal(path) ? this.externalRoots.file(path) : getFile(path),
      read: async (file: { path: string }) => {
        if (isExternal(file.path)) return this.externalRoots.readAll(file.path);
        if (!(file instanceof TFile)) throw new Error(`File is unavailable: ${file.path}`);

        return this.app.vault.readBinary(file);
      },
    };

    const publisher = <Row extends { path: string; source: string }>(
      table: string, source: FileIndexedSource, label: string,
      write: (mirror: WorkerDatabase, publication: { rows: Row[]; removed: string[] }) => Promise<void>
    ) => {
      return async (publication: { rows: Row[]; removed: string[] }) => {
        const mirror = this.queryMirror;

        if (mirror) {
          try {
            await write(mirror, publication);
          }
          catch (error) {
            if (this.queryMirror === mirror) this.disableQueryMirror(`${label} publication failed: ${getErrorMessage(error)}`);
          }
        }

        for (const path of publication.removed) {
          this.emit('file-removed', { path });
        }

        this.emitIndexed(publication.rows.map(row => row.path), true, source);
        this.noteExternalRows(publication.rows);
        QueryRefreshRegistry.scheduleAutoRefresh([table]);
      };
    };

    this.otherFileIndex = new OtherFileIndexingService(files, settings, indexDatabase, publisher('other_files', 'other-file', 'File content', publishOtherFiles), undefined, externalMembership);

    this.imageIndex = new ImageIndexingService({ ...files,
      resourceUrl: file => !isExternal(file.path) && file instanceof TFile ? this.app.vault.getResourcePath(file) : null,
      open: file => isExternal(file.path) ? this.externalRoots.openRead(file.path) : undefined,
    }, settings, indexDatabase, publisher('image_files', 'image', 'Image', publishImages), undefined, externalMembership);

    this.snapshotIndexes = [[this.imageIndex, 'Image metadata'], [this.otherFileIndex, 'File content']];

    // A platform with no scan to run (iOS) would otherwise leave external_folders empty until the first poll, after blocks have queried it.
    if (this.externalRoots.configured) this.publishExternalRootStatus();

    this.otherFileSettingsKey = this.otherFileConfigurationKey();
    this.imageSettingsKey = this.imageConfigurationKey();
    this.externalSettingsKey = this.externalConfigurationKey();

    this.providerSnapshots = new ProviderSnapshotCoordinator(
      () => this.database instanceof VaultDatabase ? this.database : undefined,
      () => dataFileParseLimits(this.settings.dataFileMaxSizeMiB),
      () => ['notes', 'other_files', 'image_files', 'image_metadata', ...Object.keys(TABLE_FEATURE_CONFIG), ...this.tableProviderService.getRegisteredProviders().flatMap(provider => provider.tables.map(table => table.name))]);

    this.tableProviderService = new TableProviderService(database, this.settings.enableThirdPartyProviderTables, this.providerSnapshots,
      path => this.app.vault.getAbstractFileByPath(path) instanceof TFile, this.settings.enableRemoteDataReads);

    QueryRefreshRegistry.setScopeResolver(this.scopeResolver);

    this.csvDependencies = new CsvQueryDependencies(
      sql => this.getSqlAnalysis(sql).exactReferences,
      name => this.isIndexedRelation(name),
      async () => {
        const database = this.database;
        const rows = await database.all('PRAGMA main.schema_version');

        return { database, version: Number(rows[0].schema_version) };
      },
      async name => {
        const rows = await this.database.all("SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ? COLLATE NOCASE", [name]);

        return typeof rows[0]?.sql === 'string' ? rows[0].sql : undefined;
      },
    );

    this.providerSnapshots.setEnabled(this.settings.enableThirdPartyProviderTables || this.settings.enableRemoteDataReads);

    this.providerSnapshots.setPublisher(async (tables, relocations = []) => {
      await this.queueMirrorSync('providerMirrorSync', async () => {
        const mirror = this.queryMirror;

        if (mirror && (tables.length || relocations.length)) {
          try {
            await publishProviderSnapshots(this.database, mirror, tables, relocations);
            await this.syncCustomViewsToQueryMirror(mirror);
          }
          catch (error) {
            if (this.queryMirror === mirror) this.disableQueryMirror(`Provider snapshot publication failed: ${getErrorMessage(error)}`);
          }
        }
      });

      try {
        if (this.database instanceof VaultDatabase) await this.database.saveToDisk({ throwOnError: true, lockExport: true });
        else await this.database.saveToDisk();
      }
      catch (error) {
        throw new Error(`The provider snapshot is available, but saving the database failed: ${getErrorMessage(error)}`);
      }

      if (!this.providerRefreshWave && (tables.length || relocations.length)) {
        const changed = [...tables, ...relocations.flatMap(relocation => [relocation.previous.table, relocation.current.table])];
        window.setTimeout(() => { void QueryRefreshRegistry.refreshAll({ force: true, tables: changed }); }, 0);
      }
    });

    this.tableProviderService.setOnAllQueriesRefresh(() => QueryRefreshRegistry.refreshAll({ force: true }));

    this.tableProviderService.setOnRefreshWaveComplete(async tables => {
      await this.queueProviderTableMirrorSync(tables);

      // The initial refresh wave performs one refresh after its readiness
      // promise is cleared, so dependent queries do not wait on themselves.
      if (!this.providerRefreshWave) {
        await QueryRefreshRegistry.refreshAll({ force: true, tables });
      }
    });

    this.tableProviderService.setOnProviderTablesChanged(event => {
      this.emit('provider-tables-changed', event);
    });

    this.indexingService.setProviderDefinitionBlockHandler(this.tableProviderService);

    this.indexingService.setEventEmitter({
      emitFileIndexed: (path: string, isUpdate: boolean) => {
        this.emitIndexed([path], isUpdate, 'note');
        this.processTriggerActions();
      },
      emitFileRemoved: (path: string) => {
        this.emit('file-removed', { path });
      },
      emitVaultIndexed: (filesIndexed: number, filesRemoved: number, isForced: boolean) => {
        if (this.tableProviderService.hasProviderDefinitionDiscovery()) {
          this.startInitialProviderRefreshWave();
        }

        this.emit('vault-indexed', { filesIndexed, filesRemoved, isForced });
      },
      // Transfer database from worker to main thread BEFORE vault-indexed event fires
      // so third-party plugins registering views/functions get the main thread database
      onBeforeVaultIndexed: async (force) => {
        await this.transferToMainThread();
        this.otherFileIndex.updateSelection();

        if (force) for (const file of this.app.vault.getFiles()) {
          this.otherFileIndex.invalidate(file.path);
          this.imageIndex.invalidate(file.path);
        }

        try {
          await this.providerSnapshots.initialize(force);

          if (this.tableProviderService.hasProviderDefinitionDiscovery()) {
            await this.tableProviderService.discoverMissingDefinitionBlocks(
              this.app.vault.getMarkdownFiles().filter(file => this.indexingService.shouldIndexFile(file)),
              file => this.app.vault.cachedRead(file),
              file => {
                const sections = this.app.metadataCache.getFileCache(file)?.sections;

                return !sections || sections.some(section => section.type === 'code');
              });
          }

          this.providerSnapshots.finishDefinitionDiscovery();
          await this.providerSnapshots.reconcile();
          await this.providerSnapshots.publishReadySnapshots();
        }
        catch (error) {
          logger.error('Provider snapshots are unavailable', error);
        }

        // Register user-defined functions after database transfer (create_function doesn't persist in binary)
        if (this.settings.enableJavaScriptFunctions) {
          this.registerUserFunctions();
        }

        // Recreate third-party views registered through execute(); worker-to-main transfer can replace the database.
        await this.registerCustomViews();

        // Register user-defined SQLite triggers after indexing completes (if enabled)
        if (this.settings.enableTriggers) {
          this.registerUserTriggers();
          await this.queueMirrorTriggerSync();
        }

        await this.restoreQueryMirror();
        this.startFileSweep(force);
      }
    });
  }

  private emitIndexed(paths: string[], isUpdate: boolean, source: FileIndexedSource): void {
    if (!paths.length) return;

    for (const path of paths) {
      this.emit('file-indexed', { path, isUpdate, source });
    }

    this.emit('files-indexed', { paths, isUpdate, source });
  }

  private processTriggerActions(): void {
    void this.processPendingTriggerActions().catch(error => logger.error('Error processing trigger actions', error));
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

    while (this.triggerFunctions.hasPendingActions()) {
      await this.triggerService.processPendingActions(true);
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

    if (!settings.enabledFeatures.indexContent) {
      await database.run("UPDATE notes SET content = '', content_status = 'not_indexed' WHERE content_status = 'ready'");
    }

    if (settings.indexingInterval === 'manual') await api.transferToMainThread();

    try {
      await api.otherFileIndex.reconcile(false);
    }
    catch (error) {
      logger.error('Stored file contents failed validation', error);
    }

    try {
      await api.imageIndex.reconcile(false);
    }
    catch (error) {
      logger.error('Stored image metadata failed validation', error);
    }

    try {
      if ((await api.database.all('SELECT 1 FROM sqlite_schema WHERE name = ? COLLATE NOCASE', ['_vq_provider_snapshots'])).length) {
        const rows = await api.database.all('SELECT table_name FROM main._vq_provider_snapshots');
        api.providerSnapshots.reservePersistedNames(rows.map(row => String(row.table_name)));
      }
    }
    catch (error) {
      logger.error('Stored provider snapshot names could not be read', error);
    }

    await api.ensureRemoteDataProviders();

    try {
      await api.providerSnapshots.initialize();
    }
    catch (error) {
      logger.error('Stored provider snapshots failed validation', error);
    }

    api.triggerService = new TriggerService({
      app,
      triggerFunctions,
      reindexFile: (path: string) => api.reindexNote(path),
      assertAccess: () => {
        if (!settings.allowWriteOperations) throw new Error(ERROR_MESSAGES.WRITE_OPERATIONS_DISABLED_APPLY);
      }
    });

    if (settings.indexingInterval === 'manual') api.startFileSweep();

    return api;
  }

  /**
   * Transfer database from worker to main thread after indexing completes.
   * Only used when backgroundIndexing is enabled.
   */
  public transferToMainThread(): Promise<void> {
    if (!this.indexingWorker) return Promise.resolve();

    this.mainThreadTransfer ??= this.runMainThreadTransfer().finally(() => { this.mainThreadTransfer = null; });

    return this.mainThreadTransfer;
  }

  private async runMainThreadTransfer(): Promise<void> {
    if (!this.indexingWorker) return;

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

    this.otherFileWriteService = undefined;
    this.csvWriteService = undefined;
    this.database = mainThreadDb;
    this.preparedWrites.updateAccess();
    await this.tableProviderService.setDatabase(mainThreadDb);
    this.indexingService.setDatabase(mainThreadDb);
    this.writeSyncService.setDatabase(mainThreadDb);

    mainThreadDb.registerTriggerFunctions(this.triggerFunctions);

    const restored = await this.otherFileIndex.reconcile(false);
    if (restored.filesRemoved || restored.filesIndexed || restored.failedPaths.length) {
      await finishedWorker.close(false);
      await this.restoreQueryMirror();
    } else await this.adoptQueryMirror(finishedWorker, mainThreadDb);
  }

  /**
   * A 25k-note SELECT blocks the UI for over a second when run on the main
   * thread, hence the mirror. The built-in resolve_link() is main-thread-only
   * (Obsidian API); queries using it error on the mirror and fall back.
   */
  private async adoptQueryMirror(worker: WorkerDatabase, mainThreadDb: VaultDatabase): Promise<void> {
    if (!this.settings.workerQueries) {
      await worker.close(false);

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

      await this.registerMirrorTriggerFunctions(mainThreadDb, worker);

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
    // A query copy must never overwrite the authoritative database on disk.
    await mirror.close(false).catch(() => undefined);
  }

  private async registerMirrorTriggerFunctions(main: VaultDatabase, mirror: WorkerDatabase): Promise<void> {
    if (!this.settings.enableTriggers) return;
    const functions = await main.all('SELECT name, narg FROM pragma_function_list WHERE builtin = 0');

    for (const name of TRIGGER_FUNCTION_NAMES) {
      const arity = Number(functions.find(row => row.name === name)?.narg);
      if (!Number.isInteger(arity) || arity < 0) throw new Error(`Missing trigger function signature: ${name}`);
      const params = Array.from({ length: arity }, (_, index) => `arg${index}`).join(', ');
      await mirror.registerCustomFunction(name, `(${params}) => 0`);
    }
  }

  private restoreQueryMirror(): Promise<void> {
    if (this.closing || this.queryMirror || !this.settings.workerQueries || !(this.database instanceof VaultDatabase)) {
      return Promise.resolve();
    }

    if (this.mirrorRestoration) return this.mirrorRestoration;

    const restoration = this.createQueryMirror().finally(() => {
      if (this.mirrorRestoration === restoration) this.mirrorRestoration = null;
    });

    this.mirrorRestoration = restoration;

    return restoration;
  }

  private async createQueryMirror(): Promise<void> {
    const main = this.database;
    if (!(main instanceof VaultDatabase)) return;
    let worker: WorkerDatabase | undefined;

    try {
      this.attachMirrorForwarding(main);

      worker = await WorkerDatabase.create(this.app.vault.configDir, null, true, undefined,
        VaultQueryAPI.getPluginDir(this.app), VaultQueryAPI.createFileAdapter(this.app), this.settings.wasm);

      await this.otherFileIndex.reconcile(false);
      await this.imageIndex.reconcile(false);
      const candidate = worker;

      await main.withTransferLock(async () => {
        for (let attempt = 0; attempt < 3 && !this.closing; attempt++) {
          const snapshot = await main.createQueryMirrorSnapshot();
          await candidate.importDatabase(snapshot.data);
          await this.registerMirrorTriggerFunctions(main, candidate);

          const published = await main.publishQueryMirrorSnapshot(snapshot, () => {
            if (this.closing || !this.settings.workerQueries || this.database !== main || this.pendingMirrorWrites) return false;
            this.queryMirror = candidate;
            this.queryMirrorDisabledReason = null;

            return true;
        });

        if (published) {
          logger.info('Query mirror restored after vault indexing');
          worker = undefined;

          return;
        }

        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }

      if (!this.closing) this.queryMirrorDisabledReason = 'index changed during query mirror setup';
      });
    } catch (error) {
      if (!this.closing) this.queryMirrorDisabledReason = `setup failed: ${getErrorMessage(error)}`;
      logger.warn('Query mirror restore failed - queries stay on the main thread', error);
    } finally {
      if (worker) await VaultQueryAPI.closeQuietly(worker);
    }
  }

  private attachMirrorForwarding(mainThreadDb: VaultDatabase): void {
    if (this.mirrorForwardingDatabases.has(mainThreadDb)) return;
    this.mirrorForwardingDatabases.add(mainThreadDb);
    // Missing tables/views are expected (provider tables live main-side only);
    // a missing FUNCTION on a forwarded write means a trigger stub is absent and
    // the write was rejected - that is silent staleness, so it disables the mirror.
    const EXPECTED_DIVERGENCE = /no such (table|column|view)/i;

    const forward = (work: (mirror: WorkerDatabase) => Promise<unknown>): (() => Promise<void>) | void => {
      const mirror = this.queryMirror;
      if (!mirror) return;

      return async () => work(mirror).then(() => undefined).catch(error => {
        const message = getErrorMessage(error);

        if (EXPECTED_DIVERGENCE.test(message)) {
          logger.debug('Query mirror skipped a forwarded write', { message });

          return;
        }

        if (this.queryMirror === mirror) this.disableQueryMirror(`write forwarding failed: ${message}`);
      });
    };

    const forwardIndex = async <T>(work: () => Promise<T>, mirrorWork: (mirror: WorkerDatabase) => Promise<unknown>): Promise<T> => {
      this.pendingMirrorWrites++;

      try {
        const result = await work();
        const forwarded = forward(mirrorWork);
        if (forwarded) await forwarded().then(() => this.queueMirrorTriggerSync());

        return result;
      } finally {
        this.pendingMirrorWrites--;
      }
    };

    const originalIndexNote = mainThreadDb.indexNote.bind(mainThreadDb);
    mainThreadDb.indexNote = data => forwardIndex(() => originalIndexNote(data), mirror => mirror.indexNote(data));
    const originalIndexBatch = mainThreadDb.indexNotesBatch.bind(mainThreadDb);

    mainThreadDb.indexNotesBatch = (notesData, isInitialIndexing, skipDiskSave, syncTriggerChanges) => forwardIndex(
      () => originalIndexBatch(notesData, isInitialIndexing, skipDiskSave, syncTriggerChanges),
      mirror => mirror.indexNotesBatch(notesData, isInitialIndexing ?? false, true)
    );

    const originalRun = mainThreadDb.run.bind(mainThreadDb);

    mainThreadDb.run = async (sql, params) => {
      this.pendingMirrorWrites++;

      try {
        const result = await originalRun(sql, params);
        const analysis = this.getSqlAnalysis(sql);
        const targets = this.getSqlMutationTargets(sql);

        const csvMutation = targets.some(target => ['other_files', '_vq_data_files'].includes(sqliteIdentifierKey(target))
          || this.csvIndexingService?.hasReadyRelation(target));

        const providerMutation = targets.some(name => /^_vq_provider_/i.test(name) || this.tableProviderService.hasRegisteredTable(name));
        const readsProvider = [...analysis.exactReferences].some(name => /^_vq_provider_/i.test(name) || this.tableProviderService.hasRegisteredTable(name));

        if (!providerMutation && !readsProvider && !csvMutation) {
          const forwarded = forward(mirror => mirror.run(sql, params));
          if (forwarded) await forwarded();
        }

        return result;
      } finally {
        this.pendingMirrorWrites--;
      }
    };
  }

  private queueMirrorTriggerSync(): Promise<void> {
    return this.queueMirrorSync('mirrorTriggerSync', () => this.syncMirrorTriggers());
  }

  private queueMirrorSync(key: 'providerMirrorSync' | 'mirrorTriggerSync', work: () => Promise<void>): Promise<void> {
    const previous = this[key] ?? Promise.resolve();
    const sync = previous.catch(() => undefined).then(work);
    this[key] = sync;

    const clear = (): void => {
      if (this[key] === sync) this[key] = null;
    };

    void sync.then(clear, clear);

    return sync;
  }

  private async syncMirrorTriggers(): Promise<void> {
    const mirror = this.queryMirror;
    if (!mirror || !this.settings.enableTriggers) return;

    try {
      const mirrorTriggers = await mirror.all(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_vq_user_%'`);

      for (const row of mirrorTriggers) {
        await mirror.run(`DROP TRIGGER IF EXISTS ${quoteIdentifier(String(row.name))}`);
      }

      const mainTriggers = await this.database.all(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_vq_user_%'`);

      for (const row of mainTriggers) {
        if (typeof row.sql === 'string' && row.sql) {
          if (typeof row.name === 'string' && row.name) {
            await mirror.run(`DROP TRIGGER IF EXISTS ${quoteIdentifier(row.name)}`);
          }

          await mirror.run(row.sql);
        }
      }
    } catch (error) {
      if (this.queryMirror === mirror) this.disableQueryMirror(`trigger sync failed: ${getErrorMessage(error)}`);
    }
  }

  private async queueProviderTableMirrorSync(tableNames: string[]): Promise<void> {
    await this.queueMirrorSync('providerMirrorSync', () => this.syncProviderTablesToQueryMirror(tableNames));
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
      if (this.queryMirror === mirror) this.disableQueryMirror(`provider table sync failed: ${getErrorMessage(error)}`);
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
    return this.queueVaultReindex(false);
  }

  public async forceReindexVault(): Promise<void> {
    return this.queueVaultReindex(true);
  }

  private queueVaultReindex(force: boolean): Promise<void> {
    const operation = this.reindexQueue.then(async () => {
      if (this.closing) throw new Error('VaultQuery is closing');
      if (force) this.preparedWrites.invalidate('data-file');
      this.disableQueryMirror(force ? 'forced full vault reindex' : 'full vault reindex');
      if (force) await this.indexingService.forceReindexVault();
      else await this.indexingService.reindexVault();
      await this.fileSweep;
    });

    this.reindexQueue = operation.catch(() => {});

    return operation;
  }

  public async reindexNote(notePath: string): Promise<void> {
    if (this.otherFileIndex.selected(notePath) || this.imageIndex.selected(notePath)) {
      const file = this.app.vault.getAbstractFileByPath(notePath);

      if (file instanceof TFile) {
        this.otherFileIndex.invalidate(notePath);
        this.imageIndex.invalidate(notePath);
        await this.processRealtimeIndexBatch([], [file]);

        return;
      }
    }

    if (isDataFilePath(notePath)) {
      await this.getCsvIndexingService().processBatch([], [notePath]);

      return;
    }

    return this.indexingService.reindexNote(notePath);
  }

  public async indexNote(file: TFile, content?: string): Promise<void> {
    if (file.extension !== 'md') {
      await this.processRealtimeIndexBatch([], [file]);

      return;
    }

    await this.indexingService.indexNote(file, content);

    if (this.otherFileIndex.selected(file.path)) {
      this.otherFileIndex.invalidate(file.path);
      await this.otherFileIndex.processBatch([], [file.path]);
      await this.database.saveToDisk();
    }
  }

  public async processRealtimeIndexBatch(filePathsToRemove: readonly string[], filesToIndex: readonly TFile[], force = false) {
    const markdownRemovals = filePathsToRemove.filter(path => /\.md$/.test(path));
    const markdownFiles = filesToIndex.filter(file => file.extension === 'md');
    const providerRevisions = new Map(markdownFiles.map(file => [file.path, this.providerSnapshots.pathRevision(file.path)]));

    const result = markdownRemovals.length || markdownFiles.length
      ? await this.indexingService.processRealtimeBatch(markdownRemovals, markdownFiles, force)
      : { filesIndexed: 0, filesRemoved: 0, failedPaths: [] as string[], failedRemovalPaths: [] as string[] };

    for (const file of markdownFiles) {
      if (providerRevisions.get(file.path) === undefined || result.failedPaths.includes(file.path)) continue;

      if (!await this.needsIndexing(file)) {
        const names = this.providerSnapshots.confirmIndexedPath(file.path, providerRevisions.get(file.path));
        this.tableProviderService.refreshSnapshotsAfterRead(names);

        if (names.length) {
          await this.tableProviderService.rerenderProviderBlocksForPath(file.path);
          window.setTimeout(() => { void QueryRefreshRegistry.refreshAll({ force: true }); }, 0);
        }
      }
    }

    const removals = filePathsToRemove.filter(isDataFilePath);
    const candidates = filesToIndex.map(file => file.path).filter(isDataFilePath);

    if (removals.length || candidates.length) {
      const csv = await this.getCsvIndexingService().processBatch(removals, candidates);
      result.filesIndexed += csv.filesIndexed;
      result.filesRemoved += csv.filesRemoved;
      result.failedPaths.push(...csv.failedPaths);
      result.failedRemovalPaths.push(...csv.failedRemovalPaths);
    }

    for (const [index, label] of this.snapshotIndexes) {
      const removed = filePathsToRemove.filter(path => index.has(path));
      const candidates = filesToIndex.filter(file => index.selected(file.path) || index.has(file.path)).map(file => file.path);
      if (!removed.length && !candidates.length) continue;

      try {
        const batch = await index.processBatch(removed, candidates);
        result.filesIndexed += batch.filesIndexed;
        result.filesRemoved += batch.filesRemoved;
        result.failedPaths.push(...batch.failedPaths);
        result.failedRemovalPaths.push(...batch.failedRemovalPaths);
      } catch (error) {
        logger.error(`${label} update failed`, error);
        result.failedPaths.push(...candidates);
        result.failedRemovalPaths.push(...removed);
      }
    }

    return result;
  }

  public getIndexingStatus(): IndexingStatus {
    return this.indexingService.getIndexingStatus();
  }

  public isIndexReady(): boolean {
    return this.indexingService.isIndexReady();
  }

  public onIndexingChange(callback: () => void): () => void {
    return this.indexingService.onIndexingChange(callback);
  }

  public async waitForIndexing(timeoutMs?: number): Promise<void> {
    return this.indexingService.waitForIndexing(timeoutMs);
  }

  public setIndexingStatus(isIndexing: boolean): void {
    this.indexingService.setIndexingStatus(isIndexing);
  }

  public async deindex(path: string): Promise<void> {
    if (isDataFilePath(path)) await this.getCsvIndexingService().deindex(path);
    else await this.indexingService.deindex(path);

    for (const [index, label] of this.snapshotIndexes) {
      if (!index.has(path)) continue;
      const result = await index.processBatch([path], []);
      if (result.failedRemovalPaths.length) throw new Error(`${label} removal failed: ${path}`);
    }
  }

  public async saveToDisk(): Promise<void> {
    await this.otherFileIndex.waitForIdle();
    await this.imageIndex.waitForIdle();
    if (!this.csvStartupError) await this.csvIndexingService?.waitForIdle();

    return this.database.saveToDisk();
  }

  public shouldIndexFile(file: TFile): boolean {
    if (isDataFilePath(file.path)) {
      return this.settings.enableDataFileReads && !this.csvExclusions.matches(file.path, this.settings.excludePatterns);
    }

    return this.indexingService.shouldIndexFile(file);
  }

  public getDataFileSources(): readonly IndexedDataFile[] {
    return this.settings.enableDataFileReads ? this.csvIndexingService?.getSources() ?? [] : [];
  }

  public invalidateDataFile(path: string, waitForPending?: () => Promise<void>): void {
    if (isDataFilePath(path)) {
      if (waitForPending) this.csvPendingIndexWaiter = waitForPending;
      this.csvIndexingService?.invalidate(path);
      this.preparedWrites.invalidate('data-file', path);
    }
  }

  public invalidateProviderDefinitions(path: string): void { this.providerSnapshots.invalidatePath(path); }

  public getIndexedDataPaths(folder: string): Set<string> {
    const prefix = `${folder}/`;
    const paths = new Set<string>();

    for (const [index] of this.snapshotIndexes) {
      for (const path of index.paths()) {
        if (path.startsWith(prefix)) paths.add(path);
      }
    }

    for (const source of this.getDataFileSources()) {
      if (source.path.startsWith(prefix)) paths.add(source.path);
    }

    return paths;
  }

  public invalidateFileSnapshots(path: string, folder = false): void {
    for (const [index] of this.snapshotIndexes) {
      index.invalidate(path);

      if (folder) for (const candidate of index.paths()) {
        if (candidate.startsWith(`${path}/`)) index.invalidate(candidate);
      }
    }
  }

  public shouldIndexOtherFile(path: string): boolean { return this.otherFileIndex.selected(path); }
  public shouldIndexImage(path: string): boolean { return this.imageIndex.selected(path); }
  public hasImageIndexEntry(path: string): boolean { return this.imageIndex.has(path); }
  public getImageIndexPaths(): string[] { return this.imageIndex.paths(); }
  public invalidateImageMetadata(path: string): void { this.imageIndex.invalidate(path); }
  public getOtherFileIndexPaths(): string[] { return this.otherFileIndex.paths(); }
  public hasOtherFileIndexEntry(path: string): boolean { return this.otherFileIndex.has(path); }
  public invalidateOtherFileContents(path: string): void {
    this.otherFileIndex.invalidate(path);
  }

  private startFileSweep(force = false): void {
    if (this.closing) return;

    const notesReady = this.indexingService.getIndexingStatus().isIndexing ? this.indexingService.waitForIndexing() : Promise.resolve();

    this.fileSweep = notesReady.then(() => this.externalRoots.exclusive(async () => {
      if (this.closing) return;

      if (this.externalRoots.configured) {
        try {
          await this.externalRoots.refresh();
          if (this.closing) return;
          this.externalRoots.startWatching();
          this.syncExternalSchedules();
        }
        catch (error) {
          logger.error('External folders are unavailable', error);
        }
      }

      if (this.closing) return;

      try {
        await this.getCsvIndexingService().reconcile(force);
        this.csvStartupError = undefined;
      }
      catch (error) {
        this.csvStartupError = error;
        logger.error('CSV indexing is unavailable; Markdown indexing can continue', error);
      }

      await this.otherFileIndex.reconcile();
      await this.database.saveToDisk();
      this.startImageSweep(force);
    })).catch((error: unknown) => logger.error('File indexing failed', error));
  }

  private startImageSweep(force = false): void {
    if (this.closing) return;

    if (!this.imageIndex.enabled) {
      logger.debug('Image metadata indexing is off; no image is indexed, in the vault or an external folder');

      return;
    }

    this.imageSweep = this.runImageSweep(force);
  }

  private runImageSweep(force: boolean): Promise<void> {
    const started = performance.now();

    return this.imageIndex.reconcile(true, force)
      .then(async result => {
        logger.debug('Image sweep complete', { force, indexed: result.filesIndexed, removed: result.filesRemoved,
          failed: result.failedPaths.length, ms: Math.round(performance.now() - started) });

        if (!this.closing) await this.database.saveToDisk();
      })
      .catch((error: unknown) => logger.error('Image metadata indexing failed', error));
  }

  private reportUnindexedExternalFiles(): void {
    const stranded = this.getExternalRootStatus()
      .filter(status => status.state === 'ready' && status.filesSkipped > 0 && status.filesIndexed === 0);

    if (!stranded.length) return;

    for (const status of stranded) {
      const types = new Map<string, number>();

      for (const file of this.externalRoots.files()) {
        if (comparablePath(this.externalRoots.sourceFor(file.path) ?? '') !== comparablePath(status.path)) continue;
        if (this.claimsExternalFile(file.path)) continue;
        const extension = pathExtension(file.path).toLowerCase() || '(none)';
        types.set(extension, (types.get(extension) ?? 0) + 1);
      }

      if (!types.size) continue;

      logger.warn('External files were found that no enabled index takes', { path: status.path, filesFound: status.filesFound,
        types: Object.fromEntries([...types].sort((left, right) => right[1] - left[1]).slice(0, 8)),
        indexImageMetadata: this.settings.indexImageMetadata, otherFileContentExtensions: this.settings.otherFileContentExtensions,
        enableDataFileReads: this.settings.enableDataFileReads });
    }
  }

  private scheduleExternalReconcile(scope?: ExternalRefreshScope): void {
    if (this.closing) return;
    this.mergeExternalScope(scope);
    this.scheduleExternalDrain();
  }

  private scheduleExternalDrain(): void {
    if (this.closing || this.externalReconcileRunning || this.externalReconcileTimer !== undefined) return;
    if (!this.pendingExternalFullRefresh && !this.pendingExternalScopes.size) return;

    this.externalReconcileTimer = window.setTimeout(() => {
      this.externalReconcileTimer = undefined;
      if (this.closing) return;
      this.externalReconcileRunning = true;
      this.externalRefresh = this.drainExternalChanges().finally(() => {
        this.externalReconcileRunning = false;
        this.scheduleExternalDrain();
      });
      void this.externalRefresh.catch((error: unknown) => logger.error('External folder indexing failed', error));
    }, EXTERNAL_RECONCILE_DEBOUNCE_MS);
  }

  private async drainExternalChanges(): Promise<void> {
    while (!this.closing && (this.pendingExternalFullRefresh || this.pendingExternalScopes.size)) {
      await this.externalRoots.exclusive(async () => {
        if (this.closing) return;
        const scopes = this.pendingExternalFullRefresh ? undefined : [...this.pendingExternalScopes.values()];
        this.pendingExternalScopes.clear();
        this.pendingExternalFullRefresh = false;
        try {
          await this.runExternalRefresh(scopes);
        }
        catch (error) {
          logger.error('External folder indexing failed', error);
        }
      });
    }
  }

  private mergeExternalScope(scope?: ExternalRefreshScope): void {
    if (!scope) {
      this.pendingExternalFullRefresh = true;
      this.pendingExternalScopes.clear();

      return;
    }
    if (this.pendingExternalFullRefresh) return;

    mergeExternalRefreshScope(this.pendingExternalScopes, scope);
  }

  public async refreshExternalRoots(): Promise<void> {
    await this.refreshExternalScopes();
  }

  public async refreshExternalRoot(path: string): Promise<void> {
    await this.refreshExternalScopes([{ root: normalizeRootPath(path) }]);
  }

  private async refreshExternalScopes(scopes?: ExternalRefreshScope[]): Promise<void> {
    if (this.closing || !this.externalRoots.configured) return;
    const refresh = this.externalRefresh = this.externalRoots.exclusive(() => this.runExternalRefresh(scopes));
    await refresh;
  }

  private syncExternalSchedules(): void {
    const roots = this.closing ? [] : this.externalRoots.roots().filter(root => (root.state === 'ready' || retainsRows(root.state)) && root.extensions.length && root.refresh === 'interval');
    const wanted = new Map(roots.map(root => [comparablePath(root.path), root]));

    for (const [key, entry] of this.externalScheduleTimers) {
      if (wanted.get(key)?.refreshMinutes === entry.minutes) continue;
      window.clearInterval(entry.timer);
      this.externalScheduleTimers.delete(key);
    }

    for (const [key, root] of wanted) {
      if (this.externalScheduleTimers.has(key)) continue;
      const path = root.path;
      const timer = window.setInterval(() => this.scheduleExternalReconcile({ root: path }), root.refreshMinutes * 60_000);
      this.externalScheduleTimers.set(key, { timer, minutes: root.refreshMinutes });
    }
  }

  private publishExternalRootStatus(): void {
    const roots = this.getExternalRootStatus();

    const signature = roots.map(root => [root.path, root.state, root.scanning, root.filesFound, root.filesIndexed,
      root.filesSkipped, root.failures.length, root.lastScanCompleted].join(':')).join('|');

    if (signature === this.externalStatusSignature) return;
    this.externalStatusSignature = signature;

    logger.debug('External folder status changed', { roots: roots.map(root => ({ path: root.path, state: root.state,
      scanning: root.scanning, filesFound: root.filesFound, filesIndexed: root.filesIndexed })) });

    this.emit('external-roots-changed', { roots: roots as ExternalRootStatus[] });
    if (this.closing) return;

    this.externalStatusWrite = this.externalStatusWrite
      .catch(() => undefined)
      .then(async () => {
        if (this.closing) return;
        await publishExternalFolders(this.database, this.getExternalRootStatus());
        QueryRefreshRegistry.scheduleAutoRefresh([EXTERNAL_FOLDERS_VIEW]);
      })
      .catch((error: unknown) => logger.error('External folder status could not be published', error));
  }

  private recordExternalFailures(results: readonly { failedPaths: readonly string[]; unavailablePaths?: readonly string[] }[]): void {
    const failures: ExternalRootFailure[] = [];

    for (const result of results) {
      for (const path of result.failedPaths) {
        failures.push({ path, reason: 'This file could not be indexed.' });
      }

      for (const path of result.unavailablePaths ?? []) {
        const image = this.imageIndex.state(path);
        const file = this.otherFileIndex.state(path);
        const reason = image?.metadata_status === 'read_error' ? image.metadata_error : file?.content_status === 'read_error' ? file.content_error : null;
        if (reason) failures.push({ path, reason });
      }
    }

    if (failures.length) this.externalRoots.recordFailures(failures);
  }

  private async runExternalRefresh(scopes?: ExternalRefreshScope[]): Promise<void> {
    if (this.closing) return;
    const candidates = new Set<string>();
    const removals = new Set<string>();

    if (!scopes) {
      await this.externalRoots.refresh();
      this.externalRoots.startWatching();
      this.syncExternalSchedules();
    } else {
      for (const scope of scopes) {
        const diff = await this.externalRoots.refresh(scope);
        if (scope.file) this.invalidateFileSnapshots(scope.file);

        for (const path of [...diff.added, ...diff.changed]) {
          candidates.add(path);
        }

        for (const path of diff.removed) {
          removals.add(path);
        }
      }

      this.externalRoots.startWatching();
      this.syncExternalSchedules();

      for (const [index] of this.snapshotIndexes) {
        for (const path of index.retryPaths()) {
          if (this.externalRoots.has(path) && this.externalRoots.selects(path)
            && scopes.some(scope => externalScopeContains(scope, path))) candidates.add(path);
        }
      }

      if (!candidates.size && !removals.size) return;
    }

    const changed = [...candidates], removed = [...removals];

    const refresh = (index: ImageIndexingService | OtherFileIndexingService) => scopes
      ? index.processBatch(removed, changed) : index.reconcile(true);

    const results = [await refresh(this.otherFileIndex)];

    if (this.settings.enableDataFileReads) {
      const csv = this.getCsvIndexingService();
      results.push(await (scopes ? csv.processBatch(removed, changed) : csv.reconcile(false)));
    }

    if (this.imageIndex.enabled) results.push(await refresh(this.imageIndex));
    this.recordExternalFailures(results);
    if (!scopes) this.reportUnindexedExternalFiles();
    if (!this.closing) await this.database.saveToDisk();
    QueryRefreshRegistry.scheduleAutoRefresh(scopes ? ['other_files', 'image_files', ...[...changed, ...removed].filter(isDataFilePath)] : undefined);
  }

  private externalConfigurationKey(): string {
    const usable = this.externalRoots.roots().filter(root => (root.state === 'ready' || retainsRows(root.state)) && root.extensions.length > 0);

    return JSON.stringify([usable.map(root => [root.path, root.extensions]), this.settings.excludePatterns]);
  }

  public async updateExternalRootSettings(): Promise<void> {
    this.externalRoots.updateRoots();
    this.externalRoots.startWatching();
    this.syncExternalSchedules();
    this.publishExternalRootStatus();
    const key = this.externalConfigurationKey();
    if (key === this.externalSettingsKey) return;
    this.externalSettingsKey = key;
    if (this.closing) return;

    this.externalRefresh = this.externalRoots.exclusive(() => this.runExternalRefresh());
    await this.externalRefresh;
  }

  public getExternalRootStatus(): readonly ExternalRootStatus[] {
    const indexed = this.indexedCountsBySource();

    const skipped = this.externalSkippedCounts();

    return this.externalRoots.statuses().map(status => ({ ...status, filesIndexed: indexed.get(comparablePath(status.path)) ?? 0,
      filesSkipped: skipped.get(comparablePath(status.path)) ?? 0 }));
  }

  private claimsExternalFile(path: string): boolean {
    return this.snapshotIndexes.some(([index]) => index.selected(path))
      || (this.settings.enableDataFileReads && isDataFilePath(path));
  }

  private externalSkippedCounts(): Map<string, number> {
    const signature = [this.externalRoots.revision(), this.settings.indexImageMetadata, this.settings.enableDataFileReads,
      this.settings.indexingInterval, this.settings.otherFileContentExtensions.join(','), this.settings.excludePatterns.join(',')].join('|');

    if (signature === this.skippedSignature) return this.skippedCounts;
    const counts = new Map<string, number>();

    for (const file of this.externalRoots.files()) {
      if (this.claimsExternalFile(file.path)) continue;
      const source = this.externalRoots.sourceFor(file.path);
      if (!source) continue;
      const key = comparablePath(source);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    this.skippedCounts = counts;
    this.skippedSignature = signature;

    return counts;
  }

  private noteExternalRows(rows: readonly { source: string }[]): void {
    if (rows.some(row => row.source !== 'vault')) this.publishExternalRootStatus();
  }

  private indexedCountsBySource(): Map<string, number> {
    const counts = new Map<string, number>();

    const add = (source: string, rows: number) => {
      const key = comparablePath(source);
      counts.set(key, (counts.get(key) ?? 0) + rows);
    };

    for (const [index] of this.snapshotIndexes) {
      for (const [source, rows] of index.sourceCounts()) {
        add(source, rows);
      }
    }

    for (const source of this.getDataFileSources()) {
      const root = this.externalRoots.sourceFor(source.path);
      if (root) add(root, 1);
    }

    return counts;
  }

  private imageConfigurationKey(): string {
    return JSON.stringify([this.settings.indexImageMetadata, this.settings.excludePatterns]);
  }

  public async updateImageSettings(): Promise<void> {
    const key = this.imageConfigurationKey();
    if (key === this.imageSettingsKey) return;
    this.imageSettingsKey = key;
    this.imageIndex.updateSelection();
    if (this.closing) return;

    this.imageSweep = this.runImageSweep(false);
    await this.imageSweep;
  }

  private otherFileConfigurationKey(): string {
    return JSON.stringify([this.settings.otherFileContentExtensions, this.settings.excludePatterns, this.settings.maxFileSizeKB, this.settings.enabledFeatures.indexContent]);
  }

  public async updateOtherFileContentSettings(): Promise<void> {
    this.preparedWrites.updateAccess();
    const key = this.otherFileConfigurationKey();
    if (key === this.otherFileSettingsKey) return;
    this.otherFileIndex.updateSelection();

    if (!this.settings.enabledFeatures.indexContent) {
      await this.database.run("UPDATE notes SET content = '', content_status = 'not_indexed' WHERE content_status = 'ready'");
    }

    await this.otherFileIndex.reconcile(true);
    await this.database.saveToDisk();
    this.otherFileSettingsKey = key;
  }

  public async updateCsvSettings(): Promise<void> {
    this.preparedWrites.updateAccess();
    const readsChanged = this.tabularFileReadsEnabled !== this.settings.enableDataFileReads;
    this.tabularFileReadsEnabled = this.settings.enableDataFileReads;
    if (!readsChanged) return;

    try {
      if (this.csvIndexingService) await this.csvIndexingService.updateSettings();
      else {
        if (this.getIndexingStatus().isIndexing) await this.waitForIndexing();
        await this.transferToMainThread();
        await this.getCsvIndexingService().updateSettings();
      }

      this.csvStartupError = undefined;
      await this.database.saveToDisk();
    }
    catch (error) {
      this.csvStartupError = error; throw error;
    }
    finally {
      window.setTimeout(() => { void QueryRefreshRegistry.refreshAll({ force: true }); }, 0);
    }
  }

  public renameProviderDefinitions(previousPath: string, currentPath: string): string[] {
    const paths = this.providerSnapshots.sourcePaths().filter(path => path === previousPath || path.startsWith(`${previousPath}/`));

    for (const path of paths) {
      const destination = currentPath + path.slice(previousPath.length);
      const file = this.app.vault.getAbstractFileByPath(destination);

      if (file instanceof TFile && file.extension === 'md' && this.shouldIndexFile(file)) {
        this.providerSnapshots.renamePath(path, destination);
      }
    }

    return paths;
  }

  public discardPreview(id: string): void { this.preparedWrites.discard(id); }

  public async getDataFileColumnNames(results: readonly Record<string, unknown>[]): Promise<readonly string[] | undefined> {
    return this.dataFileColumns.get(results);
  }

  private csvHeadersForResults(results: readonly Record<string, unknown>[], dependencies: CsvQueryDependenciesResult): readonly string[] | undefined {
    if (!results.length || dependencies.hasEmptyView || !dependencies.relations.length) return undefined;

    for (const name of dependencies.relations) {
      if (!this.providerSnapshots.ready(name) && !this.csvIndexingService?.hasReadyRelation(name)) return undefined;
    }

    return Object.freeze(Object.keys(results[0]).filter(column => !/^_vq_/i.test(column)));
  }

  private getOtherFileWriteService(): OtherFileWriteService {
    if (!(this.database instanceof VaultDatabase)) throw new Error('File writes are waiting for the main database.');
    const database = this.database;

    return this.otherFileWriteService ??= new OtherFileWriteService(this.app, database, this.otherFileIndex,
      this.settings, this.preparedWrites,
      paths => this.refreshWrittenFiles(paths));
  }

  private async refreshWrittenFiles(paths: string[]): Promise<string[]> {
    const files: TFile[] = [], removed: string[] = [];

    for (const path of new Set(paths)) {
      this.invalidateOtherFileContents(path);
      this.invalidateDataFile(path);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) files.push(file);
      else removed.push(path);
    }

    try {
      const result = await this.processRealtimeIndexBatch(removed, files, true);
      const errors = [...result.failedPaths, ...result.failedRemovalPaths].map(path => `Index refresh failed: ${path}`);

      for (const file of files) {
        const other = this.otherFileIndex.state(file.path);
        if (other && other.content_status !== 'ready') errors.push(`${file.path}: ${other.content_error ?? other.content_status}`);
        const csv = this.getDataFileSources().find(source => source.path === file.path);
        if (csv && csv.status !== 'ready') errors.push(`${file.path}: ${csv.error ?? csv.status}`);
      }

      return errors;
    } finally {
      QueryRefreshRegistry.scheduleAutoRefresh();
    }
  }

  private getCsvWriteService(): CsvWriteService {
    if (!(this.database instanceof VaultDatabase)) throw new Error('CSV writes are waiting for the main database.');

    return this.csvWriteService ??= new CsvWriteService(this.app, this.database, this.getCsvIndexingService(), this.settings, this.preparedWrites, paths => this.refreshWrittenFiles(paths));
  }

  private getCsvIndexingService(): DataFileIndexingService {
    if (this.csvIndexingService) return this.csvIndexingService;
    if (!(this.database instanceof VaultDatabase)) throw new Error('CSV indexing is waiting for the main database.');

    const vault = this.app.vault;

    const csvSource = {
      getFiles: () => [...vault.getFiles(), ...this.externalRoots.files()],
      adapter: {
        stat: async (path: string) => {
          if (!this.externalRoots.has(path)) return vault.adapter.stat(path);
          const file = this.externalRoots.file(path);

          return file ? { size: file.stat.size, mtime: file.stat.mtime, type: 'file' } : null;
        },
        readBinary: (path: string) => this.externalRoots.has(path) ? this.externalRoots.readAll(path) : vault.adapter.readBinary(path),
      },
    };

    this.csvIndexingService = new DataFileIndexingService(csvSource, this.settings, this.database, async publication => {
      this.preparedWrites.invalidate('data-file', publication.kind === 'reset' ? undefined : csvPublicationPath(publication));
      const mirror = this.queryMirror;

      if (mirror) {
        try {
          await publishCsvToMirror(mirror, publication);
        }
        catch (error) {
          if (this.queryMirror === mirror) this.disableQueryMirror(`CSV publication failed: ${getErrorMessage(error)}`);
        }
      }

      if (publication.kind === 'ready') this.emitIndexed([publication.document.path], publication.isUpdate ?? false, 'csv');
      else if (publication.kind === 'unavailable') this.emitIndexed([publication.source.path], true, 'csv');
      else if (publication.kind === 'remove') this.emit('file-removed', { path: publication.path });

      if (publication.kind === 'reset') QueryRefreshRegistry.scheduleAutoRefresh();
      else QueryRefreshRegistry.scheduleAutoRefresh([csvPublicationPath(publication)]);
    }, async () => {
      await this.database.saveToDisk();
      QueryRefreshRegistry.scheduleAutoRefresh();
    }, { selects: (path: string) => this.externalRoots.selects(path), retains: (path: string) => this.externalRoots.retains(path) });

    return this.csvIndexingService;
  }

  public getPerformanceStats(): IndexingStats | null {
    return this.indexingService.getPerformanceStats();
  }

  public async rebuildTableViews(): Promise<void> {
    await this.database.schema.rebuildTableViews(this.settings.enableDynamicTableViews);
  }

  public async execute(sql: string, params: unknown[] = [], noteSource?: NoteSource): Promise<number> {
    if (noteSource) sql = await resolveQueryTemplate(sql, this.app, noteSource);
    this.assertProviderSnapshotWriteAllowed(sql);

    if (this.containsBlockedSQL(sql, true)) {
      throw new Error(ERROR_MESSAGES.QUERY_UNSAFE_OPERATIONS);
    }

    // Defining a view or trigger stores its body without invoking its action functions.
    const executedStatements = splitSqlStatements(sql).filter(statement =>
      parseSQLObjectName(statement, 'VIEW') === null && parseSQLObjectName(statement, 'TRIGGER') === null);
    const fileActions = executedStatements.some(statement => hasSqlFileActionFunctions(statement) || detectDmlOperationInSql(statement) !== null);
    const actions = executedStatements.some(hasSqlActionFunctions);
    const selects = executedStatements.some(statement => detectSqlOperation(statement) === 'select');
    const assertWriteAccess = () => {
      if (!this.settings.allowWriteOperations) throw new Error(ERROR_MESSAGES.WRITE_OPERATIONS_DISABLED_APPLY);
      if (this.settings.indexingInterval !== 'realtime') throw new Error('File actions require real-time indexing.');
    };

    if (fileActions) assertWriteAccess();

    if (actions || selects) {
      if (this.getIndexingStatus().isIndexing) await this.waitForIndexing();
      await this.transferToMainThread();
      await this.ensureCsvQueryReady(sql, true);
      await this.processPendingTriggerActions();
    }

    if (fileActions) assertWriteAccess();

    const customViewRegistration = this.getCustomViewRegistration(sql);
    const droppedCustomViewName = this.getDroppedCustomViewName(sql);

    const previousViewSql = customViewRegistration
      ? this.registeredCustomViews.get(customViewRegistration.viewName)
      : undefined;

    if (customViewRegistration) {
      this.registeredCustomViews.set(customViewRegistration.viewName, customViewRegistration.sql);
      this.customViewKeys = undefined;
    }

    const pendingActionsBefore = this.triggerFunctions.getPendingActionsCount();

    try {
      let rowsModified = 0;

      for (const statement of splitSqlStatements(sql)) {
        // SELECT must be consumed completely so an action runs for every matching row.
        if (detectSqlOperation(statement) === 'select') {
          await this.database.all(statement, params as (string | number | null | Uint8Array)[]);
        }
        else {
          rowsModified += await this.database.run(statement, params as (string | number | null | Uint8Array)[]);
        }
      }

      this.triggerFunctions.clearCurrentDeferKey();
      if (actions || fileActions || selects) await this.processPendingTriggerActions();

      if (droppedCustomViewName) {
        this.registeredCustomViews.delete(droppedCustomViewName);
        this.customViewKeys = undefined;
      }

      return rowsModified;
    }
    catch (error) {
      this.triggerFunctions.limitPendingActions(pendingActionsBefore);

      if (customViewRegistration) {
        if (previousViewSql !== undefined) {
          this.registeredCustomViews.set(customViewRegistration.viewName, previousViewSql);
          this.customViewKeys = undefined;
        }
        else {
          this.registeredCustomViews.delete(customViewRegistration.viewName);
          this.customViewKeys = undefined;
        }
      }

      throw error;
    }
    finally {
      this.triggerFunctions.clearCurrentDeferKey();
    }
  }

  private getCustomViewRegistration(sql: string): { viewName: string; sql: string } | null {
    const statement = stripSqlComments(sql);

    const viewName = parseSQLObjectName(statement, 'VIEW');

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

  public async updateProviderSettings(): Promise<void> {
    this.tableProviderService.setEnabled(this.settings.enableThirdPartyProviderTables, this.settings.enableRemoteDataReads);
    await this.ensureRemoteDataProviders();
  }

  private async ensureRemoteDataProviders(): Promise<void> {
    const registered = new Set(this.tableProviderService.getRegisteredProviders().map(provider => provider.id));
    const pending = (['csv', 'json'] as const).filter(format => !registered.has(webProviderId(format)));
    if (!this.settings.enableRemoteDataReads || !pending.length) return;
    if (this.remoteDataRegistration) return this.remoteDataRegistration;

    const transport = new NativeWebCsvTransport(options => requestUrl(options));

    const registration = Promise.all(pending.map(format => this.tableProviderService.registerProvider(createWebDataProvider(format, this.settings, transport), true))).then(() => {});

    this.remoteDataRegistration = registration;

    try {
      await registration;
    }
    finally {
      if (this.remoteDataRegistration === registration) this.remoteDataRegistration = undefined;
    }
  }

  private assertProviderSnapshotWriteAllowed(sql: string, otherFileDml = false): void {
    const protectedName = (name: string): boolean => /^_vq_provider_/i.test(name) || this.providerSnapshots.owns(name);
    const targets = this.getSqlMutationTargets(sql);

    if (targets.some(name => /^_vq_image_files_/i.test(name)
      || ['image_files', 'image_metadata'].includes(sqliteIdentifierKey(name)))) {
      throw new Error('Indexed image metadata is read-only.');
    }

    if (targets.some(name => /^_vq_other_files_/i.test(name)
      || !otherFileDml && sqliteIdentifierKey(name) === 'other_files')) {
      throw new Error('Indexed file contents are read-only. Their relations and write guards are managed by VaultQuery.');
    }

    if (targets.some(protectedName)) {
      throw new Error('Provider CSV tables are read-only. Their tables and write guards are managed by the provider.');
    }
  }

  public async registerTableProvider(provider: VaultQueryTableProvider): Promise<TableProviderRegistration> {
    if (provider.tables.some(table => ['image_files', 'image_metadata'].includes(sqliteIdentifierKey(table.name)))) {
      throw new Error('The image_files and image_metadata names are reserved for indexed image metadata.');
    }

    if (provider.tables.some(table => ['other_files'].includes(sqliteIdentifierKey(table.name)))) {
      throw new Error('The other_files name is reserved for indexed file contents.');
    }

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

  public async getQueryRelations(sql: string): Promise<QueryRelations> {
    const resolved = await this.csvDependencies.resolve(sql);

    return { relations: [...resolved.relations], complete: !resolved.hasEmptyView };
  }

  public async getQueryProviderStatus(sql: string): Promise<TableProviderStatus[]> {
    if (!this.tableProviderService.hasProviderDefinitionDiscovery()) return [];
    const referenced = new Set([...this.getSqlAnalysis(sql).exactReferences].map(name => sqliteIdentifierKey(name)));
    if (!referenced.size) return [];

    return this.tableProviderService.getStatus().filter(status => referenced.has(sqliteIdentifierKey(status.tableName)));
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
      sources: {
        otherFiles: this.otherFileIndex.enabled,
        images: this.imageIndex.enabled,
        externalRoots: this.externalRoots.enabled,
        csv: this.settings.enableDataFileReads,
        remoteData: this.settings.enableRemoteDataReads,
        providerTables: this.settings.enableThirdPartyProviderTables,
      },
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
    return this.runQuery(sql, noteSource);
  }

  private isIndexedRelation(name: string): boolean {
    const relation = sqliteIdentifierKey(name);

    return isDataFilePath(name) || ['other_files', 'image_files', 'image_metadata', '_vq_data_files', 'notes'].includes(relation)
      || Boolean(TABLE_FEATURE_CONFIG[relation]) || this.providerSnapshots.owns(name);
  }

  private readsOnlySnapshotProviders(relations: readonly string[]): boolean {
    if (!relations.some(name => this.providerSnapshots.owns(name))) return false;

    return relations.every(name => this.providerSnapshots.owns(name) || !this.tableProviderService.hasRegisteredTable(name));
  }

  private async runQuery(sql: string, noteSource: NoteSource | undefined): Promise<QueryResult[]> {
    const started = performance.now();

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attemptQuery(sql, noteSource);
      } catch (error) {
        if (!(error instanceof QueryIterationInvalidatedError) || attempt >= QUERY_RETRY_ATTEMPTS) {
          this.logQueryFailure(error, noteSource, started);
          throw error;
        }

        logger.debug('Query interrupted by an index change; retrying', { attempt: attempt + 1 });
        await new Promise<void>(resolve => window.setTimeout(resolve, QUERY_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  private async attemptQuery(sql: string, noteSource: NoteSource | undefined): Promise<QueryResult[]> {
    const prepared = await this.prepareQuery(sql, noteSource);
    sql = prepared.sql;
    let dependencies = prepared.dependencies;

    const finish = (rows: QueryResult[]): QueryResult[] => {
      this.recordCsvHeaders(rows, dependencies);
      this.tableProviderService.refreshSnapshotsAfterRead(dependencies.relations);

      return rows;
    };

    const mirror = this.queryMirror;

    if (mirror) {
      try {
        const rows = await mirror.allReadOnly(sql) as QueryResult[];

        return finish(rows);
      } catch (error) {
        if (!this.handleQueryMirrorError(mirror, error)) throw error;
        dependencies = await this.prepareReadDependencies(sql, dependencies);
      }
    }

    const run = () => this.executeQuerySafely(() => this.database.allReadOnly(sql)) as Promise<QueryResult[]>;

    try {
      return finish(await run());
    } catch (error) {
      if (!this.indexingWorker || !/no such function/i.test(getErrorMessage(error))) throw error;

      if (this.getIndexingStatus().isIndexing) await this.waitForIndexing();
      await this.transferToMainThread();
      dependencies = await this.prepareReadDependencies(sql, dependencies);

      return finish(await run());
    }
  }

  private async prepareQuery(sql: string, noteSource: NoteSource | undefined): Promise<{ sql: string; dependencies: CsvQueryDependenciesResult }> {
    if (noteSource) sql = await resolveQueryTemplate(sql, this.app, noteSource);
    this.assertProviderSnapshotWriteAllowed(sql);
    if (!isSelectOnly(sql)) throw new Error(ERROR_MESSAGES.QUERY_UNSAFE_OPERATIONS);
    const warning = this.checkForUnindexedData(sql);
    if (warning) throw new Error(warning);
    if (this.providerMirrorSync) await this.providerMirrorSync;

    return { sql, dependencies: await this.prepareReadDependencies(sql) };
  }

  private recordCsvHeaders(rows: QueryResult[], dependencies: CsvQueryDependenciesResult): void {
    this.dataFileColumns.set(rows, this.csvHeadersForResults(rows, dependencies));
  }

  private handleQueryMirrorError(mirror: WorkerDatabase, error: unknown, fallback = true): boolean {
    if (error instanceof QueryIterationInvalidatedError) return false;
    const message = getErrorMessage(error);
    if (/no such (table|function|column|view)/i.test(message)) {
      logger.debug('Query mirror cannot serve this query', { message, fallback });
    } else if (MIRROR_READ_LOST_RACE.test(message)) {
      logger.debug('Query mirror read lost a race with a forwarded write', { message, fallback });
    } else if (error instanceof WorkerUnavailableError) {
      if (this.queryMirror === mirror) this.disableQueryMirror(message);
    } else return false;

    return fallback;
  }

  private logQueryFailure(error: unknown, noteSource: NoteSource | undefined, started: number): void {
    logger.error('Query failed', {
      error: getErrorMessage(error),
      sourcePath: typeof noteSource === 'string' ? noteSource : noteSource?.path,
      elapsedMs: Math.round(performance.now() - started),
    });
  }

  public async *iterateQueryBatches(sql: string, noteSource?: NoteSource, options: QueryIterationOptions = {}): AsyncGenerator<QueryResult[]> {
    const started = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signals = [options.signal, this.queryIterationAbort.signal].filter((signal): signal is AbortSignal => Boolean(signal));

    for (const signal of signals) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }

    const signal = controller.signal;
    let iterator: AsyncGenerator<Record<string, unknown>[]> | undefined;
    let dependencies: CsvQueryDependenciesResult | undefined;
    let delivered = false;
    let mirror: WorkerDatabase | null = null;

    try {
      throwIfQueryAborted(signal);

      if (options.snapshot) {
        const rows = await awaitQueryOperation(this.attemptQuery(sql, noteSource), signal);
        const columns = this.dataFileColumns.get(rows);

        for (const batch of consumeQuerySnapshot(rows, signal)) {
          if (columns) this.dataFileColumns.set(batch, columns);

          yield batch;
        }

        return;
      }

      const prepared = await awaitQueryOperation(this.prepareQuery(sql, noteSource), signal);
      sql = prepared.sql;
      dependencies = prepared.dependencies;
      mirror = this.queryMirror;
      iterator = (mirror ?? this.database).iterateQueryBatches(sql, [], { signal });

      while (true) {
        let batch: IteratorResult<Record<string, unknown>[]>;

        try {
          batch = await awaitQueryOperation(iterator.next(), signal);
        }
        catch (error) {
          throwIfQueryAborted(signal);
          if (error instanceof QueryIterationInvalidatedError || !mirror) throw error;

          if (!this.handleQueryMirrorError(mirror, error, !delivered)) throw error;

          ({ iterator, dependencies } = await this.restartOnMainDatabase(iterator, sql, dependencies, signal));
          mirror = null;
          continue;
        }

        throwIfQueryAborted(signal);
        if (batch.done) break;
        const rows = batch.value as QueryResult[];
        this.recordCsvHeaders(rows, dependencies);
        delivered = true;

        yield rows;
      }
    } catch (error) {
      if (signal.aborted) logger.debug('Query iteration canceled', { elapsedMs: Math.round(performance.now() - started) });
      else this.logQueryFailure(error, noteSource, started);
      throw error;
    } finally {
      abort();

      for (const signal of signals) {
        signal.removeEventListener('abort', abort);
      }

      if (iterator) void iterator.return(undefined).catch(error => logger.debug('Query iteration cleanup', getErrorMessage(error)));
      if (dependencies) this.tableProviderService.refreshSnapshotsAfterRead(dependencies.relations);
    }
  }

  private async restartOnMainDatabase(iterator: AsyncGenerator<Record<string, unknown>[]>, sql: string, dependencies: CsvQueryDependenciesResult | undefined, signal: AbortSignal) {
    await iterator.return(undefined);
    const refreshed = await awaitQueryOperation(this.prepareReadDependencies(sql, dependencies), signal);

    return { iterator: this.database.iterateQueryBatches(sql, [], { signal }), dependencies: refreshed };
  }

  private async prepareReadDependencies(sql: string, context?: CsvQueryDependenciesResult): Promise<CsvQueryDependenciesResult> {
    let dependencies = context ? await this.csvDependencies.revalidate(sql, context) : await this.csvDependencies.resolve(sql);

    for (let attempt = 0; attempt < 3; attempt++) {
      let waited = false;
      let readinessError: Error | undefined;

      try {
        if (this.providerRefreshWave && this.queryDependsOnProviderReadiness(sql)
          && !this.readsOnlySnapshotProviders(dependencies.relations)) {
          waited = true;
          await this.providerRefreshWave;
        }

        if (dependencies.relations.some(name => this.providerSnapshots.owns(name) && !this.providerSnapshots.ready(name))) {
          waited = true;
          await this.providerSnapshots.assertReadable(dependencies.relations);
        }

        if (dependencies.relations.some(name => isDataFilePath(name) || sqliteIdentifierKey(name) === '_vq_data_files')) {
          waited = true;
          await this.ensureCsvQueryReady(sql, false, dependencies);
        }
      } catch (error) {
        readinessError = error instanceof Error ? error : new Error(getErrorMessage(error));
      }

      const current = waited ? await this.csvDependencies.revalidate(sql, dependencies) : dependencies;
      if (current !== dependencies) { dependencies = current; continue; }

      if (readinessError) {
        this.tableProviderService.refreshSnapshotsAfterRead(dependencies.relations);
        throw readinessError;
      }

      if (dependencies.relations.some(name => this.providerSnapshots.owns(name) && !this.providerSnapshots.ready(name))) continue;

      for (const name of dependencies.relations) {
        if (isDataFilePath(name)) this.csvIndexingService?.assertReady(name);
        else if (sqliteIdentifierKey(name) === '_vq_data_files') assertDataFileReads(this.settings);
      }

      return dependencies;
    }

    return dependencies;
  }

  private queryDependsOnProviderReadiness(sql: string): boolean {
    const referencedTables = this.getSqlAnalysis(sql).exactReferences;
    this.customViewKeys ??= new Set(Array.from(this.registeredCustomViews.keys(), sqliteIdentifierKey));

    for (const tableName of referencedTables) {
      if (this.tableProviderService.hasRegisteredTable(tableName) || this.customViewKeys.has(sqliteIdentifierKey(tableName))) return true;
    }

    return false;
  }

  private async ensureCsvQueryReady(sql: string, waitForPending = false, context?: CsvQueryDependenciesResult): Promise<void> {
    const dependencies = new Set<string>();
    let readsRegistry = false;
    const resolved = context ?? await this.csvDependencies.resolve(sql);

    for (const name of resolved.relations) {
      const key = sqliteIdentifierKey(name);
      if (isDataFilePath(name)) { dependencies.add(name); continue; }
      if (key === '_vq_data_files') { readsRegistry = true; continue; }
    }

    if (!dependencies.size && !readsRegistry) return;
    assertDataFileReads(this.settings);
    if (this.csvStartupError) throw new Error(getErrorMessage(this.csvStartupError));
    if (!this.csvIndexingService) await (this.fileSweep ?? this.indexingService.waitForIndexing(30_000));
    if (!this.csvIndexingService) await this.fileSweep;
    if (this.csvStartupError) throw new Error(getErrorMessage(this.csvStartupError));
    if (!this.csvIndexingService) throw new Error('CSV indexing has not completed yet.');

    if (waitForPending && this.csvIndexingService.hasPendingSources(dependencies)) {
      await this.csvPendingIndexWaiter?.();
    }

    await this.csvIndexingService.waitForIdle();
    assertDataFileReads(this.settings);

    for (const path of dependencies) {
      this.csvIndexingService.assertReady(path);
    }
  }

  public async getIndexedFiles(): Promise<Array<{ path: string; modified: number }>> {
    return getIndexedFilesFromDatabase(this.database);
  }

  public async needsIndexing(file: TFile): Promise<boolean> {
    if (isDataFilePath(file.path)) {
      if (!this.shouldIndexFile(file)) return false;
      const source = this.getDataFileSources().find(source => source.path === file.path);

      return !source || source.status !== 'ready' || source.mtime !== file.stat.mtime || source.sourceBytes !== file.stat.size;
    }

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
    this.closing = true;
    this.queryIterationAbort.abort();
    QueryRefreshRegistry.clearScopeResolver(this.scopeResolver);

    const step = async (name: string, action: () => unknown): Promise<void> => {
      try {
        await action();
      }
      catch (error) {
        logger.warn(`Shutdown step failed: ${name}`, error);
      }
    };

    try {
      await step('external roots', () => {
        if (this.externalReconcileTimer !== undefined) window.clearTimeout(this.externalReconcileTimer);
        this.pendingExternalScopes.clear();
        this.pendingExternalFullRefresh = false;
        window.clearInterval(this.externalStatusPoll);
        this.syncExternalSchedules();
        this.externalRoots.dispose();
      });

      await step('reindex', () => this.reindexQueue);
      await step('file sweep', () => this.fileSweep);
      await step('mirror restoration', () => this.mirrorRestoration);
      await step('prepared writes', () => this.preparedWrites.dispose());

      await step('other files', () => {
        this.otherFileIndex.dispose();

        return this.otherFileIndex.waitForIdle();
      });

      await step('images', () => {
        this.imageIndex.dispose();

        return this.imageIndex.waitForIdle();
      });

      await step('image sweep', () => this.imageSweep);

      await step('external refresh', () => this.externalRefresh);

      await step('provider snapshots', () => {
        this.providerSnapshots.dispose();

        return this.providerSnapshots.waitForIdle();
      });

      await step('CSV indexing', () => {
        this.csvIndexingService?.dispose();

        return this.csvIndexingService?.waitForIdle();
      });

      await step('triggers', () => this.triggerService?.destroy());

      await step('query mirror', () => {
        const mirror = this.queryMirror;
        if (!mirror) return;
        this.queryMirror = null;
        this.queryMirrorDisabledReason = 'plugin shutdown';

        return VaultQueryAPI.closeQuietly(mirror);
      });

      await this.database.close();
    }
    finally {
      CustomSQLFunctions.clearSyncHandlers();
    }
  }

  public async checkDatabaseHealthAsync(): Promise<DatabaseHealth> {
    return this.database.checkHealth();
  }

  public async getSchemaTables(): Promise<SchemaTable[]> {
    if (!this.csvStartupError) await this.csvIndexingService?.waitForIdle();
    const database = this.database;
    const versions = await Promise.all(['main', 'temp'].map(schema => database.all(`PRAGMA ${schema}.schema_version`)));
    const version = versions.map(rows => Number(rows[0].schema_version)).join(':');

    if (this.schemaViews?.database !== database || this.schemaViews.version !== version) {
      this.schemaViews = { database, version, views: new CachedSchemaViews(database.schema) };
    }

    return this.describeSchema(this.schemaViews.views);
  }

  private async describeSchema(views: SchemaViews): Promise<SchemaTable[]> {
    return [
      ...await schemaTables(this.settings, views),
      ...this.tableProviderService.getSchemaTables(),
      ...dataFileSchemaTables(this.getDataFileSources()),
      ...OTHER_FILE_SCHEMA,
      ...(this.imageIndex.enabled ? IMAGE_SCHEMA : []),
    ];
  }

  public async getSchemaInfo(): Promise<string> {
    const markdown = renderSchemaTables(await this.getSchemaTables());
    const disabled = disabledSchemaTables(this.settings);

    return disabled.length ? `${markdown}\n\n> [!note] Disabled Tables\n> ${disabled.join(', ')} - enable in Settings > VaultQuery\n` : markdown;
  }

  public async getAutocompleteSchema(): Promise<AutocompleteSchemaShape> {
    if (!this.csvStartupError) await this.csvIndexingService?.waitForIdle();

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
          ...(relationName === 'other_files' ? { write: row.name === 'content' ? 'insert-update' as const : row.name === 'path' ? 'insert' as const : 'read-only' as const } : {}),
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

    const viewColumns = new Map(pragmaResults.map(({ relationName, pragmaRows }) => [relationName,
      pragmaRows.flatMap(row => typeof row.name === 'string' ? [row.name] : []),
    ]));
    const tables = await this.describeSchema({
      getViewNames: () => relations.filter(relation => relation.type === 'view').map(relation => relation.name),
      getViewColumns: view => viewColumns.get(view) ?? [],
    });
    const schema = mergeDeclaredProviderTables({ relations, columns, functions }, this.tableProviderService.getDeclaredTables());

    return describeAutocompleteSchema(schema, [...tables, ...IMAGE_SCHEMA]);
  }

  private shouldIncludeAutocompleteRelation(relation: AutocompleteSchemaRelationInfo): boolean {
    if (this.providerSnapshots.owns(relation.name) && !this.providerSnapshots.ready(relation.name)) return false;

    if (isDataFilePath(relation.name)) {
      return this.getDataFileSources().some(source => source.status === 'ready' && source.relationName === relation.name);
    }

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

      throw this.queryError(errorMessage, missingTable);
    }
  }

  private async retryQueryWithFriendlyError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    }
    catch (error: unknown) {
      const message = getErrorMessage(error);

      throw this.queryError(message, this.getMissingTableName(message));
    }
  }

  private queryError(errorMessage: string, missingTable: string | null): Error {
    const message = this.getFriendlyErrorMessage(errorMessage);
    const pendingProvider = missingTable !== null && this.settings.enableThirdPartyProviderTables && !this.isIndexedRelation(missingTable);

    return pendingProvider ? new ProviderSnapshotUnavailableError(message, missingTable) : new Error(message);
  }

  private getMissingTableName(errorMessage: string): string | null {
    if (errorMessage.includes('no such table')) {
      const tableMatch = errorMessage.match(/no such table:\s*([^\r\n]+)/);

      return tableMatch?.[1]?.trim().toLowerCase() ?? null;
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
        return `${errorMessage}\n\nNote: ${config.featureName} is disabled. Enable it in Settings > VaultQuery > ${config.settingLabel}`;
      }
    }

    return errorMessage;
  }

  private getSqlMutationTargets(sql: string): readonly string[] {
    const analysis = this.getSqlAnalysis(sql);

    analysis.mutationTargets ??= splitSqlStatements(sql).flatMap(statement => {
      const target = extractSqlMutationTarget(statement);
      const ddl = extractSqlDdlObject(statement);

      return [target, ddl?.name, ddl?.relation].filter((name): name is string => Boolean(name));
    });

    return analysis.mutationTargets;
  }

  private readonly scopeResolver = async (sql: string, tables: ReadonlySet<string>): Promise<boolean> => {
    if (this.closing) return false;
    const resolved = await this.csvDependencies.resolve(sql);
    if (resolved.hasEmptyView) return true;

    return resolved.relations.some(name => tables.has(sqliteIdentifierKey(name)));
  };

  private getSqlAnalysis(sql: string): { referencedTables: Set<string>; exactReferences: Set<string>; mutationTargets?: string[] } {
    const cached = this.sqlAnalysisCache.get(sql);

    if (cached) {
      // Refresh insertion order so eviction below is least-recently-used.
      this.sqlAnalysisCache.delete(sql);
      this.sqlAnalysisCache.set(sql, cached);

      return cached;
    }

    const exactReferences = extractSqlReferencedTables(sql);
    const analysis = { exactReferences, referencedTables: new Set(Array.from(exactReferences, name => name.toLowerCase())) };

    this.sqlAnalysisCache.set(sql, analysis);

    while (this.sqlAnalysisCache.size > VaultQueryAPI.SQL_ANALYSIS_CACHE_LIMIT) {
      const oldestKey = this.sqlAnalysisCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.sqlAnalysisCache.delete(oldestKey);
    }

    return analysis;
  }

  private checkForUnindexedData(sql: string): string | null {
    const tableNames = this.getSqlAnalysis(sql).referencedTables;

    const warnings = Object.entries(TABLE_FEATURE_CONFIG)
      .filter(([table, config]) => tableNames.has(table) && !this.settings.enabledFeatures[config.setting])
      .map(([table, config]) =>
        `${table.charAt(0).toUpperCase() + table.slice(1)} table is referenced but ${config.featureName.toLowerCase()} is disabled. Enable it in Settings > VaultQuery > ${config.settingLabel}`
      );

    return warnings.length > 0 ? warnings.join('\n\n') : null;
  }

  public async previewQuery(sql: string, params: unknown[] = [], noteSource?: NoteSource): Promise<PreviewResult> {
    if (noteSource) {
      sql = await resolveQueryTemplate(sql, this.app, noteSource);
    }

    const otherFileDml = this.getSqlMutationTargets(sql).some(name => sqliteIdentifierKey(name) === 'other_files');
    if (otherFileDml) otherFileWriteStatements(sql);
    this.assertProviderSnapshotWriteAllowed(sql, otherFileDml);

    if (this.containsBlockedSQL(sql, true)) {
      throw new Error(ERROR_MESSAGES.PREVIEW_UNSAFE_OPERATIONS);
    }

    if (!this.settings.allowWriteOperations) {
      throw new Error(ERROR_MESSAGES.WRITE_OPERATIONS_DISABLED);
    }

    if (otherFileDml) {
      if (this.getIndexingStatus().isIndexing) await this.waitForIndexing();
      await this.transferToMainThread();
      await this.ensureCsvQueryReady(sql, true);

      return this.getOtherFileWriteService().preview(sql, params);
    }

    const csvTarget = csvWriteTarget(sql);

    if (csvTarget) {
      assertDataFileReads(this.settings);
      await this.ensureCsvQueryReady(`SELECT * FROM ${quoteIdentifier(csvTarget)}`, true);
      await this.ensureCsvQueryReady(sql, true);

      return this.getCsvWriteService().preview(csvTarget, sql, params);
    }

    await this.ensureCsvQueryReady(sql, true);

    // Don't wait for indexing - previews are read-only (they rollback)
    // and can work with partial data

    if (!(this.database instanceof VaultDatabase)) {
      throw new Error('Preview is not supported in web worker mode');
    }

    try {
      const database = this.database;
      const assertAccess = this.preparedWrites.captureAccess('markdown');
      const result = await database.previewDML(sql, params);

      this.validatePreviewResult(result);
      const changes = await this.writeSyncService.prepareChanges(result);
      const preview = copyPreviewForApply(result);

      result.planId = this.preparedWrites.add('markdown', [...changes.sources.keys()],
        { preview, changes, database }, assertAccess);

      return result;
    }
    catch (error: unknown) {
      // Don't log syntax errors to console - they're expected during editing
      if (error instanceof FilePreviewStaleError) throw error;
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

    const kind = this.preparedWrites.kind(previewResult.planId);

    if (!kind) {
      if (isDataFilePath(previewResult.table)) assertDataFileReads(this.settings);
      throw new FilePreviewStaleError();
    }

    if (kind === 'other_files') {
      try {
        return await this.getOtherFileWriteService().apply(previewResult.planId);
      }
      finally {
        QueryRefreshRegistry.scheduleAutoRefresh();
      }
    }

    if (kind === 'data-file') {
      assertDataFileReads(this.settings);

      try {
        return await this.getCsvWriteService().apply(previewResult.planId);
      }
      finally {
        QueryRefreshRegistry.scheduleAutoRefresh();
      }
    }

    return this.preparedWrites.consume<{
      preview: PreviewResult; changes: PreparedMarkdownChanges; database: VaultDatabase;
    }, string[]>(previewResult.planId, 'markdown', async (plan, assertAccess) => {
      assertAccess();
      let affectedPaths: string[] = [];

      try {
        affectedPaths = await this.writeSyncService.syncChanges(plan.changes, assertAccess);
        assertAccess();
        await plan.database.applyDML(plan.preview);
        await this.processPendingTriggerActions();

        return affectedPaths;
      } catch (error) {
        const paths = error instanceof FileWriteApplyError
          ? [...error.completedPaths, ...error.unknownPaths] : affectedPaths;

        if (paths.length) {
          await this.refreshWrittenFiles(paths).catch(refreshError => logger.warn('Could not refresh Markdown recovery state', refreshError));
          await this.saveToDisk().catch(saveError => logger.warn('Could not save Markdown recovery state', saveError));
        }

        if (error instanceof FileWriteApplyError) throw error;
        if (affectedPaths.length) throw new FileWriteApplyError(getErrorMessage(error), 'index', affectedPaths, [], []);
        throw error;
      } finally {
        QueryRefreshRegistry.scheduleAutoRefresh();
      }
    });
  }

  private containsBlockedSQL(sql: string, allowSchemaChanges: boolean = false): boolean {
    return disallowedSqlStatement(sql, allowSchemaChanges) !== null;
  }

  public on(event: 'file-indexed', callback: (event: FileIndexedEvent) => void): EventRef;
  public on(event: 'files-indexed', callback: (event: FilesIndexedEvent) => void): EventRef;
  public on(event: 'file-removed', callback: (event: FileRemovedEvent) => void): EventRef;
  public on(event: 'vault-indexed', callback: (event: VaultIndexedEvent) => void): EventRef;
  public on(event: 'database-lost', callback: (event: DatabaseLostEvent) => void): EventRef;
  public on(event: 'database-restored', callback: (event: DatabaseRestoredEvent) => void): EventRef;
  public on(event: 'provider-tables-changed', callback: (event: ProviderTablesChangedEvent) => void): EventRef;
  public on(event: 'external-roots-changed', callback: (event: ExternalRootsChangedEvent) => void): EventRef;
  public on<EventName extends keyof VaultQueryEvents>(event: EventName, callback: (event: VaultQueryEvents[EventName]) => void): EventRef {
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

  private emit<EventName extends keyof VaultQueryEvents>(event: EventName, data: VaultQueryEvents[EventName]): void {
    this.eventBus.emit(event, data);
  }
}
