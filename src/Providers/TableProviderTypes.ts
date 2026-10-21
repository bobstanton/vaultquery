import type { TabularDocument } from '../Tabular/TabularTypes';

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
  parse: (source: string, context: ProviderDefinitionBlockContext) => Promise<ProviderRefreshDefinition> | ProviderRefreshDefinition;
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
  existingSnapshots?: ProviderSnapshotMetadata[];
  signal?: AbortSignal;
}

export interface ProviderSnapshotMetadata {
  table: string;
  revision: string;
  asOf: number;
  validatedAt?: number;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
}

export interface ProviderTableSnapshot extends ProviderSnapshotMetadata {
  kind: 'table';
  document: TabularDocument;
}

export type ProviderRowValue = string | number | boolean | null;

export interface ProviderTableRows {
  replaceWhere?: Record<string, ProviderRowValue>;
  rows: Record<string, ProviderRowValue>[];
  asOf?: number;
  expiresAt?: number;
}

export interface ProviderRefreshResult {
  tables: Record<string, ProviderTableRows>;
  snapshots?: ProviderTableSnapshot[];
  unchangedSnapshots?: ProviderSnapshotMetadata[];
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
  definitionTables?: { format: 'csv' | 'json'; readOnly: true };
  definitionBlock: ProviderDefinitionBlock;
  refresh: (context: ProviderRefreshContext) => Promise<ProviderRefreshResult>;
  whenIdle?: () => Promise<void>;
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
  lastValidatedAt?: number;
  snapshotRevision?: string;
  snapshotState?: 'pending' | 'ready' | 'stale' | 'refreshing' | 'unavailable';
  schemaChanged?: boolean;
}

export interface IndexedProviderDefinitionBlock {
  path: string;
  language: string;
  source: string;
  blockIndex: number;
  blockHash: string;
}
