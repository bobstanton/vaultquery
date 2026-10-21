import type { VaultQueryAPI } from '../VaultQueryAPI';
import type { VaultQueryPluginContext } from '../types/PluginContext';

export async function waitForInlineVaultQueryReady(plugin: VaultQueryPluginContext): Promise<VaultQueryAPI> {
  for (;;) {
    const api = await plugin.indexingReadiness.wait();
    await plugin.indexingStateManager.waitForIndexingComplete();
    await api.waitForInitialQueryReadiness();
    if (plugin.api === api) return api;
  }
}
