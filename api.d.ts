import { TFile, EventRef } from 'obsidian';
export { EventRef } from 'obsidian';

type QueryValue = string | number | boolean | null | Uint8Array;

interface CsvFormat {
    readonly kind: 'csv';
    readonly bom: boolean;
    readonly newline: '\n' | '\r\n';
    readonly terminalNewline: boolean;
}
interface JsonFormat {
    readonly kind: 'json';
    readonly bom: boolean;
    readonly indent: string;
    readonly newline: '\n' | '\r\n';
    readonly terminalNewline: boolean;
    readonly root: string | null;
    readonly scalarRows: boolean;
    readonly unsafeIntegers: boolean;
}
type TabularFormat = CsvFormat | JsonFormat;
type DataFileFormat = TabularFormat['kind'];
type TabularColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'JSON';
interface TabularColumn {
    readonly name: string;
    readonly type: TabularColumnType;
}
type TabularValue = string | number | null;
type TabularRows = readonly (readonly TabularValue[])[];
interface TabularDocument {
    readonly path: string;
    readonly columns: readonly TabularColumn[];
    readonly rows: TabularRows;
    readonly format: TabularFormat;
    readonly source: string;
    readonly sourceBytes: number;
}
interface TabularParseLimits {
    readonly maxFileBytes: number;
    readonly maxColumns: number;
}

type Row = Record<string, unknown>;
type SqlAndParams = {
    sql: string;
    params?: unknown[];
};
type PreviewResult = {
    op: "insert" | "update" | "delete" | "multi";
    table: string;
    pkCols: string[];
    ids: unknown[][];
    rowids?: number[];
    before: Row[];
    after: Row[];
    sqlToApply: SqlAndParams[];
    multiResults?: PreviewResult[];
    planId?: string;
    dataFileColumns?: readonly string[];
};

interface IndexedDataFile {
    readonly path: string;
    readonly relationName: string | null;
    readonly columns: readonly TabularColumn[];
    readonly revision: string;
    readonly mtime: number;
    readonly sourceBytes: number;
    readonly format: TabularFormat | null;
    readonly status: 'ready' | 'unvalidated' | 'unavailable';
    readonly error: string | null;
}

type ProviderColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
interface ProviderColumnDefinition {
    name: string;
    type: ProviderColumnType;
    nullable?: boolean;
    description?: string;
}
interface ProviderIndexDefinition {
    name: string;
    columns: string[];
    unique?: boolean;
}
interface ProviderTableDefinition {
    name: string;
    description?: string;
    columns: ProviderColumnDefinition[];
    primaryKey: string[];
    indexes?: ProviderIndexDefinition[];
    defaultStaleAfterMs?: number;
}
interface ProviderRefreshDefinition {
    id: string;
    displayName?: string;
    requestedTables?: string[];
    request: Record<string, unknown>;
}
interface ProviderDefinitionBlockContext {
    path: string;
    blockIndex: number;
    blockHash: string;
}
interface ProviderDefinitionBlock {
    language: string;
    parse: (source: string, context: ProviderDefinitionBlockContext) => Promise<ProviderRefreshDefinition> | ProviderRefreshDefinition;
    completions?: ProviderDefinitionCompletionConfig;
}
interface ProviderDefinitionCompletionItem {
    label: string;
    apply?: string;
    detail?: string;
    type?: string;
}
interface ProviderDefinitionCompletionConfig {
    keys: ProviderDefinitionCompletionItem[];
    values?: Record<string, ProviderDefinitionCompletionItem[]>;
    multiValueKeys?: string[];
}
interface ProviderRefreshContext {
    providerId: string;
    definitionId: string;
    requestedTables?: string[];
    request?: Record<string, unknown>;
    existingStatus: TableProviderStatus[];
    existingSnapshots?: ProviderSnapshotMetadata[];
    signal?: AbortSignal;
}
interface ProviderSnapshotMetadata {
    table: string;
    revision: string;
    asOf: number;
    validatedAt?: number;
    expiresAt: number;
    etag?: string;
    lastModified?: string;
}
interface ProviderTableSnapshot extends ProviderSnapshotMetadata {
    kind: 'table';
    document: TabularDocument;
}
type ProviderRowValue = string | number | boolean | null;
interface ProviderTableRows {
    replaceWhere?: Record<string, ProviderRowValue>;
    rows: Record<string, ProviderRowValue>[];
    asOf?: number;
    expiresAt?: number;
}
interface ProviderRefreshResult {
    tables: Record<string, ProviderTableRows>;
    snapshots?: ProviderTableSnapshot[];
    unchangedSnapshots?: ProviderSnapshotMetadata[];
}
interface ProviderTablesChangedEvent {
    providerId: string;
    definitionId: string;
    tables: string[];
}
interface VaultQueryTableProvider {
    id: string;
    displayName: string;
    tables: ProviderTableDefinition[];
    definitionTables?: {
        format: 'csv' | 'json';
        readOnly: true;
    };
    definitionBlock: ProviderDefinitionBlock;
    refresh: (context: ProviderRefreshContext) => Promise<ProviderRefreshResult>;
    whenIdle?: () => Promise<void>;
}
interface TableProviderRegistration {
    providerId: string;
    tables: Array<{
        name: string;
    }>;
}
interface TableProviderStatus {
    providerId: string;
    displayName: string;
    tableName: string;
    rowCount: number;
    definitionId?: string;
    dataAsOf?: number;
    lastRefreshAt?: number;
    expiresAt?: number;
    lastError?: string;
    active: boolean;
    lastValidatedAt?: number;
    snapshotRevision?: string;
    snapshotState?: 'pending' | 'ready' | 'stale' | 'refreshing' | 'unavailable';
    schemaChanged?: boolean;
}
interface IndexedProviderDefinitionBlock {
    path: string;
    language: string;
    source: string;
    blockIndex: number;
    blockHash: string;
}

type ExternalRefreshMode = 'watch' | 'interval' | 'manual';
interface ExternalRoot {
    path: string;
    extensions: string[];
    refresh?: ExternalRefreshMode;
    refreshMinutes?: number;
}
type ExternalRootState = 'ready' | 'missing' | 'unreadable' | 'inside-vault' | 'unsupported-platform' | 'invalid';
interface ResolvedExternalRoot extends ExternalRoot {
    refresh: ExternalRefreshMode;
    refreshMinutes: number;
    state: ExternalRootState;
    error: string | null;
}
declare function retainsRows(state: ExternalRootState): boolean;

type NoteSource = string | TFile;

interface IndexingProgress {
  current: number;
  total: number;
  currentFile: string;
}

interface IndexingStatus {
  isIndexing: boolean;
  progress?: IndexingProgress;
}

interface IndexingStats {
  timestamp: number;
  totalFiles: number;
  totalTime: number;
  avgTimePerFile: number;
  filesPerSecond: number;
  slowFiles: Array<{
    path: string;
    size: number;
    processingTime: number;
    details: string;
  }>;
}

interface QueryIterationOptions {
    signal?: AbortSignal;
    snapshot?: boolean;
}
declare class QueryIterationInvalidatedError extends Error {
    constructor();
}

interface SqlSyntax {
    readonly keywords: ReadonlySet<string>;
    readonly functions: ReadonlySet<string>;
    readonly types: ReadonlySet<string>;
}

interface SchemaColumnDoc {
    name: string;
    type: string;
    description: string;
    defaultVal?: string;
}
interface SchemaTable {
    name: string;
    description?: string;
    isView: boolean;
    columns: SchemaColumnDoc[];
    notes: string[];
    section?: string;
    sectionNote?: string;
    details?: string[];
}

interface AutocompleteSchemaRelationInfo {
    name: string;
    type: 'table' | 'view';
    description?: string;
}
interface AutocompleteSchemaColumnInfo {
    relation: string;
    name: string;
    type: string;
    description?: string;
    write?: 'insert' | 'insert-update' | 'read-only';
}
interface AutocompleteSchemaShape {
    relations: AutocompleteSchemaRelationInfo[];
    columns: AutocompleteSchemaColumnInfo[];
    functions: string[];
}

interface ExternalRootFailure {
    path: string;
    reason: string;
}
interface ExternalRootScanStatus extends ResolvedExternalRoot {
    scanning: boolean;
    filesFound: number;
    lastScanStarted: number | null;
    lastScanCompleted: number | null;
    failures: ExternalRootFailure[];
}
interface ExternalRootStatus extends ExternalRootScanStatus {
    filesIndexed: number;
    filesSkipped: number;
}

interface FileIndexedEvent {
    path: string;
    isUpdate: boolean;
    source: FileIndexedSource;
}
type FileIndexedSource = 'note' | 'other-file' | 'image' | 'csv';
interface FilesIndexedEvent {
    paths: string[];
    isUpdate: boolean;
    source: FileIndexedSource;
}
interface ExternalRootsChangedEvent {
    roots: ExternalRootStatus[];
}
interface QueryRelations {
    relations: string[];
    complete: boolean;
}
interface FileRemovedEvent {
    path: string;
}
interface VaultIndexedEvent {
    filesIndexed: number;
    filesRemoved: number;
    isForced: boolean;
}
interface DatabaseLostEvent {
    error: string;
    timestamp: number;
}
interface DatabaseRestoredEvent {
    timestamp: number;
}
interface DatabaseHealth {
    healthy: boolean;
    error?: string;
    diagnostics: Record<string, unknown>;
}
interface QueryResult {
    [key: string]: QueryValue;
}
interface VaultQueryCapabilities {
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
interface QueryMirrorStatus {
    active: boolean;
    reason?: string;
}
interface IVaultQueryAPI {
    readonly sqlSyntax?: SqlSyntax;
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
    getIndexedFiles(): Promise<Array<{
        path: string;
        modified: number;
    }>>;
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
 * Helper functions for third-party plugins to access the VaultQuery API.
 */

declare const VAULTQUERY_API_READY_EVENT = "vaultquery:api-ready";
interface WaitForAPIOptions {
    timeoutMs?: number;
    /** If true, also waits for indexing to complete before returning (default: false) */
    waitForReady?: boolean;
}
type VaultQueryProviderRegistrationState = 'registered' | 'vaultquery-unavailable' | 'feature-disabled' | 'failed' | 'disposed';
interface VaultQueryProviderRegistrationLogger {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string, error?: unknown) => void;
}
interface RegisterVaultQueryTableProvidersOptions {
    /** Stable plugin id used in log messages */
    pluginId: string;
    /** Provider objects to register with VaultQuery */
    providers: VaultQueryTableProvider[] | (() => VaultQueryTableProvider[]);
    /** Optional logger; defaults to console */
    logger?: VaultQueryProviderRegistrationLogger;
    /** Initial VaultQuery wait settings */
    wait?: WaitForAPIOptions;
    /** Retry when VaultQuery is unavailable or temporarily fails. Defaults to true. */
    retry?: boolean;
    /** Delay before background retry attempts. Defaults to 5000ms. */
    retryDelayMs?: number;
    /** Maximum background retry attempts. Omit for unlimited retries while not disposed. */
    maxRetryAttempts?: number;
}
interface ManagedVaultQueryTableProviderRegistration {
    readonly state: VaultQueryProviderRegistrationState;
    readonly registrations: TableProviderRegistration[];
    readonly lastError?: unknown;
    getStatus(providerId?: string): Promise<TableProviderStatus[]>;
    retryNow(): Promise<VaultQueryProviderRegistrationState>;
    dispose(): Promise<void>;
}
type VaultQueryAppLike = object & {
    plugins?: {
        plugins?: Record<string, {
            api?: IVaultQueryAPI;
            declareProviderDefinitionBlockLanguages?: (languages: readonly string[]) => void;
        }>;
    };
    workspace?: {
        on(name: string, callback: () => void): unknown;
        offref(ref: unknown): void;
    };
};
declare function declareVaultQueryProviderBlockLanguages(app: VaultQueryAppLike, languages: readonly string[]): void;
/**
 * Get the VaultQuery API if the plugin is loaded and enabled.
 * Returns null if VaultQuery is not installed or not yet initialized.
 *
 * @param app - An Obsidian-like app object with plugin registry access
 * @returns The VaultQuery API or null if not available
 *
 * @example
 * ```typescript
 * import { getVaultQueryAPI } from 'vaultquery/api';
 *
 * const api = getVaultQueryAPI(this.app);
 * if (api) {
 *   const results = await api.query('SELECT path FROM notes');
 * }
 * ```
 */
declare function getVaultQueryAPI(app: VaultQueryAppLike): IVaultQueryAPI | null;
/**
 * Wait for the VaultQuery API to become available with exponential backoff.
 * Useful when a plugin loads before VaultQuery, especially on mobile.
 *
 * @param app - An Obsidian-like app object with plugin registry access
 * @param options - Configuration for retry behavior
 * @returns The VaultQuery API or null if not available after all retries
 *
 * @example
 * ```typescript
 * import { waitForVaultQueryAPI } from 'vaultquery/api';
 *
 * // In a plugin's onload():
 * const api = await waitForVaultQueryAPI(this.app);
 *
 * if (!api) {
 *   console.warn('VaultQuery not available');
 *   return;
 * }
 *
 * // API is ready
 * await api.waitForIndexing();
 * const results = await api.query('SELECT path FROM notes');
 * ```
 */
declare function waitForVaultQueryAPI(app: VaultQueryAppLike, options?: WaitForAPIOptions): Promise<IVaultQueryAPI | null>;
declare function registerVaultQueryTableProviders(app: VaultQueryAppLike, options: RegisterVaultQueryTableProvidersOptions): Promise<ManagedVaultQueryTableProviderRegistration>;

declare class FilePreviewStaleError extends Error {
    readonly code = "FILE_PREVIEW_STALE";
    constructor(message?: string);
}
type FileWritePhase = 'preflight' | 'write' | 'verify' | 'index' | 'save';
declare class FileWriteApplyError extends Error {
    readonly phase: FileWritePhase;
    readonly completedPaths: string[];
    readonly unknownPaths: string[];
    readonly untouchedPaths: string[];
    readonly failedPath?: string | undefined;
    readonly code = "FILE_WRITE_APPLY_FAILED";
    constructor(message: string, phase: FileWritePhase, completedPaths: string[], unknownPaths: string[], untouchedPaths: string[], failedPath?: string | undefined);
}

interface VaultQueryPlugin {
    api: IVaultQueryAPI;
}

export { FilePreviewStaleError, FileWriteApplyError, QueryIterationInvalidatedError, VAULTQUERY_API_READY_EVENT, declareVaultQueryProviderBlockLanguages, getVaultQueryAPI, registerVaultQueryTableProviders, retainsRows, waitForVaultQueryAPI };
export type { AutocompleteSchemaColumnInfo, AutocompleteSchemaRelationInfo, AutocompleteSchemaShape, CsvFormat, DataFileFormat, DatabaseHealth, DatabaseLostEvent, DatabaseRestoredEvent, ExternalRoot, ExternalRootFailure, ExternalRootState, ExternalRootStatus, ExternalRootsChangedEvent, FileIndexedEvent, FileIndexedSource, FileRemovedEvent, FileWritePhase, FilesIndexedEvent, IVaultQueryAPI, IndexedProviderDefinitionBlock, IndexingStats, JsonFormat, ManagedVaultQueryTableProviderRegistration, NoteSource, PreviewResult, ProviderColumnDefinition, ProviderColumnType, ProviderDefinitionBlock, ProviderDefinitionBlockContext, ProviderDefinitionCompletionConfig, ProviderDefinitionCompletionItem, ProviderIndexDefinition, ProviderRefreshContext, ProviderRefreshDefinition, ProviderRefreshResult, ProviderRowValue, ProviderSnapshotMetadata, ProviderTableDefinition, ProviderTableRows, ProviderTableSnapshot, ProviderTablesChangedEvent, QueryIterationOptions, QueryMirrorStatus, QueryRelations, QueryResult, QueryValue, RegisterVaultQueryTableProvidersOptions, SchemaColumnDoc, SchemaTable, SqlSyntax, TableProviderRegistration, TableProviderStatus, TabularColumn, TabularColumnType, TabularDocument, TabularFormat, TabularParseLimits, TabularValue, VaultIndexedEvent, VaultQueryAppLike, VaultQueryCapabilities, VaultQueryPlugin, VaultQueryProviderRegistrationLogger, VaultQueryProviderRegistrationState, VaultQueryTableProvider, WaitForAPIOptions };
