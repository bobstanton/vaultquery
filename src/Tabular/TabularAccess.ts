import type { VaultQuerySettings } from '../Settings/Settings';

export function assertDataFileReads(settings: Pick<VaultQuerySettings, 'enableDataFileReads'>): void {
  if (!settings.enableDataFileReads) {
    throw new Error('Data file indexing is disabled. Enable "Index CSV and JSON files" in Settings > VaultQuery > Indexing > Other files.');
  }
}
