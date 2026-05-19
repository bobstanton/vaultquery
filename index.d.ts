/**
 * VaultQuery public API types for third-party plugin integration.
 *
 * Usage:
 *   npm install --save-dev github:bobstanton/vaultquery
 *
 *   import type { IVaultQueryAPI, QueryResult, PreviewResult } from 'vaultquery/api';
 */

import type {
  ProviderColumnType,
  ProviderColumnDefinition,
  ProviderIndexDefinition,
  ProviderTableDefinition,
  ProviderRefreshDefinition,
  ProviderDefinitionBlockContext,
  ProviderDefinitionBlock,
  ProviderDefinitionCompletionConfig,
  ProviderDefinitionCompletionItem,
  ProviderRefreshContext,
  ProviderRowValue,
  ProviderTableRows,
  ProviderRefreshResult,
  VaultQueryTableProvider,
  TableProviderRegistration,
  TableProviderStatus,
  IndexedProviderDefinitionBlock,
} from './src/Providers/TableProviderTypes';
import type {
  FileIndexedEvent,
  FileRemovedEvent,
  VaultIndexedEvent,
  DatabaseLostEvent,
  DatabaseRestoredEvent,
  DatabaseHealth,
  EventRef,
  IVaultQueryAPI,
} from './src/VaultQueryAPI';
import type { NoteSource, IndexingStats } from './src/types/types';

/**
 * Query result row - a record with string keys and SQL-compatible values.
 */
export interface QueryResult {
  [key: string]: string | number | boolean | null;
}

/**
 * Preview result from a DML operation (INSERT, UPDATE, DELETE).
 */
export interface PreviewResult {
  query: string;
  params: unknown[];
  tableName: string;
  operationType: 'INSERT' | 'UPDATE' | 'DELETE';
  beforeRows: QueryResult[];
  afterRows: QueryResult[];
  affectedRowCount: number;
}

export type {
  ProviderColumnType,
  ProviderColumnDefinition,
  ProviderIndexDefinition,
  ProviderTableDefinition,
  ProviderRefreshDefinition,
  ProviderDefinitionBlockContext,
  ProviderDefinitionBlock,
  ProviderDefinitionCompletionConfig,
  ProviderDefinitionCompletionItem,
  ProviderRefreshContext,
  ProviderRowValue,
  ProviderTableRows,
  ProviderRefreshResult,
  VaultQueryTableProvider,
  TableProviderRegistration,
  TableProviderStatus,
  IndexedProviderDefinitionBlock,
};

export type {
  FileIndexedEvent,
  FileRemovedEvent,
  VaultIndexedEvent,
  DatabaseLostEvent,
  DatabaseRestoredEvent,
  DatabaseHealth,
  EventRef,
  IVaultQueryAPI,
};

export type { NoteSource, IndexingStats };

/**
 * The VaultQuery plugin instance (for use with app.plugins.getPlugin).
 */
export interface VaultQueryPlugin {
  api: IVaultQueryAPI;
}

export {
  getVaultQueryAPI,
  registerVaultQueryTableProviders,
  waitForVaultQueryAPI,
} from './src/helpers';

export type {
  ManagedVaultQueryTableProviderRegistration,
  RegisterVaultQueryTableProvidersOptions,
  VaultQueryAppLike,
  VaultQueryProviderRegistrationLogger,
  VaultQueryProviderRegistrationState,
  WaitForAPIOptions,
} from './src/helpers';
