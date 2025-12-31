export const getDatabaseDir = (configDir: string): string => `${configDir}/plugins/vaultquery`;
export const getDatabasePath = (configDir: string): string => `${getDatabaseDir(configDir)}/database.db`;

export interface EnabledFeatures {
  indexContent: boolean;
  indexFrontmatter: boolean;
  indexTables: boolean;
  indexTasks: boolean;
  indexHeadings: boolean;
  indexLinks: boolean;
  indexTags: boolean;
  indexListItems: boolean;
}

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
  databaseStorage: 'memory' | 'disk';
  enabledFeatures: EnabledFeatures;
  allowWriteOperations: boolean;
  allowDeleteNotes: boolean;
  enableInlineButtons: boolean;
  inlineButtonDebounceMs: number;
  enableMarkdownRendering: boolean;
  enableDynamicTableViews: boolean;
  autoRefreshOnIndexChange: boolean;
  viewPreviewLimit: number;
  wasm: WasmSettings;
}

export function validateSettings(settings: VaultQuerySettings): void {
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
    settings.enableInlineButtons = false;
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
  enableInlineButtons: false,
  inlineButtonDebounceMs: 500,
  enableMarkdownRendering: false,
  enableDynamicTableViews: false,
  autoRefreshOnIndexChange: false,
  viewPreviewLimit: 10,
  wasm: {
    source: 'auto',
    cacheLocally: true,
    customPath: ''
  }
};