import { persistDatabase } from './DatabasePersistence';
import { runDatabaseTransaction } from './DatabaseTransactions';
import type { SqlParameter } from './QueryValues';
import { loadWasmBinary, cacheWasmBinaryIfNeeded } from './WasmLoader';
import { getDatabasePath } from '../Settings/Settings';
import type { WorkerRequestBody, WorkerResponse } from './worker-types';
import type { IndexNoteData } from '../types';
import type { EnabledFeatures, TableStructure } from './DatabaseSchema';
import type { ISchemaManager, VaultFileAdapter } from './DatabaseInterface';
import type { TriggerFunctions } from '../Triggers/TriggerFunctions';
import type { WasmSettings } from '../Settings/Settings';
import type { DatabaseHealth } from '../VaultQueryAPI';
import { DatabaseLock } from './DatabaseCore';
import { iterateQueryCursor, QueryIterationInvalidatedError, throwIfQueryAborted } from './QueryIteration';
import type { QueryBatch, QueryIterationOptions } from './QueryIteration';
import type { SqlStatement } from './SqlHelpers';
import type { UserViewRow, UserFunctionRow, UserTriggerRow } from './DatabaseCore';
import { logger as rootLogger } from '../utils/logger';
import { getErrorMessage } from '../utils/ErrorMessages';
// @ts-expect-error - inline worker import
import DatabaseWorkerImport from './database.worker';
import { sleep } from '../utils/SerialQueue';

const logger = rootLogger.scope('WorkerDatabase');

// The inline-worker import has no static type; give it a concrete constructor
// type so its construction site is type-safe rather than `any`.
const DatabaseWorker = DatabaseWorkerImport as { new (): Worker };

const HEALTH_CHECK_RETRY_DELAY_MS = 250;
const HEALTH_CHECK_RETRY_TIMEOUT_MS = 2_000;
const WORKER_SETUP_TIMEOUT_MS = 30_000;

export class WorkerUnavailableError extends Error {}
class WorkerTimeoutError extends WorkerUnavailableError {}


class WorkerSchemaProxy implements ISchemaManager {
  constructor(private callWorker: <T = unknown>(message: WorkerRequestBody) => Promise<T>) {}

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

  async rebuildTableViews(enableDynamicTableViews: boolean): Promise<boolean> {
    return Boolean(await this.callWorker({ type: 'rebuildTableViews', enableDynamicTableViews }));
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
  private readyReject!: (error: Error) => void;
  private closed = false;

  private fileAdapter: VaultFileAdapter | null;
  private databasePath: string;
  private configDir: string;
  private readonly dbLock = new DatabaseLock();
  public readonly useMemoryStorage: boolean;
  public readonly schema: WorkerSchemaProxy;

  private constructor(fileAdapter: VaultFileAdapter | null, useMemoryStorage: boolean, databasePath: string, configDir: string) {
    this.fileAdapter = fileAdapter;
    this.useMemoryStorage = useMemoryStorage;
    this.databasePath = databasePath;
    this.configDir = configDir;

    this.worker = new DatabaseWorker();

    this.schema = new WorkerSchemaProxy(this.callWorker.bind(this));

    this.ready = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new WorkerTimeoutError('Database worker startup timed out')), WORKER_SETUP_TIMEOUT_MS);
      this.readyResolve = () => { window.clearTimeout(timeout); resolve(); };
      this.readyReject = error => { window.clearTimeout(timeout); reject(error); };
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
        pending.reject(response.name === 'QueryIterationInvalidatedError' ? new QueryIterationInvalidatedError() : new Error(response.error));
      } else {
        pending.resolve(response.result);
      }
    };

    this.worker.onerror = (error) => {
      logger.error('Worker error', error);
      this.closed = true;
      this.worker.terminate();

      // A crashed worker will never answer; reject everything in flight so
      // callers don't hang forever.
      const message = error instanceof ErrorEvent && error.message
        ? `Database worker error: ${error.message}`
        : 'Database worker error';

      this.readyReject(new WorkerUnavailableError(message));
      const pending = Array.from(this.pendingWorkerCalls.values());
      this.pendingWorkerCalls.clear();

      for (const call of pending) {
        call.reject(new WorkerUnavailableError(message));
      }
    };
  }

  private async callWorker<T = unknown>(message: WorkerRequestBody, timeoutMs?: number, transfer?: Transferable[]): Promise<T> {
    await this.ready;
    if (this.closed && message.type !== 'close') throw new WorkerUnavailableError('Database worker closed');

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
          reject(new WorkerTimeoutError(`Worker call "${message.type}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      try {
        if (transfer && transfer.length > 0) {
          this.worker.postMessage(workerMessage, transfer);
        } else {
          this.worker.postMessage(workerMessage);
        }
      } catch (error) {
        this.pendingWorkerCalls.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        this.pendingWorkerCalls.delete(id);
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
    await cacheWasmBinaryIfNeeded(wasmLoadResult, adapter, pluginDir, wasmSettings);
    const { wasmBinary } = wasmLoadResult;

    const instance = new WorkerDatabase(
      fileAdapter,
      useMemoryStorage,
      actualDatabasePath,
      configDir
    );

    try {
      await instance.ready;
      await instance.callWorker({ type: 'init', wasmBinary }, WORKER_SETUP_TIMEOUT_MS);

      if (!useMemoryStorage && fileAdapter && await fileAdapter.exists(actualDatabasePath)) {
        await instance.importDatabase(await fileAdapter.readBinary(actualDatabasePath));
      }
    } catch (error) {
      instance.worker.terminate();
      throw error;
    }

    return instance;
  }

  // The public methods mirror VaultDatabase over worker messages. Keep the
  // pass-through shape: the boilerplate is the worker boundary.
  public async exportDatabase(): Promise<ArrayBuffer> {
    return this.callWorker<ArrayBuffer>({ type: 'export' });
  }

  public async importDatabase(data: ArrayBuffer): Promise<void> {
    await this.callWorker({ type: 'import', data }, WORKER_SETUP_TIMEOUT_MS, [data]);
  }

  public async saveToDisk(): Promise<void> {
    try {
      await persistDatabase({
        useMemoryStorage: this.useMemoryStorage,
        fileAdapter: this.fileAdapter,
        configDir: this.configDir,
        databasePath: this.databasePath,
        exportData: () => this.callWorker<ArrayBuffer>({ type: 'export' }),
        debug: (message, details) => logger.debug(message, details),
      });
    } catch (error) {
      logger.error('Failed to save database', error);
    }
  }

  public async all(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
    return this.callWorker<Record<string, unknown>[]>({
      type: 'query',
      sql,
      params
    });
  }

  public async allReadOnly(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
    return this.callWorker<Record<string, unknown>[]>({ type: 'query', sql, params, readOnly: true });
  }

  public iterateQueryBatches(sql: string, params: SqlParameter[] = [], options: QueryIterationOptions = {}): AsyncGenerator<Record<string, unknown>[]> {
    const locked = async <T>(request: WorkerRequestBody): Promise<T> => {
      const release = await this.acquireDatabaseLock();

      try {
        throwIfQueryAborted(options.signal);

        return await this.callWorker<T>(request);
      } finally {
        release();
      }
    };

    return iterateQueryCursor({
      open: () => locked<number>({ type: 'queryOpen', sql, params }),
      next: cursor => {
        throwIfQueryAborted(options.signal);

        return this.callWorker<QueryBatch>({ type: 'queryNext', cursor });
      },
      close: async cursor => {
        if (!this.closed) await this.callWorker({ type: 'queryClose', cursor });
      },
    }, options.signal);
  }

  public async run(sql: string, params: SqlParameter[] = []): Promise<number> {
    return this.callWorker<number>({
      type: 'run',
      sql,
      params
    });
  }

  public async runBatch(statements: SqlStatement[]): Promise<void> {
    if (!statements.length) return;
    const release = await this.acquireDatabaseLock();

    try {
      await this.callWorker({ type: 'runBatch', statements });
    }
    finally {
      release();
    }
  }

  public async indexNote(data: IndexNoteData): Promise<void> {
    // The worker opens its own transaction for this message; hold the lock so
    // it can't interleave with a multi-message withTx() transaction.
    const releaseLock = await this.acquireDatabaseLock();

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
    const releaseLock = await this.acquireDatabaseLock();

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

  public async getAllUserViews(): Promise<UserViewRow[]> {
    return this.callWorker({ type: 'getAllUserViews' });
  }

  public async getAllUserFunctions(): Promise<UserFunctionRow[]> {
    return this.callWorker({ type: 'getAllUserFunctions' });
  }

  public async getAllUserTriggers(): Promise<UserTriggerRow[]> {
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

  public async checkHealth(timeoutMs: number = 10000): Promise<DatabaseHealth> {
    try {
      return await this.callWorker<DatabaseHealth>({ type: 'health' }, timeoutMs);
    }
    catch (error) {
      let finalError: unknown = error;

      if (error instanceof WorkerTimeoutError) {
        await sleep(HEALTH_CHECK_RETRY_DELAY_MS);

        try {
          return await this.callWorker<DatabaseHealth>({ type: 'health' }, HEALTH_CHECK_RETRY_TIMEOUT_MS);
        }
        catch (retryError) {
          finalError = retryError;
        }
      }

      return {
        healthy: false,
        error: getErrorMessage(finalError),
        diagnostics: {
          timestamp: new Date().toISOString(),
          mode: 'worker',
          workerCallTimedOut: finalError instanceof WorkerTimeoutError,
          pendingWorkerCallCount: this.pendingWorkerCalls.size,
        },
      };
    }
  }

  public registerTriggerFunctions(_triggerFunctions: TriggerFunctions): void {
  }

  public async close(save = true): Promise<boolean> {
    if (this.closed) return true;

    try {
      if (save) await this.saveToDisk();
      this.closed = true;
      await this.callWorker({ type: 'close' }, 2000);

      return true;
    } catch (error) {
      logger.error('Close failed', error);

      return false;
    }
    finally {
      this.closed = true;
      this.worker.terminate();

      for (const pending of this.pendingWorkerCalls.values()) {
        pending.reject(new WorkerUnavailableError('Database worker closed'));
      }

      this.pendingWorkerCalls.clear();
    }
  }

  public acquireDatabaseLock(): Promise<() => void> {
    return this.dbLock.acquire();
  }

  /**
   * Run `fn` inside a real transaction on the worker database.
   *
   * The lock is required because the transaction spans multiple worker
   * messages: without it, another caller (e.g. indexNote) could slip a BEGIN
   * between ours and fail, or have its writes swept up in our rollback.
   */
  public async withTx<T>(fn: () => T | Promise<T>, opts: { deferFK?: boolean } = {}): Promise<T> {
    return runDatabaseTransaction({
      acquireLock: () => this.acquireDatabaseLock(),
      execute: sql => this.callWorker({ type: 'run', sql, params: [] }),
      onRollbackError: error => logger.error('Worker transaction rollback failed', error),
    }, fn, opts.deferFK);
  }
}
