export {
  getVaultQueryAPI,
  registerVaultQueryTableProviders,
  waitForVaultQueryAPI,
} from './helpers';

export type {
  ManagedVaultQueryTableProviderRegistration,
  RegisterVaultQueryTableProvidersOptions,
  VaultQueryAppLike,
  VaultQueryProviderRegistrationLogger,
  VaultQueryProviderRegistrationState,
  WaitForAPIOptions,
} from './helpers';

export type {
  DatabaseHealth,
  DatabaseLostEvent,
  DatabaseRestoredEvent,
  EventRef,
  FileIndexedEvent,
  FileRemovedEvent,
  IVaultQueryAPI,
  QueryResult,
  VaultIndexedEvent,
} from './VaultQueryAPI';

export type {
  IndexedProviderDefinitionBlock,
  ProviderColumnDefinition,
  ProviderColumnType,
  ProviderDefinitionBlock,
  ProviderDefinitionBlockContext,
  ProviderDefinitionCompletionConfig,
  ProviderDefinitionCompletionItem,
  ProviderIndexDefinition,
  ProviderRefreshContext,
  ProviderRefreshDefinition,
  ProviderRefreshResult,
  ProviderRowValue,
  ProviderTableDefinition,
  ProviderTableRows,
  ProviderTablesChangedEvent,
  TableProviderRegistration,
  TableProviderStatus,
  VaultQueryTableProvider,
} from './Providers/TableProviderTypes';

export type { IndexingStats, NoteSource } from './types/types';
export type { PreviewResult } from './Services/PreviewService';

export interface VaultQueryPlugin {
  api: import('./VaultQueryAPI').IVaultQueryAPI;
}
