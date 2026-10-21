import type { EnabledFeatures } from '../Database/DatabaseSchema';
import type { LlmSettings } from '../LLM/LlmTypes';
import { DEFAULT_LLM_SETTINGS } from '../LLM/LlmTypes';
import type { ConsoleLogLevel } from 'obsidian-debug-logger';
import { dataFileSizeLimitBytes, dataFileDefaultSizeMiB } from '../Tabular/TabularLimits';
import { logger } from '../utils/logger';
import { normalizeFileExtensions } from '../OtherFiles/OtherFileContentSettings';
import { normalizeExternalRoots } from '../External/ExternalRootSettings';
import type { ExternalRoot } from '../External/ExternalRootSettings';

export const getDatabaseDir = (configDir: string): string => `${configDir}/plugins/vaultquery`;
export const getDatabasePath = (configDir: string): string => `${getDatabaseDir(configDir)}/database.db`;

export type { EnabledFeatures };

export type WasmSource = 'auto' | 'cdn' | 'local';

export interface WasmSettings {
  source: WasmSource;
  cacheLocally: boolean;
  customPath: string;
}

export interface VaultQuerySettings {
  indexingInterval: 'realtime' | 'manual' | 'startup';
  excludePatterns: string[];
  maxFileSizeKB: number;
  enableDataFileReads: boolean;
  enableRemoteDataReads: boolean;
  dataFileMaxSizeMiB: number;
  otherFileContentExtensions: string[];
  indexImageMetadata: boolean;
  externalRoots: ExternalRoot[];
  databaseStorage: 'memory' | 'disk';
  enabledFeatures: EnabledFeatures;
  allowWriteOperations: boolean;
  allowDeleteNotes: boolean;
  enableJavaScriptFunctions: boolean;
  workerQueries: boolean;
  enableJavaScriptRendering: boolean;
  enableTriggers: boolean;
  enableThirdPartyProviderTables: boolean;
  enableInlineButtons: boolean;
  enableCli: boolean;
  enableCliWriteOperations: boolean;
  inlineButtonDebounceMs: number;
  enableDynamicTableViews: boolean;
  autoRefreshOnIndexChange: boolean;
  viewPreviewLimit: number;
  exportFolder: string;
  wasm: WasmSettings;
  llm: LlmSettings;
  backgroundIndexing: boolean;
  debugConsoleLogLevel: ConsoleLogLevel;
}

export function normalizeExportFolder(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, '').trim();
}

export function normalizeSettings(settings: VaultQuerySettings): void {
  settings.enableDataFileReads = settings.enableDataFileReads === true;
  settings.enableRemoteDataReads = settings.enableRemoteDataReads === true;
  settings.indexImageMetadata = settings.indexImageMetadata === true;
  settings.externalRoots = normalizeExternalRoots(settings.externalRoots);
  settings.otherFileContentExtensions = normalizeFileExtensions(settings.otherFileContentExtensions);
  settings.exportFolder = normalizeExportFolder(settings.exportFolder);

  if (dataFileSizeLimitBytes(settings.dataFileMaxSizeMiB) === null) {
    settings.dataFileMaxSizeMiB = dataFileDefaultSizeMiB;
    logger.warn(`Invalid dataFileMaxSizeMiB in data.json; using ${settings.dataFileMaxSizeMiB} MiB.`);
  }

  if (!settings.enabledFeatures.indexContent) {
    settings.enabledFeatures.indexTables = false;
    settings.enabledFeatures.indexTasks = false;
    settings.enableDynamicTableViews = false;
  }

  if (!settings.enabledFeatures.indexTables) {
    settings.enableDynamicTableViews = false;
  }

  if (settings.indexingInterval !== 'realtime') {
    settings.allowWriteOperations = false;
    settings.allowDeleteNotes = false;
    settings.enableInlineButtons = false;
  }

  if (!settings.allowWriteOperations) {
    settings.allowDeleteNotes = false;
    settings.enableTriggers = false;
    settings.enableInlineButtons = false;
    settings.enableCliWriteOperations = false;
    settings.llm.allowWriteOperations = false;
  }

  if (!settings.enableCli) {
    settings.enableCliWriteOperations = false;
  }

  const llm = settings.llm;

  llm.providers = llm.providers.filter(provider => provider.name.trim() !== ''
    && provider.url.trim() !== '');

  if (llm.providers.length === 0) {
    llm.defaultProviderId = null;
  }
  else if (!llm.providers.some(provider => provider.id === llm.defaultProviderId)) {
    llm.defaultProviderId = llm.providers[0].id;
  }
}

export const DEFAULT_SETTINGS: VaultQuerySettings = {
  indexingInterval: 'realtime',
  excludePatterns: [],
  maxFileSizeKB: 1000,
  enableDataFileReads: false,
  enableRemoteDataReads: false,
  dataFileMaxSizeMiB: dataFileDefaultSizeMiB,
  otherFileContentExtensions: [],
  indexImageMetadata: false,
  externalRoots: [],
  databaseStorage: 'memory',
  enabledFeatures: {
    indexContent: true,
    indexFrontmatter: true,
    indexTables: false,
    indexTasks: true,
    indexHeadings: true,
    indexLinks: false,
    indexUnresolvedLinks: false,
    indexEmbeds: false,
    indexTags: true,
    indexListItems: false,
    indexBlocks: false
  },
  allowWriteOperations: false,
  allowDeleteNotes: false,
  enableJavaScriptFunctions: false,
  workerQueries: true,
  enableJavaScriptRendering: false,
  enableTriggers: false,
  enableThirdPartyProviderTables: false,
  enableInlineButtons: false,
  enableCli: false,
  enableCliWriteOperations: false,
  inlineButtonDebounceMs: 500,
  enableDynamicTableViews: false,
  autoRefreshOnIndexChange: false,
  viewPreviewLimit: 10,
  exportFolder: 'VaultQuery Exports',
  wasm: {
    source: 'auto',
    cacheLocally: true,
    customPath: ''
  },
  llm: DEFAULT_LLM_SETTINGS,
  backgroundIndexing: true,
  debugConsoleLogLevel: 'warn'
};

export function mergeSettings(savedData: Partial<VaultQuerySettings>): VaultQuerySettings {
  const current = Object.fromEntries(Object.entries(savedData).filter(([key]) => Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)));

  return {
    ...DEFAULT_SETTINGS,
    ...current,
    otherFileContentExtensions: normalizeFileExtensions(savedData.otherFileContentExtensions),
    externalRoots: normalizeExternalRoots(savedData.externalRoots),
    enableDataFileReads: savedData.enableDataFileReads ?? DEFAULT_SETTINGS.enableDataFileReads,
    dataFileMaxSizeMiB: savedData.dataFileMaxSizeMiB ?? DEFAULT_SETTINGS.dataFileMaxSizeMiB,
    enabledFeatures: {
      ...DEFAULT_SETTINGS.enabledFeatures,
      ...savedData.enabledFeatures
    },
    wasm: {
      ...DEFAULT_SETTINGS.wasm,
      ...savedData.wasm
    },
    llm: {
      ...DEFAULT_LLM_SETTINGS,
      ...savedData.llm,
      providers: savedData.llm?.providers ?? [...DEFAULT_LLM_SETTINGS.providers]
    }
  };
}
