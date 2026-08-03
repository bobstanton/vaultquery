import { logger as rootLogger } from '../utils/logger';
import type { VaultQueryAPI } from '../VaultQueryAPI';
import type { VaultQueryPluginContext } from '../types/PluginContext';

const logger = rootLogger.scope('InlineReadiness');

const API_WAIT_INTERVAL_MS = 100;
const API_WAIT_TIMEOUT_MS = 30_000;
const INDEXING_WAIT_INTERVAL_MS = 250;

let apiTimeoutLogged = false;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export async function waitForInlineVaultQueryReady(plugin: VaultQueryPluginContext): Promise<VaultQueryAPI> {
  const deadline = Date.now() + API_WAIT_TIMEOUT_MS;

  for (;;) {
    while (!plugin.api) {
      if (Date.now() >= deadline) {
        if (!apiTimeoutLogged) {
          apiTimeoutLogged = true;
          logger.error(`VaultQuery API did not become available within ${API_WAIT_TIMEOUT_MS}ms - inline queries will not render`);
        }
        throw new Error('VaultQuery API is not available');
      }
      await sleep(API_WAIT_INTERVAL_MS);
    }

    const api = plugin.api;
    if (plugin.settings.indexingInterval === 'startup' || plugin.settings.indexingInterval === 'realtime') {
      await api.waitForIndexing();
    }

    while (plugin.indexingStateManager.isIndexing()) {
      await sleep(INDEXING_WAIT_INTERVAL_MS);
    }

    if (plugin.api) {
      return plugin.api;
    }
  }
}
