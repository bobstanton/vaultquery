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

export type { IndexedProviderDefinitionBlock, ProviderColumnDefinition, ProviderColumnType, ProviderDefinitionBlock, ProviderDefinitionBlockContext, ProviderDefinitionCompletionConfig, ProviderDefinitionCompletionItem, ProviderIndexDefinition, ProviderRefreshContext, ProviderRefreshDefinition, ProviderRefreshResult, ProviderRowValue, ProviderSnapshotMetadata, ProviderTableDefinition, ProviderTableRows, ProviderTableSnapshot, ProviderTablesChangedEvent, TableProviderRegistration, TableProviderStatus, VaultQueryTableProvider };
