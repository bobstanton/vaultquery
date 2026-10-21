import { persistDatabase } from './DatabasePersistence';
import { runDatabaseTransaction } from './DatabaseTransactions';
import type { SqlParameter } from './QueryValues';
import initSqlJs from 'sql.js';
import { OtherFileDatabaseOperations } from '../OtherFiles/OtherFileDatabaseOperations';
import { ImageDatabaseOperations } from '../Images/ImageDatabaseOperations';
import { DataFileDatabaseOperations } from '../Tabular/TabularDatabaseOperations';
import { ProviderSnapshotOperations } from '../Providers/ProviderSnapshotOperations';
import { extractSqlFunctionCalls, extractSqlReferencedTables, sqlUpdatesColumn } from '../utils/SQLParsingUtils';
import type { Database, Statement } from 'sql.js';
import { App } from 'obsidian';
import { getDatabasePath } from '../Settings/Settings';
import type { WasmSettings } from '../Settings/Settings';
import { PreviewService } from '../Services/PreviewService';
import type { EnabledFeatures } from './DatabaseSchema';
import { createSchema as createSchemaCore, createIndexes as createIndexesCore, runPragmaStatements as runPragmaStatementsCore, MatRefreshSqlCache } from './SchemaOperations';
import type { IndexCreationState } from './SchemaOperations';
import { StatementCache } from './StatementCache';
import { DatabaseLock, exportWithRuntimeStateRestore, runBatchIndexing, mapUserViewRow, mapUserFunctionRow, mapUserTriggerRow } from './DatabaseCore';
import type { ExportRuntimeState, UserViewRow, UserFunctionRow, UserTriggerRow } from './DatabaseCore';
import { INDEXING_SQL, PREPARED_STATEMENT_CACHE_LIMIT, MAX_ROWS_PER_INSERT_BATCH } from './IndexingQueries';
import { insertNoteCore, replaceTasksCore, replaceHeadingsCore, replaceListItemsCore, replacePropertiesCore, replaceUserFunctionsCore, replaceUserTriggersCore, performIndexingOperationsCore } from './IndexingOperations';
import type { IndexingDbAdapter } from './IndexingOperations';
import { CustomSQLFunctions } from './CustomSQLFunctions';
import { DatabaseSchemaManager } from './DatabaseSchemaManager';
import type { VaultFileAdapter } from './DatabaseInterface';
import { loadWasmBinary, cacheWasmBinaryIfNeeded, CDN_URL } from './WasmLoader';
import { checkSqlJsDatabaseHealth } from './DatabaseHealth';
import { queryStatementRows, queryStatementValues, runMultiRowInsertBatches, runPreparedStatement } from './StatementRows';
import { batchDeleteRowsByIds } from './BatchDelete';
import { getErrorMessage, ERROR_MESSAGES } from '../utils/ErrorMessages';
import { hashString } from '../utils/StringUtils';
import { createUserSqlFunction } from '../utils/UserFunctionEvaluator';
import type { TriggerFunctions } from '../Triggers';
import type { IndexNoteData, NoteRecord } from '../types';
import type { PreviewResult } from '../Services/PreviewService';
import { logger as rootLogger } from '../utils/logger';
import { activateUserTrigger, USER_TRIGGER_PREFIX } from './TriggerActivation';
import { withReadOnlyQuery } from './ReadOnlyQuery';
import { QueryBatchCursors, iterateQueryCursor, throwIfQueryAborted, queryChangesDatabase } from './QueryIteration';
import type { QueryIterationOptions } from './QueryIteration';
import type { TabularValue } from '../Tabular/TabularTypes';

const logger = rootLogger.scope('Database');

const STATEMENT_RESET_ERROR = 'Error resetting statement';

/** Options for creating a VaultDatabase instance */
interface DatabaseOptions {
  fileAdapter?: VaultFileAdapter | null;
  useMemoryStorage?: boolean;
  databasePath?: string;
  pluginDir?: string;
  wasmAdapter?: VaultFileAdapter;
  wasmSettings?: WasmSettings;
}

export interface QueryMirrorSnapshot {
  data: ArrayBuffer;
  version: string;
}

export class VaultDatabase {
  private csvOperations?: DataFileDatabaseOperations;
  private app: App;
  private db: Database;
  private fileAdapter: VaultFileAdapter | null;
  private databasePath: string;
  private configDir: string;
  public readonly useMemoryStorage: boolean;

  private statementCache = new StatementCache(PREPARED_STATEMENT_CACHE_LIMIT, (message, error) => logger.warn(message, error));
  private multiRowInsertSqlCache = new Map<string, string>();
  private previewService: PreviewService;
  public readonly schema: DatabaseSchemaManager;
  private triggerFunctions: TriggerFunctions | null = null;

  private readonly dbLock = new DatabaseLock();
  private readonly transferLock = new DatabaseLock();
  private indexState: IndexCreationState = { indexesCreated: false, enabledFeatures: null };

  private registeredFunctionHashes = new Map<string, string>();
  private registeredFunctionSources = new Map<string, string>();
  private matRefreshSqlCache = new MatRefreshSqlCache();
  private exportGeneration = 0;
  private readonly queryCursors = new QueryBatchCursors(() => this.db);

  private constructor(app: App, db: Database, fileAdapter: VaultFileAdapter | null, useMemoryStorage: boolean, databasePath: string, configDir: string) {
    this.app = app;
    this.db = db;
    this.fileAdapter = fileAdapter;
    this.useMemoryStorage = useMemoryStorage;
    this.databasePath = databasePath;
    this.configDir = configDir;
    this.previewService = new PreviewService(db);
    this.schema = new DatabaseSchemaManager(db, () => this.queryCursors.invalidate());
    this.schema.onPropertiesViewRebuilt = () => this.invalidatePropertiesMatRefreshSql();
  }

  public static async createFromBinary(app: App, configDir: string, data: ArrayBuffer, options: DatabaseOptions = {}): Promise<VaultDatabase> {
    const { fileAdapter = null, useMemoryStorage = true, databasePath, pluginDir, wasmAdapter, wasmSettings } = options;
    const actualDatabasePath = databasePath || getDatabasePath(configDir);
    const adapter = wasmAdapter || fileAdapter;

    const { wasmBinary } = await loadWasmBinary(adapter, pluginDir, wasmSettings);

    const sqlJs = await initSqlJs({
      wasmBinary,
      locateFile: wasmBinary ? undefined : (() => CDN_URL)
    });

    const db = new sqlJs.Database(new Uint8Array(data));

    const instance = new VaultDatabase(app, db, fileAdapter, useMemoryStorage, actualDatabasePath, configDir);

    instance.runPragmaStatements();
    CustomSQLFunctions.register(db, app);
    instance.createSchema();

    return instance;
  }

  public static async create(app: App, configDir: string, options: DatabaseOptions = {}): Promise<VaultDatabase> {
    const { fileAdapter = null, useMemoryStorage = true, databasePath, pluginDir, wasmAdapter, wasmSettings } = options;
    const actualDatabasePath = databasePath || getDatabasePath(configDir);
    const adapter = wasmAdapter || fileAdapter;

    const wasmLoadResult = await loadWasmBinary(adapter, pluginDir, wasmSettings);
    await cacheWasmBinaryIfNeeded(wasmLoadResult, adapter, pluginDir, wasmSettings);
    const { wasmBinary } = wasmLoadResult;

    const sqlJs = await initSqlJs({
      wasmBinary,
      locateFile: wasmBinary ? undefined : (() => CDN_URL)
    });

    let db: Database;

    const shouldLoadFromDisk = !useMemoryStorage
      && fileAdapter
      && await fileAdapter.exists(actualDatabasePath);

    if (!shouldLoadFromDisk) {
      db = new sqlJs.Database();
    } else {
      try {
        const data = await fileAdapter.readBinary(actualDatabasePath);
        db = new sqlJs.Database(new Uint8Array(data));
      }
      catch (error) {
        throw new Error(ERROR_MESSAGES.DATABASE_READ_FAILED(actualDatabasePath, getErrorMessage(error)));
      }
    }

    const instance = new VaultDatabase(app, db, fileAdapter, useMemoryStorage, actualDatabasePath, configDir);

    instance.runPragmaStatements();
    CustomSQLFunctions.register(db, app);
    instance.createSchema();

    instance.db.run('PRAGMA optimize');

    return instance;
  }

  private diskSaveQueue: Promise<void> = Promise.resolve();

  public async saveToDisk(options: { throwOnError?: boolean; lockExport?: boolean } = {}): Promise<void> {
    const save = this.diskSaveQueue.catch(() => {}).then(() => this.withTransferLock(() => this.saveToDiskNow(options)));
    this.diskSaveQueue = save.catch(() => {});
    await save;
  }

  public async withTransferLock<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.transferLock.acquire();

    try {
      return await work();
    }
    finally {
      release();
    }
  }

  private async saveToDiskNow(options: { throwOnError?: boolean; lockExport?: boolean }): Promise<void> {
    try {
      await persistDatabase({
        useMemoryStorage: this.useMemoryStorage,
        fileAdapter: this.fileAdapter,
        configDir: this.configDir,
        databasePath: this.databasePath,
        exportData: options.lockExport ? async () => {
          const release = await this.acquireDatabaseLock();

          try {
            return this.exportWithRuntimeState();
          }
          finally {
            release();
          }
        } : () => this.exportWithRuntimeState(),
        debug: (message, details) => logger.debug(message, details),
      });
    }
    catch (error) {
      logger.error('Could not save database to disk', error);
      if (options.throwOnError) throw error;
    }
  }

  private runPragmaStatements(): void {
    runPragmaStatementsCore(this.db, error => logger.warn('Some database optimizations are not available', error));
  }

  private exportRuntimeState(): ExportRuntimeState {
    return {
      statementCache: this.statementCache,
      matRefreshSqlCache: this.matRefreshSqlCache,
      registeredFunctionSources: this.registeredFunctionSources,
      runPragmaStatements: () => this.runPragmaStatements(),
      registerBuiltinFunctions: () => {
        CustomSQLFunctions.register(this.db, this.app);
        this.triggerFunctions?.register(this.db);
      },
      registerCustomFunction: (name, source) => {
        this.registeredFunctionHashes.delete(name);
        this.registerCustomFunction(name, source);
      },
    };
  }

  public acquireDatabaseLock(): Promise<() => void> {
    return this.dbLock.acquire();
  }

  private exportWithRuntimeState(): Uint8Array {
    this.queryCursors.invalidate();
    this.exportGeneration++;

    return exportWithRuntimeStateRestore(this.db, this.exportRuntimeState());
  }

  private snapshotVersion(): string {
    const changes = Number(this.db.exec('SELECT total_changes()')[0].values[0][0]);
    const schema = Number(this.db.exec('PRAGMA schema_version')[0].values[0][0]);

    return `${this.exportGeneration}:${changes}:${schema}`;
  }

  public async createQueryMirrorSnapshot(): Promise<QueryMirrorSnapshot> {
    const release = await this.acquireDatabaseLock();

    try {
      const bytes = this.exportWithRuntimeState();

      const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer as ArrayBuffer : bytes.slice().buffer;

      return { data, version: this.snapshotVersion() };
    } finally {
      release();
    }
  }

  public async publishQueryMirrorSnapshot(snapshot: QueryMirrorSnapshot, publish: () => boolean): Promise<boolean> {
    const release = await this.acquireDatabaseLock();

    try {
      return this.snapshotVersion() === snapshot.version && publish();
    }
    finally {
      release();
    }
  }

  public async withOtherFileIndex<T>(work: (operations: OtherFileDatabaseOperations) => T): Promise<T> {
    return this.withLockedOperations(() => work(new OtherFileDatabaseOperations(this.db, () => this.cleanupPreparedStatements())));
  }

  public async withImageIndex<T>(work: (operations: ImageDatabaseOperations) => T): Promise<T> {
    return this.withLockedOperations(() => work(new ImageDatabaseOperations(this.db, () => this.cleanupPreparedStatements())));
  }

  public async hasProviderSnapshots(): Promise<boolean> {
    return (await this.all('SELECT 1 FROM sqlite_schema WHERE name = ? COLLATE NOCASE', ['_vq_provider_snapshots'])).length > 0;
  }

  public async withProviderSnapshots<T>(work: (operations: ProviderSnapshotOperations) => T): Promise<T> {
    return this.withLockedOperations(() => work(new ProviderSnapshotOperations(this.db, () => this.cleanupPreparedStatements())));
  }

  public async withCsvOperations<T>(work: (operations: DataFileDatabaseOperations) => T): Promise<T> {
    return this.withLockedOperations(() => {
      this.csvOperations ??= new DataFileDatabaseOperations(this.db, () => this.cleanupPreparedStatements());

      return work(this.csvOperations);
    });
  }

  private async withLockedOperations<T>(work: () => T): Promise<T> {
    const release = await this.acquireDatabaseLock();

    try {
      return work();
    }
    finally {
      release();
    }
  }

  public async stageCsvWrites(path: string, sql: string, params: unknown[] = []): Promise<{ preview: PreviewResult; rows: TabularValue[][] }> {
    return this.withCsvOperations(operations => {
      if (sql.includes('\0') || params.some(value => typeof value === 'string' && value.includes('\0'))) {
        throw new Error('NUL characters are not supported in CSV write SQL or parameter values.');
      }

      this.assertPreparedWriteFunctions(sql);
      const stage = () => operations.stageWrites(path, sql, statement => this.previewService.previewDmlFromSql(statement, params));

      return this.triggerFunctions ? this.triggerFunctions.withReadOnlyExecution(stage) : stage();
    });
  }

  private assertPreparedWriteFunctions(sql: string): void {
    const userFunctions = new Set(Array.from(this.registeredFunctionSources.keys(), name => name.toLowerCase()));
    const pending = [sql];
    const visited = new Set<string>();
    const views = this.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ? COLLATE NOCASE UNION ALL SELECT sql FROM sqlite_temp_schema WHERE type = 'view' AND name = ? COLLATE NOCASE");

    try {
      while (pending.length) {
        const statement = pending.pop()!;

        if (Array.from(extractSqlFunctionCalls(statement)).some(name => userFunctions.has(name) || /^_vq_/i.test(name))) {
          throw new Error('User-defined JavaScript functions and internal functions are not supported in file write previews.');
        }

        for (const relation of extractSqlReferencedTables(statement)) {
          const key = relation.toLowerCase();
          if (visited.has(key)) continue;
          visited.add(key);

          try {
            views.bind([relation, relation]);

            while (views.step()) {
              const definition = views.get()[0];
              if (typeof definition === 'string') pending.push(definition);
            }
          }
          finally {
            views.reset();
          }
        }
      }
    } finally {
      views.free();
    }
  }

  public async stageOtherFileWrites(sql: string, params: unknown[], limits: import('../OtherFiles/OtherFileWriteStaging').OtherFileStageLimits) {
    return this.withOtherFileIndex(operations => {
      this.assertPreparedWriteFunctions(sql);
      const stage = () => operations.stageWrites(sql, params, limits);

      return this.triggerFunctions ? this.triggerFunctions.withReadOnlyExecution(stage) : stage();
    });
  }

  /**
   * Run `fn` inside a transaction, serialized behind the database lock.
   *
   * Nested calls are NOT supported: `fn` must not call `withTx` again (it would
   * deadlock on the lock).
   */
  public async withTx<T>(fn: () => T | Promise<T>, opts: { deferFK?: boolean } = {}): Promise<T> {
    return runDatabaseTransaction({
      acquireLock: () => this.acquireDatabaseLock(),
      beforeBegin: () => this.queryCursors.invalidate(),
      execute: sql => {
        if (sql.startsWith('PRAGMA')) this.db.exec(sql);
        else this.db.run(sql);
      },
      onRollbackError: error => logger.error('Transaction rollback failed - database may be in inconsistent state', error),
    }, fn, opts.deferFK);
  }

  private getPreparedStatement(sql: string): Statement {
    try {
      return this.statementCache.get(this.db, sql);
    }
    catch (error: unknown) {
      throw new Error(getErrorMessage(error) || ERROR_MESSAGES.SQL_PREPARE_FAILED);
    }
  }

  private cleanupPreparedStatements(): void {
    this.queryCursors.invalidate();
    this.statementCache.freeAll();
  }

  private createSchema(): void {
    createSchemaCore(this.db);
    this.indexState.indexesCreated = false;
  }

  public createIndexes(features?: EnabledFeatures): void {
    this.queryCursors.invalidate();
    createIndexesCore(this.db, features, this.indexState, (message, error) => logger.error(message, error));
  }

  public async indexNote(data: IndexNoteData): Promise<void> {
    logger.debug(`indexNote called for: ${data.note.path}`);
    this.createIndexes();

    try {
      return await this.withTx(() => this.performIndexingOperations(data, false));
    } finally {
      // Scope vq_defer to this note's indexing pass so a defer key set by one
      // note's trigger doesn't capture (and potentially discard) actions queued
      // by later, unrelated triggers.
      this.triggerFunctions?.clearCurrentDeferKey();
    }
  }

  private performIndexingOperations(data: IndexNoteData, skipDeletes: boolean, skipAutoSync: boolean = false): void {
    const adapter = this.createIndexingAdapter();

    performIndexingOperationsCore(adapter, data, skipDeletes, {
      insertNote: (note) => this.insertNote(note),
      replaceProperties: (path, frontmatterData, shouldSkipDeletes) => this.replaceProperties(path, frontmatterData, shouldSkipDeletes, skipAutoSync),
      propertiesMatRefreshSql: () => this.getPropertiesMatRefreshSql(),
      replaceTasks: (path, tasks, shouldSkipDeletes) => this.replaceTasks(path, tasks, shouldSkipDeletes, skipAutoSync),
      replaceHeadings: (path, headings, shouldSkipDeletes) => this.replaceHeadings(path, headings, shouldSkipDeletes, skipAutoSync),
      replaceListItems: (path, listItems, shouldSkipDeletes) => this.replaceListItems(path, listItems, shouldSkipDeletes, skipAutoSync),
      replaceUserFunctions: (path, userFunctions, shouldSkipDeletes) => this.replaceUserFunctions(path, userFunctions, shouldSkipDeletes),
      replaceUserTriggers: (path, userTriggers, shouldSkipDeletes) => this.replaceUserTriggers(path, userTriggers, shouldSkipDeletes),
    }, logger);
  }

  private insertNote(note: NoteRecord): void {
    insertNoteCore(this.createIndexingAdapter(), note);
  }

  private replaceProperties(path: string, propertiesData?: Array<{key: string; value: string; valueType: string; arrayIndex: number | null}>, skipDeletes: boolean = false, skipAutoSync: boolean = false): void {
    const originalPropsInDB = new Set<string>();

    if (!skipAutoSync) {
      const existingResult = this.db.exec(INDEXING_SQL.SELECT_PROPERTIES_FOR_SYNC, [path]);

      if (existingResult.length > 0) {
        for (const row of existingResult[0].values) {
          const key = row[0] as string;
          const arrayIndex = row[1] as number | null;

          if (arrayIndex === null) {
            originalPropsInDB.add(key);
          }
        }
      }
    }

    // Core property replacement (skipDeletes=true, we handle deletes with trigger protection)
    replacePropertiesCore(this.createIndexingAdapter(), path, propertiesData, true);

    if (!propertiesData?.length) {
      if (!skipDeletes) {
        this.runWithPreparedStatement(INDEXING_SQL.DELETE_PROPERTIES, [path]);
      }

      return;
    }

    // Auto-sync: Check if a trigger ADDED new properties BEFORE deleting stale ones
    const propertyKeysFromFile = new Set(propertiesData.map(p => p.key));

    if (this.shouldPerformAutoSync(skipAutoSync, propertiesData.length)) {
      const syncResult = this.db.exec(INDEXING_SQL.SELECT_PROPERTIES_VALUES_FOR_SYNC, [path]);

      if (syncResult.length > 0) {
        for (const row of syncResult[0].values) {
          const key = row[0] as string;
          const dbValue = row[1] as string;

          // Only sync if: not in file AND not in original DB (trigger added it this pass)
          if (!propertyKeysFromFile.has(key) && !originalPropsInDB.has(key)) {
            this.triggerFunctions!.queueSetProperty(path, key, dbValue);
          }
        }
      }
    }

    if (!skipDeletes) {
      const pendingKeys = this.triggerFunctions?.getPendingPropertyKeys(path) ?? new Set<string>();

      const allKeysToKeep: Array<{key: string; arrayIndex: number | null}> = [
        ...propertiesData.map(p => ({ key: p.key, arrayIndex: p.arrayIndex })),
        ...Array.from(pendingKeys).map(key => ({ key, arrayIndex: null }))
      ];

      const placeholders = allKeysToKeep.map(() => '(?, ?)').join(', ');
      const params: (string | number)[] = [path];

      for (const p of allKeysToKeep) {
        params.push(p.key, p.arrayIndex ?? -1);
      }

      const deleteStaleSQL = `${INDEXING_SQL.DELETE_STALE_PROPERTIES}(VALUES ${placeholders})`;
      this.db.run(deleteStaleSQL, params);
    }
  }

  public run(sql: string, params: SqlParameter[] = []): Promise<number> {
    this.queryCursors.invalidate();
    this.db.run(sql, params);

    return Promise.resolve(this.db.getRowsModified());
  }

  /**
   * Batch delete rows by ID. More efficient than individual DELETE statements.
   * Uses chunked IN clauses to avoid SQLite limits.
   */
  private batchDeleteByIds(tableName: string, ids: number[]): void {
    batchDeleteRowsByIds(tableName, ids, (sql, params) => this.db.run(sql, params));
  }

  /**
   * Create an adapter for shared indexing operations.
   * This abstracts the database access methods for use with IndexingOperations.ts.
   */
  private createIndexingAdapter(): IndexingDbAdapter {
    return {
      exec: (sql, params) => queryStatementValues(this.getPreparedStatement(sql), params as SqlParameter[] | undefined),
      run: (sql, params) => this.db.run(sql, params as (string | number | null | Uint8Array)[]),
      runPrepared: (sql, params) => this.runWithPreparedStatement(sql, params),
      batchDeleteByIds: (table, ids) => this.batchDeleteByIds(table, ids),
      runMultiRowInsert: (base, cols, rows) => this.runMultiRowInsert(base, cols, rows),
    };
  }

  public registerCustomFunction(name: string, source: string): void {
    const newHash = hashString(source);
    const existingHash = this.registeredFunctionHashes.get(name);

    if (existingHash === newHash) {
      return;
    }

    this.queryCursors.invalidate();
    this.db.create_function(name, createUserSqlFunction(source));
    this.registeredFunctionHashes.set(name, newHash);
    this.registeredFunctionSources.set(name, source);
  }

  public viewNeedsRecreation(viewName: string, newSql: string): boolean {
    return this.storedHashNeedsUpdate(INDEXING_SQL.SELECT_VIEW_HASH, viewName, newSql);
  }

  public functionNeedsRecreation(functionName: string, newSource: string): boolean {
    const newHash = hashString(newSource);
    const cachedHash = this.registeredFunctionHashes.get(functionName);

    if (cachedHash === newHash) {
      return false;
    }

    return this.storedHashNeedsUpdate(INDEXING_SQL.SELECT_FUNCTION_HASH, functionName, newSource, newHash);
  }

  public triggerNeedsRecreation(triggerName: string, newSql: string): boolean {
    return this.storedHashNeedsUpdate(INDEXING_SQL.SELECT_TRIGGER_HASH, triggerName, newSql);
  }

  private storedHashNeedsUpdate(selectHashSql: string, name: string, source: string, sourceHash = hashString(source)): boolean {
    const result = this.db.exec(selectHashSql, [name]);
    const existingHash = result[0]?.values[0]?.[0];

    return existingHash !== sourceHash;
  }

  public all(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
    try {
      return Promise.resolve(this.readRows(sql, params));
    }
    catch (error: unknown) {
      return Promise.reject(new Error(ERROR_MESSAGES.SQL_QUERY_FAILED(getErrorMessage(error))));
    }
  }

  private readRows(sql: string, params: SqlParameter[]): Record<string, unknown>[] {
    if (queryChangesDatabase(sql)) this.queryCursors.invalidate();

    return queryStatementRows(this.getPreparedStatement(sql), params, resetError => {
      logger.warn(STATEMENT_RESET_ERROR, resetError);
    });
  }

  public async allReadOnly(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
    const releaseLock = await this.acquireDatabaseLock();

    try {
      const read = () => withReadOnlyQuery(this.db, sql, () => this.readRows(sql, params));

      return this.triggerFunctions ? this.triggerFunctions.withReadOnlyExecution(read) : read();
    }
    finally {
      releaseLock();
    }
  }

  public iterateQueryBatches(sql: string, params: SqlParameter[] = [], options: QueryIterationOptions = {}): AsyncGenerator<Record<string, unknown>[]> {
    let workStarted = performance.now();

    const locked = async <T>(read: () => T): Promise<T> => {
      if (performance.now() - workStarted >= 8) {
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        workStarted = performance.now();
      }

      throwIfQueryAborted(options.signal);
      const release = await this.acquireDatabaseLock();

      try {
        throwIfQueryAborted(options.signal);

        return this.triggerFunctions ? this.triggerFunctions.withReadOnlyExecution(read) : read();
      } finally {
        release();
      }
    };

    return iterateQueryCursor({
      open: () => locked(() => this.queryCursors.open(sql, params)),
      next: id => locked(() => this.queryCursors.next(id)),
      close: id => {
        this.queryCursors.close(id);

        return Promise.resolve();
      },
    }, options.signal);
  }

  public runWithPreparedStatement(sql: string, params: SqlParameter[] = []): void {
    this.queryCursors.invalidate();

    try {
      const stmt = this.getPreparedStatement(sql);

      runPreparedStatement(stmt, params, resetError => {
        logger.warn(STATEMENT_RESET_ERROR, resetError);
      });
    }
    catch (error: unknown) {
      throw new Error(ERROR_MESSAGES.SQL_RUN_FAILED(getErrorMessage(error)));
    }
  }

  private runMultiRowInsert(baseSQL: string, columnsCount: number, rows: SqlParameter[][], maxRowsPerBatch: number = MAX_ROWS_PER_INSERT_BATCH): void {
    runMultiRowInsertBatches(this.multiRowInsertSqlCache, baseSQL, columnsCount, rows, maxRowsPerBatch, (sql, params) => {
      this.db.run(sql, params);
    });
  }

  public async indexNotesBatch(notesData: IndexNoteData[], isInitialIndexing: boolean = false, skipDiskSave: boolean = false, syncTriggerChanges: boolean = false): Promise<void> {
    if (notesData.length === 0) return;

    await runBatchIndexing(
      this.db,
      isInitialIndexing,
      () => this.withTx(() => this.performBatchIndexing(notesData, isInitialIndexing, syncTriggerChanges))
    );

    if (!skipDiskSave) {
      await this.saveToDisk();
    }
  }

  private performBatchIndexing(notesData: IndexNoteData[], skipDeletes: boolean = false, syncTriggerChanges: boolean = false): void {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const data of notesData) {
      if (seen.has(data.note.path)) {
        duplicates.push(data.note.path);
      } else {
        seen.add(data.note.path);
      }
    }

    if (duplicates.length > 0) {
      logger.warn(`Found ${duplicates.length} duplicate notes in batch: ${duplicates.join(', ')}`);
    }

    const pendingActionsBefore = this.triggerFunctions?.getPendingActionsCount() ?? 0;

    try {
      for (const data of notesData) {
        try {
          this.performIndexingOperations(data, skipDeletes, !syncTriggerChanges);
        } finally {
          this.triggerFunctions?.clearCurrentDeferKey();
        }
      }
    }
    catch (error) {
      this.triggerFunctions?.limitPendingActions(pendingActionsBefore);
      throw error;
    }
  }

  public async previewDML(sql: string, params: unknown[] = []): Promise<PreviewResult> {
    const releaseLock = await this.acquireDatabaseLock();

    try {
      this.queryCursors.invalidate();
      // Set preview mode to prevent sync handlers from queuing actions.
      // WriteSyncService handles file sync during the preview/apply cycle.
      this.triggerFunctions?.setPreviewMode(true);
      const result = this.previewService.previewDmlFromSql(sql, params);

      return result;
    } finally {
      this.triggerFunctions?.setPreviewMode(false);
      releaseLock();
    }
  }

  public async applyDML(previewResult: PreviewResult): Promise<void> {
    // Set preview mode to prevent sync handlers from queuing actions
    // (WriteSyncService handles file sync during apply)
    this.triggerFunctions?.setPreviewMode(true);

    // For INSERT INTO table_rows, set direct apply target to allow cascade
    // The DIRECT insert is handled by WriteSyncService, but CASCADE inserts
    // (from triggers like wuphf_broadcast) need to queue
    const directTargets = this.extractTableRowsTargets(previewResult);

    if (directTargets.length > 0) {
      this.triggerFunctions?.setDirectApplyTargets(directTargets);
    }

    try {
      await this.withTx(() => {
        this.applyDMLWithoutTransaction(previewResult);
      });
    } finally {
      this.triggerFunctions?.setPreviewMode(false);
      this.triggerFunctions?.setDirectApplyTargets(null);
    }
  }

  /**
   * Extract the target table for INSERT INTO table_rows operations.
   * Used to distinguish direct inserts (handled by WriteSyncService) from
   * cascade inserts (which should queue for trigger processing).
   */
  private extractTableRowsTargets(previewResult: PreviewResult): Array<{ path: string; tableIndex: number }> {
    const targets = new Map<string, { path: string; tableIndex: number }>();

    const addTarget = (path: unknown, tableIndex: unknown) => {
      if (typeof path !== 'string' || path.length === 0 || typeof tableIndex !== 'number' || !Number.isFinite(tableIndex)) {
        return;
      }

      targets.set(`${path}\u0000${tableIndex}`, { path, tableIndex });
    };

    const collectFromResult = (result: PreviewResult) => {
      if (result.op === 'multi' && result.multiResults) {
        result.multiResults.forEach(collectFromResult);

        return;
      }

      if (result.table === 'table_rows' && result.op === 'insert') {
        for (const row of result.after) {
          addTarget(row.path, row.table_index ?? 0);
        }
      }
    };

    collectFromResult(previewResult);

    return Array.from(targets.values());
  }

  private applyDMLWithoutTransaction(previewResult: PreviewResult): void {
    for (const { sql, params } of previewResult.sqlToApply) {
      const stmt = this.db.prepare(sql);

      try {
        stmt.run((params ?? []) as SqlParameter[]);
      } finally {
        stmt.free();
      }
    }
  }

  public checkHealth(): { healthy: boolean; error?: string; diagnostics: Record<string, unknown> } {
    return checkSqlJsDatabaseHealth(this.db, {
      timestamp: new Date().toISOString(),
      useMemoryStorage: this.useMemoryStorage,
      preparedStatementCount: this.statementCache.size,
      queryCursorCount: this.queryCursors.size,
    });
  }

  public async close(): Promise<boolean> {
    try {
      await this.saveToDisk();

      this.cleanupPreparedStatements();

      this.db.close();

      return true;
    }
    catch (error) {
      logger.error('Error closing database', error);

      return false;
    }
  }

  private replaceTasks(path: string, tasks: IndexNoteData['tasks'], skipDeletes: boolean = false, skipAutoSync: boolean = false): void {
    this.replaceWithAutoSync({
      path,
      rows: tasks,
      skipDeletes,
      skipAutoSync,
      replace: () => replaceTasksCore(this.createIndexingAdapter(), path, tasks, skipDeletes),
      selectSql: INDEXING_SQL.SELECT_TASKS_FOR_SYNC,
      mapFileRow: (task) => ({
        lineNumber: task.line_number,
        value: {
          status: task.status,
          task_text: task.task_text
        }
      }),
      syncChangedRow: (lineNumber, fileTask, dbRow) => {
        const dbStatus = dbRow[1] as string;
        const dbTaskText = dbRow[2] as string;

        if (fileTask.status !== dbStatus || fileTask.task_text !== dbTaskText) {
          this.triggerFunctions!.queueUpdateTask(path, lineNumber, dbStatus, dbTaskText);
        }
      }
    });
  }

  private replaceHeadings(path: string, headings: IndexNoteData['headings'], skipDeletes: boolean = false, skipAutoSync: boolean = false): void {
    this.replaceWithAutoSync({
      path,
      rows: headings,
      skipDeletes,
      skipAutoSync,
      replace: () => replaceHeadingsCore(this.createIndexingAdapter(), path, headings, skipDeletes),
      selectSql: INDEXING_SQL.SELECT_HEADINGS_FOR_SYNC,
      mapFileRow: (heading) => ({
        lineNumber: heading.line_number,
        value: {
          level: heading.level,
          heading_text: heading.heading_text
        }
      }),
      syncChangedRow: (lineNumber, fileHeading, dbRow) => {
        const dbLevel = dbRow[1] as number;
        const dbHeadingText = dbRow[2] as string;

        if (fileHeading.level !== dbLevel || fileHeading.heading_text !== dbHeadingText) {
          this.triggerFunctions!.queueUpdateHeading(path, lineNumber, dbLevel, dbHeadingText);
        }
      }
    });
  }

  private replaceListItems(path: string, listItems: IndexNoteData['listItems'], skipDeletes: boolean = false, skipAutoSync: boolean = false): void {
    this.replaceWithAutoSync({
      path,
      rows: listItems,
      skipDeletes,
      skipAutoSync,
      replace: () => replaceListItemsCore(this.createIndexingAdapter(), path, listItems, skipDeletes),
      selectSql: INDEXING_SQL.SELECT_LIST_ITEMS_FOR_SYNC,
      mapFileRow: (item) => ({
        lineNumber: item.line_number,
        value: {
          content: item.content
        }
      }),
      syncChangedRow: (lineNumber, fileItem, dbRow) => {
        const dbContent = dbRow[1] as string;

        if (fileItem.content !== dbContent) {
          this.triggerFunctions!.queueUpdateListItem(path, lineNumber, dbContent);
        }
      }
    });
  }

  private replaceWithAutoSync<TRow, TFileValue>(options: {
    path: string;
    rows: TRow[] | undefined;
    skipDeletes: boolean;
    skipAutoSync: boolean;
    replace: () => void;
    selectSql: string;
    mapFileRow: (row: TRow) => { lineNumber: number; value: TFileValue };
    syncChangedRow: (lineNumber: number, fileValue: TFileValue, dbRow: unknown[]) => void;
  }): void {
    const fileRows = new Map<number, TFileValue>();
    const shouldSync = options.rows ? this.shouldPerformAutoSync(options.skipAutoSync, options.rows.length) : false;

    if (options.rows && shouldSync) {
      for (const row of options.rows) {
        const mapped = options.mapFileRow(row);
        fileRows.set(mapped.lineNumber, mapped.value);
      }
    }

    options.replace();

    if (!shouldSync || fileRows.size === 0) {
      return;
    }

    try {
      const syncResult = this.db.exec(options.selectSql, [options.path]);

      for (const row of syncResult[0]?.values ?? []) {
        const lineNumber = row[0] as number;
        const fileValue = fileRows.get(lineNumber);

        if (fileValue) {
          options.syncChangedRow(lineNumber, fileValue, row);
        }
      }
    } catch (error) {
      logger.warn('Error during auto-sync comparison', error);
    }
  }

  private replaceUserFunctions(path: string, userFunctions?: IndexNoteData['userFunctions'], skipDeletes: boolean = false): void {
    replaceUserFunctionsCore(this.createIndexingAdapter(), path, userFunctions, skipDeletes, (name, source) => this.registerCustomFunction(name, source), logger);
  }

  /**
   * Store and activate user triggers during indexing.
   * Triggers are both stored in _user_triggers table AND activated in SQLite.
   *
   * IMPORTANT: If userTriggers is undefined (not extracted during this indexing pass),
   * we preserve existing triggers. Only when userTriggers is explicitly provided
   * (even if empty) do we delete/replace.
   */
  private replaceUserTriggers(path: string, userTriggers?: IndexNoteData['userTriggers'], skipDeletes: boolean = false): void {
    replaceUserTriggersCore(this.createIndexingAdapter(), path, userTriggers, skipDeletes, (name, sql, triggerPath) => this.activateTrigger(name, sql, triggerPath), logger);
  }

  private queryCatalogRows<T>(label: string, sql: string, mapRow: (row: unknown[]) => T): T[] {
    try {
      return (this.db.exec(sql)[0]?.values ?? []).map(mapRow);
    }
    catch (error) {
      logger.warn(`DatabaseService.${label}: Query failed`, error);

      return [];
    }
  }

  public getAllUserTriggers(): UserTriggerRow[] {
    return this.queryCatalogRows('getAllUserTriggers', INDEXING_SQL.SELECT_ALL_USER_TRIGGERS, mapUserTriggerRow);
  }

  public registerUserTriggers(): void {
    const triggers = this.getAllUserTriggers();

    for (const trigger of triggers) {
      try {
        this.activateTrigger(trigger.trigger_name, trigger.trigger_sql, trigger.path);
      }
      catch (error) {
        logger.error(`Failed to register trigger "${trigger.trigger_name}"`, error);
      }
    }
  }

  public invalidatePropertiesMatRefreshSql(): void {
    this.matRefreshSqlCache.invalidate();
  }

  private getPropertiesMatRefreshSql(): { deleteSql: string; insertSql: string } | null {
    return this.matRefreshSqlCache.get(this.db, () => this.schema.getAllPropertyKeys());
  }

  public registerUserFunctions(): void {
    const functions = this.getAllUserFunctions();

    for (const func of functions) {
      try {
        this.registerCustomFunction(func.function_name, func.source);
      }
      catch (error) {
        logger.error(`Failed to register function "${func.function_name}"`, error);
      }
    }
  }

  public registerTrigger(triggerName: string, triggerSql: string, sourcePath?: string): void {
    if (sqlUpdatesColumn(triggerSql, 'notes', 'content')) {
      throw new Error('UPDATE notes SET content is not auto-synced. Use vq_replace_content() or vq_set_content() instead.');
    }

    if (!this.triggerNeedsRecreation(triggerName, triggerSql)) {
      return;
    }

    const newHash = hashString(triggerSql);

    if (sourcePath) {
      this.runWithPreparedStatement(INDEXING_SQL.INSERT_USER_TRIGGER, [triggerName, sourcePath, triggerSql, newHash]);
    }

    this.activateTrigger(triggerName, triggerSql, sourcePath);
  }

  private activateTrigger(triggerName: string, triggerSql: string, sourcePath?: string): void {
    this.queryCursors.invalidate();
    logger.debug(`Activating trigger ${USER_TRIGGER_PREFIX}${triggerName}`);
    activateUserTrigger(this.db, triggerName, triggerSql, sourcePath);
  }

  public getAllUserViews(): UserViewRow[] {
    return this.queryCatalogRows('getAllUserViews', INDEXING_SQL.SELECT_ALL_USER_VIEWS, mapUserViewRow);
  }

  public getAllUserFunctions(): UserFunctionRow[] {
    return this.queryCatalogRows('getAllUserFunctions', INDEXING_SQL.SELECT_ALL_USER_FUNCTIONS, mapUserFunctionRow);
  }

  /**
   * Register trigger functions (vq_set_property, vq_remove_property, etc.) with the database.
   * These functions are called from user-defined SQLite triggers.
   */
  public registerTriggerFunctions(triggerFunctions: TriggerFunctions): void {
    this.queryCursors.invalidate();
    this.triggerFunctions = triggerFunctions;
    triggerFunctions.register(this.db);
  }

  private shouldPerformAutoSync(skipAutoSync: boolean, dataLength: number | undefined): boolean {
    return !skipAutoSync &&
           !!dataLength &&
           !!this.triggerFunctions &&
           !this.triggerFunctions.getIsProcessingTriggers();
  }
}
