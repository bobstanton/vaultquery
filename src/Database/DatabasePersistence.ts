import type { VaultFileAdapter } from './DatabaseInterface';
import { getDatabaseDir } from '../Settings/Settings';

interface PersistenceOptions {
  useMemoryStorage: boolean;
  fileAdapter: VaultFileAdapter | null;
  configDir: string;
  databasePath: string;
  exportData: () => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;
  debug: (message: string, details: Record<string, unknown>) => void;
}

export async function persistDatabase(options: PersistenceOptions): Promise<void> {
  const { fileAdapter, useMemoryStorage } = options;

  if (useMemoryStorage || !fileAdapter) {
    options.debug('Database persistence skipped', { reason: useMemoryStorage ? 'memory-storage-enabled' : 'file-adapter-unavailable' });

    return;
  }

  const exportStartedAt = performance.now();
  const exported = options.exportData();
  const data = exported instanceof Promise ? await exported : exported;
  const exportMs = performance.now() - exportStartedAt;
  const databaseDir = getDatabaseDir(options.configDir);

  if (!(await fileAdapter.exists(databaseDir))) {
    await fileAdapter.mkdir(databaseDir);
  }

  const buffer = data instanceof Uint8Array
    ? (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer) as ArrayBuffer
    : data;

  const writeStartedAt = performance.now();
  await fileAdapter.writeBinary(options.databasePath, buffer);

  options.debug('Database persistence phases', {
    bytes: data.byteLength,
    exportMs: Math.round(exportMs),
    writeMs: Math.round(performance.now() - writeStartedAt),
  });
}
