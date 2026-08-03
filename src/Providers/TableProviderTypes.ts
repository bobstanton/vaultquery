export type ProviderColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

export interface ProviderColumnDefinition {
  name: string;
  type: ProviderColumnType;
  nullable?: boolean;
  description?: string;
}

export interface ProviderIndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface ProviderTableDefinition {
  name: string;
  description?: string;
  columns: ProviderColumnDefinition[];
  primaryKey: string[];
  indexes?: ProviderIndexDefinition[];
  defaultStaleAfterMs?: number;
}

export interface ProviderRefreshDefinition {
  id: string;
  displayName?: string;
  requestedTables?: string[];
  request: Record<string, unknown>;
}

export interface ProviderDefinitionBlockContext {
  path: string;
  blockIndex: number;
  blockHash: string;
}

export interface ProviderDefinitionBlock {
  language: string;
  parse: (
    source: string,
    context: ProviderDefinitionBlockContext
  ) => Promise<ProviderRefreshDefinition> | ProviderRefreshDefinition;
  completions?: ProviderDefinitionCompletionConfig;
}

export interface ProviderDefinitionCompletionItem {
  label: string;
  apply?: string;
  detail?: string;
  type?: string;
}

export interface ProviderDefinitionCompletionConfig {
  keys: ProviderDefinitionCompletionItem[];
  values?: Record<string, ProviderDefinitionCompletionItem[]>;
  multiValueKeys?: string[];
}

export interface ProviderRefreshContext {
  providerId: string;
  definitionId: string;
  requestedTables?: string[];
  request?: Record<string, unknown>;
  existingStatus: TableProviderStatus[];
}

export type ProviderRowValue = string | number | boolean | null;

export interface ProviderTableRows {
  replaceWhere?: Record<string, ProviderRowValue>;
  rows: Record<string, ProviderRowValue>[];
  /**
   * Timestamp, in epoch milliseconds, for when the provider data was fetched or last updated.
   * If omitted, VaultQuery uses the materialization time.
   */
  asOf?: number;
  /**
   * Timestamp, in epoch milliseconds, for when this provider data should expire.
   * If omitted, VaultQuery uses the table's default expiration window from materialization time.
   */
  expiresAt?: number;
}

export interface ProviderRefreshResult {
  tables: Record<string, ProviderTableRows>;
}

export interface ProviderTablesChangedEvent {
  providerId: string;
  definitionId: string;
  tables: string[];
}

export interface VaultQueryTableProvider {
  id: string;
  displayName: string;
  tables: ProviderTableDefinition[];
  definitionBlock: ProviderDefinitionBlock;
  refresh: (context: ProviderRefreshContext) => Promise<ProviderRefreshResult>;
}

export interface TableProviderRegistration {
  providerId: string;
  tables: Array<{
    name: string;
  }>;
}

export interface TableProviderStatus {
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
}

export interface IndexedProviderDefinitionBlock {
  path: string;
  language: string;
  source: string;
  blockIndex: number;
  blockHash: string;
}
