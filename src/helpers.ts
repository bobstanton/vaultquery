/**
 * Helper functions for third-party plugins to access the VaultQuery API.
 */

import type { EventRef, IVaultQueryAPI } from './VaultQueryAPI';
import type { TableProviderRegistration, TableProviderStatus, VaultQueryTableProvider } from './Providers/TableProviderTypes';
import { getErrorMessage } from './utils/ErrorMessages';

export const VAULTQUERY_API_READY_EVENT = 'vaultquery:api-ready';

export interface WaitForAPIOptions {
  timeoutMs?: number;
  /** If true, also waits for indexing to complete before returning (default: false) */
  waitForReady?: boolean;
}

export type VaultQueryProviderRegistrationState =
  | 'registered'
  | 'vaultquery-unavailable'
  | 'feature-disabled'
  | 'failed'
  | 'disposed';

export interface VaultQueryProviderRegistrationLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string, error?: unknown) => void;
}

export interface RegisterVaultQueryTableProvidersOptions {
  /** Stable plugin id used in log messages */
  pluginId: string;
  /** Provider objects to register with VaultQuery */
  providers: VaultQueryTableProvider[] | (() => VaultQueryTableProvider[]);
  /** Optional logger; defaults to console */
  logger?: VaultQueryProviderRegistrationLogger;
  /** Initial VaultQuery wait settings */
  wait?: WaitForAPIOptions;
  /** Retry when VaultQuery is unavailable or temporarily fails. Defaults to true. */
  retry?: boolean;
  /** Delay before background retry attempts. Defaults to 5000ms. */
  retryDelayMs?: number;
  /** Maximum background retry attempts. Omit for unlimited retries while not disposed. */
  maxRetryAttempts?: number;
}

export interface ManagedVaultQueryTableProviderRegistration {
  readonly state: VaultQueryProviderRegistrationState;
  readonly registrations: TableProviderRegistration[];
  readonly lastError?: unknown;
  getStatus(providerId?: string): Promise<TableProviderStatus[]>;
  retryNow(): Promise<VaultQueryProviderRegistrationState>;
  dispose(): Promise<void>;
}

export type VaultQueryAppLike = object & {
  plugins?: {
    plugins?: Record<string, { api?: IVaultQueryAPI }>;
  };
  workspace?: {
    on(name: string, callback: () => void): unknown;
    offref(ref: unknown): void;
  };
};

/**
 * Get the VaultQuery API if the plugin is loaded and enabled.
 * Returns null if VaultQuery is not installed or not yet initialized.
 *
 * @param app - An Obsidian-like app object with plugin registry access
 * @returns The VaultQuery API or null if not available
 *
 * @example
 * ```typescript
 * import { getVaultQueryAPI } from 'vaultquery/api';
 *
 * const api = getVaultQueryAPI(this.app);
 * if (api) {
 *   const results = await api.query('SELECT path FROM notes');
 * }
 * ```
 */
export function getVaultQueryAPI(app: VaultQueryAppLike): IVaultQueryAPI | null {
  return app.plugins?.plugins?.vaultquery?.api ?? null;
}

/**
 * Wait for the VaultQuery API to become available with exponential backoff.
 * Useful when a plugin loads before VaultQuery, especially on mobile.
 *
 * @param app - An Obsidian-like app object with plugin registry access
 * @param options - Configuration for retry behavior
 * @returns The VaultQuery API or null if not available after all retries
 *
 * @example
 * ```typescript
 * import { waitForVaultQueryAPI } from 'vaultquery/api';
 *
 * // In a plugin's onload():
 * const api = await waitForVaultQueryAPI(this.app);
 *
 * if (!api) {
 *   console.warn('VaultQuery not available');
 *   return;
 * }
 *
 * // API is ready
 * await api.waitForIndexing();
 * const results = await api.query('SELECT path FROM notes');
 * ```
 */
export async function waitForVaultQueryAPI(app: VaultQueryAppLike, options?: WaitForAPIOptions): Promise<IVaultQueryAPI | null> {
  const timeoutMs = options?.timeoutMs ?? 10_000;

  let api = getVaultQueryAPI(app);

  const workspace = app.workspace;
  if (api === null && workspace) {
    api = await new Promise<IVaultQueryAPI | null>((resolve) => {
      let timeoutId: number | null = null;
      let ref: unknown = null;
      let settled = false;

      const finish = (result: IVaultQueryAPI | null): void => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        if (ref !== null) workspace.offref(ref);
        resolve(result);
      };

      ref = workspace.on(VAULTQUERY_API_READY_EVENT, () => finish(getVaultQueryAPI(app)));
      timeoutId = window.setTimeout(() => finish(getVaultQueryAPI(app)), timeoutMs);

      // The API may have appeared between the initial check and subscribing.
      const current = getVaultQueryAPI(app);
      if (current !== null) {
        finish(current);
      }
    });
  }

  if (api !== null && options?.waitForReady) {
    await api.waitForIndexing();
  }

  return api;
}

const DEFAULT_PROVIDER_WAIT_OPTIONS: WaitForAPIOptions = {
  timeoutMs: 30_000,
};

function resolveProviderLogger(logger?: VaultQueryProviderRegistrationLogger): Required<VaultQueryProviderRegistrationLogger> {
  return {
    debug: logger?.debug ?? ((message) => console.debug(message)),
    info: logger?.info ?? ((message) => console.debug(message)),
    warn: logger?.warn ?? ((message) => console.warn(message)),
    error: logger?.error ?? ((message, error) => console.error(message, error)),
  };
}

function resolveProviders(providers: VaultQueryTableProvider[] | (() => VaultQueryTableProvider[])): VaultQueryTableProvider[] {
  return typeof providers === 'function' ? providers() : providers;
}

export async function registerVaultQueryTableProviders(app: VaultQueryAppLike, options: RegisterVaultQueryTableProvidersOptions): Promise<ManagedVaultQueryTableProviderRegistration> {
  const manager = new VaultQueryTableProviderRegistrationManager(app, options);
  await manager.start();
  return manager;
}

class VaultQueryTableProviderRegistrationManager implements ManagedVaultQueryTableProviderRegistration {
  private readonly logger: Required<VaultQueryProviderRegistrationLogger>;
  private readonly retryEnabled: boolean;
  private readonly retryDelayMs: number;
  private currentState: VaultQueryProviderRegistrationState = 'vaultquery-unavailable';
  private currentRegistrations: TableProviderRegistration[] = [];
  private currentLastError: unknown;
  private disposed = false;
  private retryAttempts = 0;
  private retryTimer: number | null = null;
  private databaseLostRef: EventRef | null = null;
  private currentApi: IVaultQueryAPI | null = null;
  private inFlight: Promise<VaultQueryProviderRegistrationState> | null = null;

  public constructor(private readonly app: VaultQueryAppLike, private readonly options: RegisterVaultQueryTableProvidersOptions) {
    this.logger = resolveProviderLogger(options.logger);
    this.retryEnabled = options.retry ?? true;
    this.retryDelayMs = options.retryDelayMs ?? 5000;
  }

  public get state(): VaultQueryProviderRegistrationState {
    return this.currentState;
  }

  public get registrations(): TableProviderRegistration[] {
    return [...this.currentRegistrations];
  }

  public get lastError(): unknown {
    return this.currentLastError;
  }

  public async start(): Promise<VaultQueryProviderRegistrationState> {
    return await this.retryNow();
  }

  public async getStatus(providerId?: string): Promise<TableProviderStatus[]> {
    const api = getVaultQueryAPI(this.app);
    return api ? api.getTableProviderStatus(providerId) : [];
  }

  public async retryNow(): Promise<VaultQueryProviderRegistrationState> {
    if (this.disposed) {
      return this.markDisposed();
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.attemptRegistration();

    try {
      return await this.inFlight;
    }
    finally {
      this.inFlight = null;
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.markDisposed();
    this.clearRetryTimer();

    const api = getVaultQueryAPI(this.app) ?? this.currentApi;
    this.unsubscribeDatabaseLost();

    if (api) {
      await this.unregisterFromApi(api);
    }

    this.currentRegistrations = [];
  }

  private async attemptRegistration(): Promise<VaultQueryProviderRegistrationState> {
    const waitOptions = { ...DEFAULT_PROVIDER_WAIT_OPTIONS, ...this.options.wait };
    this.logger.info(`[VaultQuery] ${this.options.pluginId}: waiting for VaultQuery table provider API`);
    const api = await waitForVaultQueryAPI(this.app, waitOptions);

    if (this.disposed) {
      return this.markDisposed();
    }

    if (!api) {
      this.currentState = 'vaultquery-unavailable';
      this.logger.warn(`[VaultQuery] ${this.options.pluginId}: VaultQuery API unavailable; table providers were not registered`);
      this.scheduleRetry('VaultQuery API unavailable');
      return this.currentState;
    }

    this.subscribeToDatabaseLoss(api);

    if (!api.getCapabilities().thirdPartyProviderTablesEnabled) {
      this.currentState = 'feature-disabled';
      this.logger.warn(`[VaultQuery] ${this.options.pluginId}: third-party provider tables are disabled in VaultQuery settings`);
      return this.currentState;
    }

    try {
      const providers = resolveProviders(this.options.providers);
      const nextRegistrations: TableProviderRegistration[] = [];
      for (const provider of providers) {
        if (this.disposed) {
          await this.unregisterFromApi(api);
          return this.markDisposed();
        }

        this.logger.info(`[VaultQuery] ${this.options.pluginId}: registering table provider ${provider.id}`);
        nextRegistrations.push(await api.registerTableProvider(provider));
      }

      if (this.disposed) {
        await this.unregisterFromApi(api);
        return this.markDisposed();
      }

      this.currentRegistrations = nextRegistrations;
      this.retryAttempts = 0;
      this.currentLastError = undefined;
      this.currentState = 'registered';
      this.logger.info(`[VaultQuery] ${this.options.pluginId}: registered ${this.currentRegistrations.length} table provider(s)`);
      return this.currentState;
    }
    catch (error) {
      if (this.disposed) {
        return this.markDisposed();
      }

      this.currentLastError = error;
      this.currentState = 'failed';
      this.logger.error(`[VaultQuery] ${this.options.pluginId}: table provider registration failed`, error);
      this.scheduleRetry('registration failed');
      return this.currentState;
    }
  }

  private markDisposed(): VaultQueryProviderRegistrationState {
    this.currentState = 'disposed';
    return this.currentState;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(reason: string): void {
    if (!this.retryEnabled || this.disposed || this.retryTimer !== null) return;
    if (this.options.maxRetryAttempts !== undefined && this.retryAttempts >= this.options.maxRetryAttempts) return;

    this.retryAttempts++;
    this.logger.info(`[VaultQuery] ${this.options.pluginId}: retrying table provider registration in ${this.retryDelayMs}ms (${reason})`);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.retryNow();
    }, this.retryDelayMs);
  }

  private subscribeToDatabaseLoss(api: IVaultQueryAPI): void {
    if (this.currentApi === api && this.databaseLostRef) return;

    this.unsubscribeDatabaseLost();
    this.currentApi = api;
    this.databaseLostRef = api.on('database-lost', () => {
      this.logger.warn(`[VaultQuery] ${this.options.pluginId}: database lost; table providers will be re-registered after recovery`);
      this.currentRegistrations = [];
      this.currentState = 'vaultquery-unavailable';
      this.scheduleRetry('database lost');
    });
  }

  private unsubscribeDatabaseLost(): void {
    if (this.databaseLostRef && this.currentApi) {
      this.currentApi.off(this.databaseLostRef);
    }
    this.databaseLostRef = null;
  }

  private async unregisterFromApi(api: IVaultQueryAPI): Promise<void> {
    for (const provider of resolveProviders(this.options.providers)) {
      try {
        await api.unregisterTableProvider(provider.id);
      }
      catch (error) {
        this.logger.warn(`[VaultQuery] ${this.options.pluginId}: failed to unregister table provider ${provider.id}: ${getErrorMessage(error)}`);
      }
    }
  }
}
