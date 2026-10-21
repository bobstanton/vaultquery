import type { IndexingReadiness } from '../Services/IndexingReadiness';
import type { Plugin } from 'obsidian';
import type { VaultQueryAPI } from '../VaultQueryAPI';
import type { VaultQuerySettings } from '../Settings/Settings';

interface IndexingStateManagerContext {
  isIndexing(): boolean;
  waitForIndexingComplete(): Promise<void>;
  queueIndexing(path: string): void;
}

export interface VaultQueryPluginContext extends Plugin {
  api: VaultQueryAPI | null;
  settings: VaultQuerySettings;
  indexingStateManager: IndexingStateManagerContext;
  saveSettings(options?: { requiresFullReindex?: boolean }): Promise<void>;
  indexingReadiness: Pick<IndexingReadiness, 'wait'>;
}
