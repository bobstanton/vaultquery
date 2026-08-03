import { requestUrl } from 'obsidian';
import type { VaultFileAdapter } from './DatabaseInterface';
import type { WasmSettings } from '../Settings/Settings';
import { getErrorMessage } from '../utils/ErrorMessages';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('WasmLoader');

// Intentionally duplicated in database.worker.ts: the worker bundle cannot
// import this module because it depends on 'obsidian'.
export const CDN_URL = 'https://sql.js.org/dist/sql-wasm.wasm';
const DEFAULT_WASM_FILENAME = 'sql-wasm.wasm';

interface WasmLoadResult {
  wasmBinary: ArrayBuffer | undefined;
  fromCdn: boolean;
}

export async function loadWasmBinary(adapter: VaultFileAdapter | null, pluginDir: string | undefined, wasmSettings?: WasmSettings): Promise<WasmLoadResult> {
  const source = wasmSettings?.source ?? 'auto';
  const customPath = wasmSettings?.customPath?.trim();

  const getLocalPath = (): string | null =>
    customPath || (pluginDir ? `${pluginDir}/${DEFAULT_WASM_FILENAME}` : null);

  const tryLoadLocal = async (): Promise<ArrayBuffer | null> => {
    const localPath = getLocalPath();
    if (!localPath || !adapter) return null;
    try {
      return await adapter.readBinary(localPath);
    }
    catch {
      return null;
    }
  };

  const loadFromCdn = async (): Promise<ArrayBuffer> => {
    const response = await requestUrl({ url: CDN_URL });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch WASM from CDN: ${response.status}`);
    }
    return response.arrayBuffer;
  };

  switch (source) {
    case 'local': {
      const localBinary = await tryLoadLocal();
      if (!localBinary) {
        const localPath = getLocalPath();
        throw new Error(`WASM source is set to 'local' but file not found at: ${localPath || '(no path configured)'}`);
      }
      return { wasmBinary: localBinary, fromCdn: false };
    }

    case 'cdn': {
      const cdnBinary = await loadFromCdn();
      return { wasmBinary: cdnBinary, fromCdn: true };
    }

    case 'auto':
    default: {
      const localBinary = await tryLoadLocal();
      if (localBinary) {
        return { wasmBinary: localBinary, fromCdn: false };
      }
      try {
        const cdnBinary = await loadFromCdn();
        return { wasmBinary: cdnBinary, fromCdn: true };
      }
      catch (error) {
        const localPath = getLocalPath();
        throw new Error(
          `Failed to load sql.js WASM. Checked local path ${localPath || '(no path configured)'} and CDN ${CDN_URL}: ${getErrorMessage(error)}`
        );
      }
    }
  }
}

export async function cacheWasmBinaryIfNeeded(result: WasmLoadResult, adapter: VaultFileAdapter | null, pluginDir: string | undefined, wasmSettings: WasmSettings | undefined): Promise<void> {
  if (!result.fromCdn || !result.wasmBinary || !wasmSettings?.cacheLocally || !adapter || !pluginDir) {
    return;
  }

  try {
    const cachePath = `${pluginDir}/${DEFAULT_WASM_FILENAME}`;
    await adapter.writeBinary(cachePath, result.wasmBinary);
    logger.debug('Cached WASM binary to:', cachePath);
  }
  catch (error) {
    logger.warn('Failed to cache WASM binary:', getErrorMessage(error));
  }
}
