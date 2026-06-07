import type { EnabledFeatures } from '../Database/DatabaseSchema';
import type { ConsoleLogLevel } from 'obsidian-debug-logger';

export const getDatabaseDir = (configDir: string): string => `${configDir}/plugins/vaultquery`;
export const getDatabasePath = (configDir: string): string => `${getDatabaseDir(configDir)}/database.db`;

export type { EnabledFeatures };

export type WasmSource = 'auto' | 'cdn' | 'local';
export type ContentRenderingMode = 'plain-text' | 'rendered-markdown';


export interface WasmSettings {
  source: WasmSource;
  cacheLocally: boolean;
  customPath: string;
}

export interface VaultQuerySettings {
  indexingInterval: 'realtime' | 'manual' | 'startup';
  excludePatterns: string[];
  maxFileSizeKB: number;
  databaseStorage: 'memory' | 'disk';
  enabledFeatures: EnabledFeatures;
  allowWriteOperations: boolean;
  allowDeleteNotes: boolean;
  enableJavaScriptFunctions: boolean;
  enableJavaScriptRendering: boolean;
  enableTriggers: boolean;
  enableThirdPartyProviderTables: boolean;
  enableInlineButtons: boolean;
  enableCli: boolean;
  enableCliWriteOperations: boolean;
  inlineButtonDebounceMs: number;
  contentRenderingMode: ContentRenderingMode;
  enableDynamicTableViews: boolean;
  autoRefreshOnIndexChange: boolean;
  viewPreviewLimit: number;
  wasm: WasmSettings;
  backgroundIndexing: boolean;
  debugConsoleLogLevel: ConsoleLogLevel;
}

export function normalizeSettings(settings: VaultQuerySettings): void {
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
  }

  if (!settings.enableCli) {
    settings.enableCliWriteOperations = false;
  }
}

export const DEFAULT_SETTINGS: VaultQuerySettings = {
  indexingInterval: 'realtime',
  excludePatterns: [

  ],
  maxFileSizeKB: 1000, 
  databaseStorage: 'memory', 
  enabledFeatures: {
    indexContent: true,
    indexFrontmatter: true,
    indexTables: false,
    indexTasks: true,
    indexHeadings: true,
    indexLinks: false,
    indexTags: true,
    indexListItems: false
  },
  allowWriteOperations: false,
  allowDeleteNotes: false,
  enableJavaScriptFunctions: false,
  enableJavaScriptRendering: false,
  enableTriggers: false,
  enableThirdPartyProviderTables: false,
  enableInlineButtons: false,
  enableCli: false,
  enableCliWriteOperations: false,
  inlineButtonDebounceMs: 500,
  contentRenderingMode: 'plain-text',
  enableDynamicTableViews: false,
  autoRefreshOnIndexChange: false,
  viewPreviewLimit: 10,
  wasm: {
    source: 'auto',
    cacheLocally: true,
    customPath: ''
  },
  backgroundIndexing: true,
  debugConsoleLogLevel: 'warn'
};
