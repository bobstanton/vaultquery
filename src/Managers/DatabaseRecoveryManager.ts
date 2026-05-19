import { App, Notice } from 'obsidian';
import { VaultQueryAPI } from '../VaultQueryAPI';
import type { VaultQuerySettings } from '../Settings/Settings';
import { logger as rootLogger } from '../utils/logger';

const logger = {
  lifecycle: rootLogger.scope('Lifecycle'),
  provider: rootLogger.scope('ProviderTables'),
  recovery: rootLogger.scope('Recovery'),
};

interface DatabaseRecoveryManagerOptions {
  app: App;
  settings: VaultQuerySettings;
  getApi: () => VaultQueryAPI | null;
  setApi: (api: VaultQueryAPI) => void;
  onApiRecreated: () => void;
  reindexVault: () => Promise<void>;
  rerenderMarkdownPreviews: () => void;
}

export class DatabaseRecoveryManager {
  private lastHealthCheck: { timestamp: number; healthy: boolean } | null = null;
  private recoveryInProgress: Promise<void> | null = null;

  public constructor(private readonly options: DatabaseRecoveryManagerOptions) {}

  public async recordCurrentHealth(): Promise<void> {
    const api = this.options.getApi();
    if (!api) {
      this.lastHealthCheck = null;
      return;
    }

    const health = await api.checkDatabaseHealthAsync();
    this.lastHealthCheck = {
      timestamp: Date.now(),
      healthy: health.healthy,
    };
  }

  public async handleResume(): Promise<void> {
    const api = this.options.getApi();
    if (!api) {
      return;
    }

    const indexingStatus = api.getIndexingStatus();
    if (indexingStatus.isIndexing) {
      return;
    }

    const health = await api.checkDatabaseHealthAsync();
    const now = Date.now();

    if (this.lastHealthCheck && this.lastHealthCheck.healthy && !health.healthy) {
      logger.recovery.error('Database connection was lost after the app returned from the background', {
        previousCheck: new Date(this.lastHealthCheck.timestamp).toISOString(),
        timeSinceLastCheck: `${Math.round((now - this.lastHealthCheck.timestamp) / 1000)}s`,
        error: health.error,
        diagnostics: health.diagnostics
      });

      api.emitDatabaseLost(health.error || 'Database connection was lost after the app returned from the background.');
      new Notice('VaultQuery: Database was lost while app was in background. Reindexing...', 5000);
      await this.recover();
    }
    else if (!health.healthy) {
      logger.recovery.warn('Database unhealthy on resume', health.error);
    }

    this.lastHealthCheck = { timestamp: now, healthy: health.healthy };
  }

  public async recover(): Promise<void> {
    if (this.recoveryInProgress) {
      return this.recoveryInProgress;
    }

    this.recoveryInProgress = this.recoverDatabase();

    try {
      await this.recoveryInProgress;
    }
    finally {
      this.recoveryInProgress = null;
    }
  }

  private async recoverDatabase(): Promise<void> {
    try {
      const currentApi = this.options.getApi();
      const registeredProviders = currentApi?.getRegisteredTableProviders() ?? [];
      if (registeredProviders.length > 0) {
        logger.provider.info(`Preserving ${registeredProviders.length} third-party table provider(s) during database recovery: ${registeredProviders.map(provider => provider.id).join(',')}`);
      }

      if (currentApi) {
        try {
          await currentApi.close();
        }
        catch (error) {
          logger.recovery.warn('Error closing broken database', error);
        }
      }

      const api = await VaultQueryAPI.create(this.options.app, this.options.settings);
      this.options.setApi(api);
      logger.lifecycle.info(`API recreated after database loss: thirdPartyProviderTablesEnabled=${this.options.settings.enableThirdPartyProviderTables}`);
      this.options.onApiRecreated();

      for (const provider of registeredProviders) {
        try {
          await api.registerTableProvider(provider);
        }
        catch (error) {
          logger.provider.error(`Failed to restore table provider "${provider.id}" after database recovery`, error);
        }
      }
      if (registeredProviders.length > 0) {
        logger.provider.info(`Restored ${registeredProviders.length} third-party table provider(s) after database recovery`);
      }

      await this.options.reindexVault();
      if (registeredProviders.length > 0) {
        this.options.rerenderMarkdownPreviews();
      }

      this.lastHealthCheck = { timestamp: Date.now(), healthy: true };
      api.emitDatabaseRestored();
      new Notice('VaultQuery: Reindexing complete', 3000);
    }
    catch (error) {
      logger.recovery.error('Failed to recover from database loss', error);
      new Notice('VaultQuery: Failed to recover database. Please restart Obsidian.', 10000);
    }
  }
}
