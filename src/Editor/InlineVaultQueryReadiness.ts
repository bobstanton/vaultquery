import type { VaultQueryAPI } from '../VaultQueryAPI';
import type { VaultQueryPluginContext } from '../types/PluginContext';

const API_WAIT_INTERVAL_MS = 100;
const INDEXING_WAIT_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export async function waitForInlineVaultQueryReady(plugin: VaultQueryPluginContext): Promise<VaultQueryAPI> {
  while (!plugin.api) {
    await sleep(API_WAIT_INTERVAL_MS);
  }

  if (plugin.settings.indexingInterval === 'startup' || plugin.settings.indexingInterval === 'realtime') {
    await plugin.api.waitForIndexing();
  }

  while (plugin.indexingStateManager.isIndexing()) {
    await sleep(INDEXING_WAIT_INTERVAL_MS);
  }

  if (!plugin.api) {
    return waitForInlineVaultQueryReady(plugin);
  }

  return plugin.api;
}
