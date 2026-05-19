import { loadWasmBinary, cacheWasmBinaryIfNeeded } from './WasmLoader';
import type { WorkerResponse } from './worker-types';
import type { IndexNoteData } from '../types/types.d.ts';
import type { EnabledFeatures, TableStructure } from './DatabaseSchema';
import type { ISchemaManager, VaultFileAdapter } from './DatabaseInterface';
import type { TriggerFunctions } from '../Triggers/TriggerFunctions';
import type { WasmSettings } from '../Settings/Settings';
import { logger as rootLogger } from '../utils/logger';
// @ts-expect-error - inline worker import
import DatabaseWorker from './database.worker';

const logger = rootLogger.scope('WorkerDatabase');

declare const activeWindow: Window;

interface DatabaseHealth {
  healthy: boolean;
  error?: string;
  diagnostics: Record<string, unknown>;
}

class WorkerSchemaProxy implements ISchemaManager {
  constructor(private request: <T = unknown>(message: Record<string, unknown>) => Promise<T>) {}

  getAllPropertyKeys(): Promise<string[]> {
    return this.request<string[]>({ type: 'getAllPropertyKeys' });
  }

  getViewNames(): Promise<string[]> {
    return this.request<string[]>({ type: 'getViewNames' });
  }

  getViewColumns(viewName: string): Promise<string[]> {
    return this.request<string[]>({ type: 'getViewColumns', viewName });
  }

  async rebuildPropertiesView(): Promise<void> {
    await this.request({ type: 'rebuildPropertiesView' });
  }

  async rebuildTableViews(enableDynamicTableViews: boolean): Promise<void> {
    await this.request({ type: 'rebuildTableViews', enableDynamicTableViews });
  }

  discoverTableStructures(): TableStructure[] {
    // Table structure discovery is performed by the worker during rebuildTableViews().
    // This sync method returns empty for interface compatibility.
    return [];
  }
}

export class WorkerDatabase {
  private worker: Worker;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private ready: Promise<void>;
  private readyResolve!: () => void;

  private fileAdapter: VaultFileAdapter | null;
  private databasePath: string;
  private configDir: string;
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

    this.schema = new WorkerSchemaProxy(this.request.bind(this));

    this.ready = new Promise(resolve => {
      this.readyResolve = resolve;
    });

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;

      if (response.type === 'ready') {
        this.readyResolve();
        return;
      }

      const pending = this.pendingRequests.get(response.id);
      if (!pending) {
        logger.warn('Received response for unknown request', response.id);
        return;
      }

      this.pendingRequests.delete(response.id);

      if (response.type === 'error') {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve(response.result);
      }
    };

    this.worker.onerror = (error) => {
      logger.error('Worker error', error);
    };
  }

  private async request<T = unknown>(message: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    await this.ready;

    const id = this.nextId++;
    const request = { ...message, id };

    return new Promise<T>((resolve, reject) => {
      let timeout: number | null = null;
      const clearRequestTimeout = (): void => {
        if (timeout !== null) {
          activeWindow.clearTimeout(timeout);
          timeout = null;
        }
      };

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          clearRequestTimeout();
          resolve(value as T);
        },
        reject: (error: Error) => {
          clearRequestTimeout();
          reject(error);
        }
      });

      if (timeoutMs !== undefined) {
        timeout = activeWindow.setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Worker request "${String(message.type)}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.worker.postMessage(request);
    });
  }

  public static async create(configDir: string, fileAdapter: VaultFileAdapter | null = null, useMemoryStorage: boolean = true, databasePath?: string, pluginDir?: string, wasmAdapter?: VaultFileAdapter, wasmSettings?: WasmSettings): Promise<WorkerDatabase> {
    const actualDatabasePath = databasePath || `${configDir}/vaultquery.db`;
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

    await instance.request({
      type: 'init',
      wasmBinary: wasmBinary
    });

    if (!useMemoryStorage && fileAdapter) {
      try {
        if (await fileAdapter.exists(actualDatabasePath)) {
          const data = await fileAdapter.readBinary(actualDatabasePath);
          await instance.request({ type: 'import', data });
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
    return this.request<ArrayBuffer>({ type: 'export' });
  }

  public async saveToDisk(): Promise<void> {
    if (this.useMemoryStorage || !this.fileAdapter) return;

    try {
      const data = await this.request<ArrayBuffer>({ type: 'export' });
      const databaseDir = this.configDir + '/vaultquery';

      if (!(await this.fileAdapter.exists(databaseDir))) {
        await this.fileAdapter.mkdir(databaseDir);
      }

      await this.fileAdapter.writeBinary(this.databasePath, data);
    } catch (error) {
      logger.error('Failed to save database', error);
    }
  }

  public async all(sql: string, params: (string | number | null)[] = []): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>({
      type: 'query',
      sql,
      params
    });
  }

  public async run(sql: string, params: (string | number | null)[] = []): Promise<number> {
    return this.request<number>({
      type: 'run',
      sql,
      params
    });
  }

  public async indexNote(data: IndexNoteData): Promise<void> {
    await this.request({
      type: 'indexNote',
      data
    });
  }

  public async indexNotesBatch(notesData: IndexNoteData[], isInitialIndexing: boolean = false, skipDiskSave: boolean = false): Promise<void> {
    await this.request({
      type: 'indexNotesBatch',
      notesData,
      isInitialIndexing
    });

    if (!skipDiskSave) {
      await this.saveToDisk();
    }
  }

  public async createIndexes(features?: EnabledFeatures): Promise<void> {
    await this.request({
      type: 'createIndexes',
      features
    });
  }

  public async registerCustomFunction(name: string, source: string): Promise<void> {
    await this.request({
      type: 'registerFunction',
      name,
      source
    });
  }

  public async deleteNote(path: string): Promise<void> {
    await this.request({
      type: 'deleteNote',
      path
    });
  }

  public async getAllUserViews(): Promise<Array<{view_name: string; path: string; sql: string}>> {
    return this.request({ type: 'getAllUserViews' });
  }

  public async getAllUserFunctions(): Promise<Array<{function_name: string; path: string; source: string}>> {
    return this.request({ type: 'getAllUserFunctions' });
  }

  public async getAllUserTriggers(): Promise<Array<{trigger_name: string; path: string; trigger_sql: string; enabled: number}>> {
    return this.request({ type: 'getAllUserTriggers' });
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
    await this.request({ type: 'registerTrigger', triggerName, triggerSql, sourcePath });
  }

  public async registerUserTriggers(): Promise<void> {
    await this.request({ type: 'registerUserTriggers' });
  }

  public async checkHealth(timeoutMs: number = 2000): Promise<DatabaseHealth> {
    try {
      return await this.request<DatabaseHealth>({ type: 'health' }, timeoutMs);
    }
    catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
        diagnostics: {
          timestamp: new Date().toISOString(),
          mode: 'worker',
          requestTimedOut: error instanceof Error && error.message.includes('timed out'),
          pendingRequestCount: this.pendingRequests.size,
        },
      };
    }
  }

  public registerTriggerFunctions(_triggerFunctions: TriggerFunctions): void {
  }

  public async close(): Promise<boolean> {
    try {
      await this.saveToDisk();
      await this.request({ type: 'close' });
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

  public acquireDbLock(): Promise<() => void> {
    return Promise.resolve(() => {});
  }

  public withTx<T>(fn: () => T | Promise<T>, _opts?: { deferFK?: boolean }): Promise<T> {
    return Promise.resolve(fn());
  }

}
