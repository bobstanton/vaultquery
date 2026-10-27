import { requestUrl } from 'obsidian';
import type { VaultFileAdapter } from './DatabaseInterface';
import type { WasmSettings } from '../Settings/Settings';
import { logger as rootLogger } from '../utils/logger';
import { CDN_URL, WASM_CACHE_FILENAME } from './SqlJsVersion';

const logger = rootLogger.scope('WasmLoader');

interface WasmLoadResult {
  wasmBinary: ArrayBuffer;
  fromCdn: boolean;
}

export async function loadWasmBinary(adapter: VaultFileAdapter | null, pluginDir: string | undefined, wasmSettings?: WasmSettings): Promise<WasmLoadResult> {
  const source = wasmSettings?.source ?? 'auto';
  const filename = source === 'local' ? 'sql-wasm.wasm' : WASM_CACHE_FILENAME;
  const localPath = wasmSettings?.customPath?.trim() || (pluginDir ? `${pluginDir}/${filename}` : null);

  if (source !== 'cdn') {
    if (localPath && adapter && await adapter.exists(localPath)) {
      return { wasmBinary: await adapter.readBinary(localPath), fromCdn: false };
    }
    if (source === 'local') {
      throw new Error(`WASM source is set to 'local' but file not found at: ${localPath || '(no path configured)'}`);
    }
  }

  const response = await requestUrl({ url: CDN_URL });
  if (response.status < 200 || response.status >= 300) throw new Error(`Failed to fetch WASM from ${CDN_URL}: HTTP ${response.status}`);
  return { wasmBinary: response.arrayBuffer, fromCdn: true };
}

export async function cacheWasmBinaryIfNeeded(result: WasmLoadResult, adapter: VaultFileAdapter | null, pluginDir: string | undefined, wasmSettings: WasmSettings | undefined): Promise<void> {
  if (!result.fromCdn || !wasmSettings?.cacheLocally || !adapter || !pluginDir) return;
  try {
    await adapter.writeBinary(`${pluginDir}/${WASM_CACHE_FILENAME}`, result.wasmBinary);
  } catch (error) {
    logger.warn('Failed to cache WASM binary:', error);
  }
}
