export { declareVaultQueryProviderBlockLanguages, getVaultQueryAPI, registerVaultQueryTableProviders, waitForVaultQueryAPI, VAULTQUERY_API_READY_EVENT } from './helpers';

export type { ManagedVaultQueryTableProviderRegistration, RegisterVaultQueryTableProvidersOptions, VaultQueryAppLike, VaultQueryProviderRegistrationLogger, VaultQueryProviderRegistrationState, WaitForAPIOptions } from './helpers';

export type { ExternalRootFailure, ExternalRootStatus } from './External/ExternalRootService';
export { retainsRows } from './External/ExternalRootSettings';
export type { ExternalRoot, ExternalRootState } from './External/ExternalRootSettings';

export type { DatabaseHealth, DatabaseLostEvent, DatabaseRestoredEvent, EventRef, ExternalRootsChangedEvent, FileIndexedEvent, FileIndexedSource, FilesIndexedEvent, FileRemovedEvent, IVaultQueryAPI, QueryMirrorStatus, QueryRelations, QueryResult, VaultIndexedEvent, VaultQueryCapabilities } from './VaultQueryAPI';

export type { AutocompleteSchemaColumnInfo, AutocompleteSchemaRelationInfo, AutocompleteSchemaShape } from './utils/AutocompleteSchemaUtils';

export type { IndexedProviderDefinitionBlock, ProviderColumnDefinition, ProviderColumnType, ProviderDefinitionBlock, ProviderDefinitionBlockContext, ProviderDefinitionCompletionConfig, ProviderDefinitionCompletionItem, ProviderIndexDefinition, ProviderRefreshContext, ProviderRefreshDefinition, ProviderRefreshResult, ProviderTableSnapshot, ProviderSnapshotMetadata, ProviderRowValue, ProviderTableDefinition, ProviderTableRows, ProviderTablesChangedEvent, TableProviderRegistration, TableProviderStatus, VaultQueryTableProvider } from './Providers/TableProviderTypes';

export type { IndexingStats, NoteSource } from './types';
export type { PreviewResult } from './Services/PreviewService';
export type { CsvFormat, JsonFormat, DataFileFormat, TabularColumn, TabularColumnType, TabularDocument, TabularFormat, TabularParseLimits, TabularValue } from './Tabular/TabularTypes';
export type { QueryValue } from './Database/QueryValues';

export interface VaultQueryPlugin {
  api: import('./VaultQueryAPI').IVaultQueryAPI;
}

export { FilePreviewStaleError, FileWriteApplyError } from './WriteSync/FileWriteTypes';
export type { FileWritePhase } from './WriteSync/FileWriteTypes';

export { QueryIterationInvalidatedError } from './Database/QueryIteration';
export type { QueryIterationOptions } from './Database/QueryIteration';

export type { SchemaTable, SchemaColumnDoc } from './Database/SchemaDocumentation';
