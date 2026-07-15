import { loadWasmBinary, cacheWasmBinaryIfNeeded } from './WasmLoader';
import { getDatabaseDir, getDatabasePath } from '../Settings/Settings';
import type { WorkerResponse } from './worker-types';
import type { IndexNoteData } from '../types/types.d.ts';
import type { EnabledFeatures, TableStructure } from './DatabaseSchema';
import type { ISchemaManager, VaultFileAdapter } from './DatabaseInterface';
import type { TriggerFunctions } from '../Triggers/TriggerFunctions';
import type { WasmSettings } from '../Settings/Settings';
import { logger as rootLogger } from '../utils/logger';
import { getErrorMessage } from '../utils/ErrorMessages';
// @ts-expect-error - inline worker import
import DatabaseWorkerImport from './database.worker';

const logger = rootLogger.scope('WorkerDatabase');

// The inline-worker import has no static type; give it a concrete constructor
// type so its construction site is type-safe rather than `any`.
const DatabaseWorker = DatabaseWorkerImport as { new (): Worker };

const HEALTH_CHECK_RETRY_DELAY_MS = 250;
const HEALTH_CHECK_RETRY_TIMEOUT_MS = 2_000;

interface DatabaseHealth {
  healthy: boolean;
  error?: string;
  diagnostics: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

class WorkerSchemaProxy implements ISchemaManager {
  constructor(private callWorker: <T = unknown>(message: Record<string, unknown>) => Promise<T>) {}

  getAllPropertyKeys(): Promise<string[]> {
    return this.callWorker<string[]>({ type: 'getAllPropertyKeys' });
  }

  getViewNames(): Promise<string[]> {
    return this.callWorker<string[]>({ type: 'getViewNames' });
  }

  getViewColumns(viewName: string): Promise<string[]> {
    return this.callWorker<string[]>({ type: 'getViewColumns', viewName });
  }

  async rebuildPropertiesView(): Promise<void> {
    await this.callWorker({ type: 'rebuildPropertiesView' });
  }

  async rebuildTableViews(enableDynamicTableViews: boolean): Promise<void> {
    await this.callWorker({ type: 'rebuildTableViews', enableDynamicTableViews });
  }

  discoverTableStructures(): TableStructure[] {
    return [];
  }
}

export class WorkerDatabase {
  private worker: Worker;
  private pendingWorkerCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private ready: Promise<void>;
  private readyResolve!: () => void;

  private fileAdapter: VaultFileAdapter | null;
  private databasePath: string;
  private configDir: string;
  private dbLock: Promise<void> = Promise.resolve();
  public readonly useMemoryStorage: boolean;
  public readonly schema: WorkerSchemaProxy;

  /** Identifies this as a worker-based database (survives minification) */
  public readonly isWorkerMode = true;

  private constructor(fileAdapter: VaultFileAdapter | null, useMemoryStorage: boolean, databasePath: string, configDir: string) {
    this.fileAdapter = fileAdapter;
    this.useMemoryStorage = useMemoryStorage;
    this.databasePath = databasePath;
    this.configDir = configDir;

    this.worker = new DatabaseWorker();

    this.schema = new WorkerSchemaProxy(this.callWorker.bind(this));

    this.ready = new Promise(resolve => {
      this.readyResolve = resolve;
    });

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;

      if (response.type === 'ready') {
        this.readyResolve();
        return;
      }

      const pending = this.pendingWorkerCalls.get(response.id);
      if (!pending) {
        logger.warn('Received response for unknown worker call', response.id);
        return;
      }

      this.pendingWorkerCalls.delete(response.id);

      if (response.type === 'error') {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve(response.result);
      }
    };

    this.worker.onerror = (error) => {
      logger.error('Worker error', error);

      // A crashed worker will never answer; reject everything in flight so
      // callers don't hang forever.
      const message = error instanceof ErrorEvent && error.message
        ? `Database worker error: ${error.message}`
        : 'Database worker error';
      const pending = Array.from(this.pendingWorkerCalls.values());
      this.pendingWorkerCalls.clear();
      for (const call of pending) {
        call.reject(new Error(message));
      }
    };
  }

  private async callWorker<T = unknown>(message: Record<string, unknown>, timeoutMs?: number, transfer?: Transferable[]): Promise<T> {
    await this.ready;

    const id = this.nextId++;
    const workerMessage = { ...message, id };

    return new Promise<T>((resolve, reject) => {
      let timeout: number | null = null;
      const clearWorkerCallTimeout = (): void => {
        if (timeout !== null) {
          window.clearTimeout(timeout);
          timeout = null;
        }
      };

      this.pendingWorkerCalls.set(id, {
        resolve: (value: unknown) => {
          clearWorkerCallTimeout();
          resolve(value as T);
        },
        reject: (error: Error) => {
          clearWorkerCallTimeout();
          reject(error);
        }
      });

      if (timeoutMs !== undefined) {
        timeout = window.setTimeout(() => {
          this.pendingWorkerCalls.delete(id);
          reject(new Error(`Worker call "${String(message.type)}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      if (transfer && transfer.length > 0) {
        this.worker.postMessage(workerMessage, transfer);
      } else {
        this.worker.postMessage(workerMessage);
      }
    });
  }

  public static async create(configDir: string, fileAdapter: VaultFileAdapter | null = null, useMemoryStorage: boolean = true, databasePath?: string, pluginDir?: string, wasmAdapter?: VaultFileAdapter, wasmSettings?: WasmSettings): Promise<WorkerDatabase> {
    // Must match VaultDatabase: after transferToMainThread the main-thread
    // database persists via getDatabasePath, so the worker has to load/save
    // the same file.
    const actualDatabasePath = databasePath || getDatabasePath(configDir);
    const adapter = wasmAdapter || fileAdapter;

    const wasmLoadResult = await loadWasmBinary(adapter, pluginDir, wasmSettings);
    await cacheWasmBinaryIfNeeded(wasmLoadResult, adapter, pluginDir, wasmSettings, 'WorkerDatabase');
    const { wasmBinary } = wasmLoadResult;

    const instance = new WorkerDatabase(
      fileAdapter,
      useMemoryStorage,
      actualDatabasePath,
      configDir
    );

    await instance.ready;

    await instance.callWorker({
      type: 'init',
      wasmBinary: wasmBinary
    });

    if (!useMemoryStorage && fileAdapter) {
      try {
        if (await fileAdapter.exists(actualDatabasePath)) {
          const data = await fileAdapter.readBinary(actualDatabasePath);
          // Transfer ownership: the buffer is not used again on this side.
          await instance.callWorker({ type: 'import', data }, undefined, [data]);
        }
      } catch (error) {
        logger.warn('Failed to load existing database', error);
      }
    }

    return instance;
  }

  // The public methods mirror VaultDatabase over worker messages. Keep the
  // pass-through shape: the boilerplate is the worker boundary.
  public async exportDatabase(): Promise<ArrayBuffer> {
    return this.callWorker<ArrayBuffer>({ type: 'export' });
  }

  public async saveToDisk(): Promise<void> {
    if (this.useMemoryStorage || !this.fileAdapter) {
      logger.debug('Database persistence skipped', {
        reason: this.useMemoryStorage ? 'memory-storage-enabled' : 'file-adapter-unavailable',
      });
      return;
    }

    try {
      const exportStartedAt = performance.now();
      const data = await this.callWorker<ArrayBuffer>({ type: 'export' });
      const exportMs = performance.now() - exportStartedAt;
      const databaseDir = getDatabaseDir(this.configDir);

      if (!(await this.fileAdapter.exists(databaseDir))) {
        await this.fileAdapter.mkdir(databaseDir);
      }

      const writeStartedAt = performance.now();
      await this.fileAdapter.writeBinary(this.databasePath, data);
      logger.debug('Database persistence phases', {
        bytes: data.byteLength,
        exportMs: Math.round(exportMs),
        writeMs: Math.round(performance.now() - writeStartedAt),
      });
    } catch (error) {
      logger.error('Failed to save database', error);
    }
  }

  public async all(sql: string, params: (string | number | null)[] = []): Promise<Record<string, unknown>[]> {
    return this.callWorker<Record<string, unknown>[]>({
      type: 'query',
      sql,
      params
    });
  }

  public async run(sql: string, params: (string | number | null)[] = []): Promise<number> {
    return this.callWorker<number>({
      type: 'run',
      sql,
      params
    });
  }

  public async indexNote(data: IndexNoteData): Promise<void> {
    // The worker opens its own transaction for this message; hold the lock so
    // it can't interleave with a multi-message withTx() transaction.
    const releaseLock = await this.acquireDbLock();
    try {
      await this.callWorker({
        type: 'indexNote',
        data
      });
    } finally {
      releaseLock();
    }
  }

  public async indexNotesBatch(notesData: IndexNoteData[], isInitialIndexing: boolean = false, skipDiskSave: boolean = false): Promise<void> {
    const releaseLock = await this.acquireDbLock();
    try {
      await this.callWorker({
        type: 'indexNotesBatch',
        notesData,
        isInitialIndexing
      });
    } finally {
      releaseLock();
    }

    if (!skipDiskSave) {
      await this.saveToDisk();
    }
  }

  public async createIndexes(features?: EnabledFeatures): Promise<void> {
    await this.callWorker({
      type: 'createIndexes',
      features
    });
  }

  public async registerCustomFunction(name: string, source: string): Promise<void> {
    await this.callWorker({
      type: 'registerFunction',
      name,
      source
    });
  }

  public async deleteNote(path: string): Promise<void> {
    await this.callWorker({
      type: 'deleteNote',
      path
    });
  }

  public async getAllUserViews(): Promise<Array<{view_name: string; path: string; sql: string}>> {
    return this.callWorker({ type: 'getAllUserViews' });
  }

  public async getAllUserFunctions(): Promise<Array<{function_name: string; path: string; source: string}>> {
    return this.callWorker({ type: 'getAllUserFunctions' });
  }

  public async getAllUserTriggers(): Promise<Array<{trigger_name: string; path: string; trigger_sql: string; enabled: number}>> {
    return this.callWorker({ type: 'getAllUserTriggers' });
  }

  public viewNeedsRecreation(_viewName: string, _newSql: string): boolean {
    return true;
  }

  public functionNeedsRecreation(_functionName: string, _newSource: string): boolean {
    return true;
  }

  public triggerNeedsRecreation(_triggerName: string, _newSql: string): boolean {
    return true;
  }

  public async registerTrigger(triggerName: string, triggerSql: string, sourcePath?: string): Promise<void> {
    await this.callWorker({ type: 'registerTrigger', triggerName, triggerSql, sourcePath });
  }

  public async registerUserTriggers(): Promise<void> {
    await this.callWorker({ type: 'registerUserTriggers' });
  }

  public async checkHealth(timeoutMs: number = 10000): Promise<DatabaseHealth> {
    try {
      return await this.callWorker<DatabaseHealth>({ type: 'health' }, timeoutMs);
    }
    catch (error) {
      const message = getErrorMessage(error);
      const timedOut = message.includes('timed out');
      const pendingWorkerCallCount = this.pendingWorkerCalls.size;

      if (timedOut) {
        await sleep(HEALTH_CHECK_RETRY_DELAY_MS);
        try {
          const retryHealth = await this.callWorker<DatabaseHealth>({ type: 'health' }, HEALTH_CHECK_RETRY_TIMEOUT_MS);
          return {
            ...retryHealth,
            diagnostics: {
              ...retryHealth.diagnostics,
              previousHealthCheckTimedOut: true,
              previousHealthCheckError: message,
              pendingWorkerCallCountAtTimeout: pendingWorkerCallCount,
            },
          };
        }
        catch (retryError) {
          const retryMessage = getErrorMessage(retryError);
          return {
            healthy: false,
            error: retryMessage,
            diagnostics: {
              timestamp: new Date().toISOString(),
              mode: 'worker',
              workerCallTimedOut: retryMessage.includes('timed out'),
              previousHealthCheckTimedOut: true,
              previousHealthCheckError: message,
              pendingWorkerCallCountAtTimeout: pendingWorkerCallCount,
              pendingWorkerCallCount: this.pendingWorkerCalls.size,
            },
          };
        }
      }

      return {
        healthy: false,
        error: message,
        diagnostics: {
          timestamp: new Date().toISOString(),
          mode: 'worker',
          workerCallTimedOut: timedOut,
          pendingWorkerCallCount,
        },
      };
    }
  }

  public registerTriggerFunctions(_triggerFunctions: TriggerFunctions): void {
  }

  public async close(): Promise<boolean> {
    try {
      await this.saveToDisk();
      await this.callWorker({ type: 'close' });
      this.worker.terminate();
      return true;
    } catch (error) {
      logger.error('Close failed', error);
      return false;
    }
  }

  public runWithPreparedStatement(_sql: string, _params: (string | number | null)[] = []): void {
    throw new Error('runWithPreparedStatement is not supported in worker mode - use run() instead');
  }

  public async acquireDbLock(): Promise<() => void> {
    let releaseLock: () => void;
    const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
    const previousLock = this.dbLock;
    this.dbLock = lockPromise;
    await previousLock;
    return releaseLock!;
  }

  /**
   * Run `fn` inside a real transaction on the worker database.
   *
   * The lock is required because the transaction spans multiple worker
   * messages: without it, another caller (e.g. indexNote) could slip a BEGIN
   * between ours and fail, or have its writes swept up in our rollback.
   */
  public async withTx<T>(fn: () => T | Promise<T>, _opts?: { deferFK?: boolean }): Promise<T> {
    const releaseLock = await this.acquireDbLock();

    try {
      await this.callWorker({ type: 'run', sql: 'BEGIN TRANSACTION', params: [] });

      try {
        const result = await fn();
        await this.callWorker({ type: 'run', sql: 'COMMIT', params: [] });
        return result;
      }
      catch (error) {
        try {
          await this.callWorker({ type: 'run', sql: 'ROLLBACK', params: [] });
        }
        catch (rollbackError) {
          logger.error('Worker transaction rollback failed', rollbackError);
        }
        throw error;
      }
    } finally {
      releaseLock();
    }
  }

}
