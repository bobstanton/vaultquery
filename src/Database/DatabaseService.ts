import initSqlJs, { Database, Statement } from 'sql.js';
import { App } from 'obsidian';
import { getDatabaseDir, getDatabasePath } from '../Settings/Settings';
import type { WasmSettings } from '../Settings/Settings';
import { PreviewService } from '../Services/PreviewService';
import { getTablesOnlySQL, getIndexesForFeatures, EnabledFeatures } from './DatabaseSchema';
import { PRAGMA_STATEMENTS } from './SchemaQueries';
import {
  INDEXING_SQL,
  PREPARED_STATEMENT_CACHE_LIMIT,
  MAX_ROWS_PER_INSERT_BATCH,
  noteToParams,
  noteToUpdateParams,
} from './IndexingQueries';
import {
  replaceTasksCore,
  replaceHeadingsCore,
  replaceListItemsCore,
  replacePropertiesCore,
  replaceUserFunctionsCore,
  replaceUserTriggersCore,
  performIndexingOperationsCore,
  type IndexingDbAdapter,
} from './IndexingOperations';
import { CustomSQLFunctions } from './CustomSQLFunctions';
import { DatabaseSchemaManager } from './DatabaseSchemaManager';
import { type VaultFileAdapter } from './DatabaseInterface';
import { loadWasmBinary, cacheWasmBinaryIfNeeded, CDN_URL } from './WasmLoader';
import { collectStatementRows, getCachedMultiRowInsertSql, runPreparedStatement } from './StatementRows';
import { batchDeleteRowsByIds } from './BatchDelete';
import { getErrorMessage, ERROR_MESSAGES, WARNING_MESSAGES, CONSOLE_ERRORS } from '../utils/ErrorMessages';
import { rewriteTriggerWithPrefix } from '../utils/SQLParsingUtils';
import { hashString } from '../utils/StringUtils';
import { type SqlResult } from './ChangeDetection';
import type { TriggerFunctions } from '../Triggers';
import type { IndexNoteData, NoteRecord } from '../types';
import type { PreviewResult } from '../Services/PreviewService';
import { logger as rootLogger } from '../utils/logger';


const logger = rootLogger.scope('Database');

/** Options for creating a VaultDatabase instance */
interface DatabaseOptions {
  fileAdapter?: VaultFileAdapter | null;
  useMemoryStorage?: boolean;
  databasePath?: string;
  pluginDir?: string;
  wasmAdapter?: VaultFileAdapter;
  wasmSettings?: WasmSettings;
}

declare const activeWindow: Window;

export class VaultDatabase {
  private db: Database;
  private fileAdapter: VaultFileAdapter | null;
  private databasePath: string;
  private configDir: string;
  public readonly useMemoryStorage: boolean;

  private preparedStatements = new Map<string, Statement>();
  private multiRowInsertSqlCache = new Map<string, string>();
  private previewService: PreviewService;
  public readonly schema: DatabaseSchemaManager;
  private triggerFunctions: TriggerFunctions | null = null;

  private txDepth = 0;

  private dbLock: Promise<void> = Promise.resolve();
  private indexesCreated = false;
  private enabledFeatures: EnabledFeatures | null = null;

  private constructor(db: Database, fileAdapter: VaultFileAdapter | null, useMemoryStorage: boolean, databasePath: string, configDir: string) {
    this.db = db;
    this.fileAdapter = fileAdapter;
    this.useMemoryStorage = useMemoryStorage;
    this.databasePath = databasePath;
    this.configDir = configDir;
    this.previewService = new PreviewService(db);
    this.schema = new DatabaseSchemaManager(db);
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

    const instance = new VaultDatabase(db, fileAdapter, useMemoryStorage, actualDatabasePath, configDir);

    instance.runPragmaStatements();
    CustomSQLFunctions.register(db, app);

    return instance;
  }

  public static async create(app: App, configDir: string, options: DatabaseOptions = {}): Promise<VaultDatabase> {
    const { fileAdapter = null, useMemoryStorage = true, databasePath, pluginDir, wasmAdapter, wasmSettings } = options;
    const actualDatabasePath = databasePath || getDatabasePath(configDir);
    const adapter = wasmAdapter || fileAdapter;

    const wasmLoadResult = await loadWasmBinary(adapter, pluginDir, wasmSettings);
    await cacheWasmBinaryIfNeeded(wasmLoadResult, adapter, pluginDir, wasmSettings, 'VaultQuery');
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
        const data = await fileAdapter!.readBinary(actualDatabasePath);
        db = new sqlJs.Database(new Uint8Array(data));
      }
      catch (error) {
        throw new Error(ERROR_MESSAGES.DATABASE_READ_FAILED(actualDatabasePath, error instanceof Error ? error.message : 'Unknown error'));
      }
    }

    const instance = new VaultDatabase(db, fileAdapter, useMemoryStorage, actualDatabasePath, configDir);

    instance.runPragmaStatements();
    CustomSQLFunctions.register(db, app);
    instance.createSchema();

    try {
      instance.db.run('PRAGMA optimize');
    }
    catch (error) {
      logger.warn(WARNING_MESSAGES.PRAGMA_OPTIMIZE_UNAVAILABLE, error);
    }

    return instance;
  }
  
  public async saveToDisk(): Promise<void> {
    if (this.useMemoryStorage || !this.fileAdapter) return;

    try {
      const array = this.db.export();
      const databaseDir = getDatabaseDir(this.configDir);
      if (!(await this.fileAdapter.exists(databaseDir))) {
        await this.fileAdapter.mkdir(databaseDir);
      }
      
      const ab = array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength);
      await this.fileAdapter.writeBinary(this.databasePath, ab as ArrayBuffer);
    }
    catch (error) {
      logger.error(CONSOLE_ERRORS.DATABASE_SAVE_FAILED, error);
    }
  }

  private runPragmaStatements(): void {
    try {
      for (const pragma of PRAGMA_STATEMENTS) {
        this.db.run(pragma);
      }
    }
    catch (error) {
      logger.warn(WARNING_MESSAGES.DATABASE_OPTIMIZATIONS_UNAVAILABLE, error);
    }
  }

  public async acquireDbLock(): Promise<() => void> {
    let releaseLock: () => void;
    const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
    const previousLock = this.dbLock;
    this.dbLock = lockPromise;
    await previousLock;
    return releaseLock!;
  }

  public async withTx<T>(fn: () => T | Promise<T>, opts: { deferFK?: boolean } = {}): Promise<T> {
    const needsLock = this.txDepth === 0;
    let releaseLock: (() => void) | undefined;

    if (needsLock) {
      releaseLock = await this.acquireDbLock();
    }

    const nested = this.txDepth > 0;
    const sp = `sp_${this.txDepth + 1}`;

    this.txDepth++;
    try {
      if (!nested) {
        this.db.run('BEGIN TRANSACTION');
        if (opts.deferFK) {
          this.db.exec('PRAGMA defer_foreign_keys = ON');
        }
      }
      else {
        this.db.exec(`SAVEPOINT ${sp}`);
      }

      const result = await fn();

      if (!nested) {
        if (opts.deferFK) {
          this.db.exec('PRAGMA defer_foreign_keys = OFF');
        }
        this.db.run('COMMIT');
      }
      else {
        this.db.exec(`RELEASE ${sp}`);
      }

      return result;
    }
    catch (error) {
      if (!nested) {
        try {
          this.db.run('ROLLBACK');
        }
        catch (rollbackError) {
          logger.error(CONSOLE_ERRORS.DATABASE_ROLLBACK_FAILED, rollbackError);
        }
      }
      else {
        try {
          this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        }
        catch (rollbackError) {
          logger.error(CONSOLE_ERRORS.DATABASE_SAVEPOINT_ROLLBACK_FAILED, rollbackError);
        }
      }
      throw error;
    } finally {
      this.txDepth--;
      if (releaseLock) {
        releaseLock();
      }
    }
  }

  private getPreparedStatement(sql: string): Statement {
    const cached = this.preparedStatements.get(sql);
    if (cached) {
      this.preparedStatements.delete(sql);
      this.preparedStatements.set(sql, cached);
      return cached;
    }

    try {
      const stmt = this.db.prepare(sql);
      this.preparedStatements.set(sql, stmt);

      if (this.preparedStatements.size > PREPARED_STATEMENT_CACHE_LIMIT) {
        const firstKey = this.preparedStatements.keys().next().value;
        if (firstKey) {
          const oldStmt = this.preparedStatements.get(firstKey);
          if (oldStmt) {
            try { oldStmt.free(); } catch { /* statement may already be freed */ }
          }
          this.preparedStatements.delete(firstKey);
        }
      }

      return stmt;
    }
    catch (error: unknown) {
      throw new Error(getErrorMessage(error) || ERROR_MESSAGES.SQL_PREPARE_FAILED);
    }
  }

  private cleanupPreparedStatements(): void {
    for (const [, stmt] of this.preparedStatements) {
      try {
        stmt.free();
      }
      catch (error) {
        logger.warn(WARNING_MESSAGES.STATEMENT_FREE_ERROR, error);
      }
    }
    this.preparedStatements.clear();
  }

  private execSchemaBundle(sql: string): void {
    this.db.run('BEGIN');
    try {
      this.db.run('PRAGMA foreign_keys = ON;');
      this.db.exec(sql);
      this.db.run('COMMIT');
    }
    catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  private createSchema(): void {
    this.execSchemaBundle(getTablesOnlySQL());
    this.indexesCreated = false;
  }

  public createIndexes(features?: EnabledFeatures): void {
    if (features) {
      this.enabledFeatures = features;
    }

    if (this.indexesCreated) return;

    try {
      const effectiveFeatures = this.enabledFeatures ?? {
        indexContent: true,
        indexFrontmatter: true,
        indexTables: true,
        indexTasks: true,
        indexHeadings: true,
        indexLinks: true,
        indexTags: true,
        indexListItems: true
      };
      this.execSchemaBundle(getIndexesForFeatures(effectiveFeatures));
      this.indexesCreated = true;
    }
    catch (error) {
      logger.warn('Error creating indexes (may already exist)', error);
      this.indexesCreated = true; 
    }
  }

  public async indexNote(data: IndexNoteData): Promise<void> {
    logger.debug(`indexNote called for: ${data.note.path}`);
    this.createIndexes();
    return this.withTx(() => this.performIndexingOperations(data, false));
  }

  private performIndexingOperations(data: IndexNoteData, skipDeletes: boolean, skipAutoSync: boolean = false): void {
    const adapter = this.createIndexingAdapter();
    performIndexingOperationsCore(adapter, data, skipDeletes, {
      insertNote: (note) => this.insertNote(note),
      replaceProperties: (path, frontmatterData, shouldSkipDeletes) =>
        this.replaceProperties(path, frontmatterData, shouldSkipDeletes, skipAutoSync),
      replaceTasks: (path, tasks, shouldSkipDeletes) =>
        this.replaceTasks(path, tasks, shouldSkipDeletes, skipAutoSync),
      replaceHeadings: (path, headings, shouldSkipDeletes) =>
        this.replaceHeadings(path, headings, shouldSkipDeletes, skipAutoSync),
      replaceListItems: (path, listItems, shouldSkipDeletes) =>
        this.replaceListItems(path, listItems, shouldSkipDeletes, skipAutoSync),
      replaceUserFunctions: (path, userFunctions, shouldSkipDeletes) =>
        this.replaceUserFunctions(path, userFunctions, shouldSkipDeletes),
      replaceUserTriggers: (path, userTriggers, shouldSkipDeletes) =>
        this.replaceUserTriggers(path, userTriggers, shouldSkipDeletes),
    }, logger);
  }

  // Indexing operations - using shared SQL constants and row transformations
  // Use separate INSERT/UPDATE to allow AFTER UPDATE triggers to modify the row
  // UPSERT conflicts with triggers that UPDATE the same row during execution
  private insertNote(note: NoteRecord): void {
    const exists = this.db.exec(INDEXING_SQL.CHECK_NOTE_EXISTS, [note.path]);

    if (exists.length > 0 && exists[0].values && exists[0].values.length > 0) {
      // Note exists - run UPDATE (fires AFTER UPDATE triggers)
      this.runWithPreparedStatement(INDEXING_SQL.UPDATE_NOTE, noteToUpdateParams(note));
    } else {
      // Note doesn't exist - run INSERT (fires AFTER INSERT triggers)
      this.runWithPreparedStatement(INDEXING_SQL.INSERT_NOTE, noteToParams(note));
    }

    // NOTE: Auto-sync for notes.content is DISABLED.
    // Direct SQL changes to notes.content (like `UPDATE notes SET content = ...`) will NOT sync to files.
    // Avoids conflicts when both direct SQL triggers and vq_* functions are used in the same indexing pass.
    // To sync content changes to files, use vq_set_content() or vq_replace_content() instead.
    //
    // The issue: Direct SQL triggers (like replace_today_db) queue set_content actions,
    // while vq_* triggers (like archive_completed_task) queue line-based actions (update_task).
    // When set_content runs first, it can shift line numbers, causing line-based actions to fail.
  }

  private replaceProperties(path: string, propertiesData?: Array<{key: string; value: string; valueType: string; arrayIndex: number | null}>, skipDeletes: boolean = false, skipAutoSync: boolean = false): void {
    const originalPropsInDB = new Set<string>();
    if (!skipAutoSync) {
      const existingResult = this.db.exec(INDEXING_SQL.SELECT_PROPERTIES_FOR_SYNC, [path]);
      if (existingResult.length > 0 && existingResult[0].values) {
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
      if (syncResult.length > 0 && syncResult[0].values) {
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

      const tuples = allKeysToKeep.map(p =>
        `('${p.key.replace(/'/g, "''")}', ${p.arrayIndex ?? -1})`
      ).join(', ');

      const deleteStaleSQL = `${INDEXING_SQL.DELETE_STALE_PROPERTIES}(VALUES ${tuples})`;
      this.db.run(deleteStaleSQL, [path]);
    }
  }

  public run(sql: string, params: (string | number | null)[] = []): Promise<number> {
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
      exec: (sql, params) => this.db.exec(sql, params as (string | number | null | Uint8Array)[] | undefined) as SqlResult,
      run: (sql, params) => this.db.run(sql, params as (string | number | null | Uint8Array)[]),
      runPrepared: (sql, params) => this.runWithPreparedStatement(sql, params),
      batchDeleteByIds: (table, ids) => this.batchDeleteByIds(table, ids),
      runMultiRowInsert: (base, cols, rows) => this.runMultiRowInsert(base, cols, rows),
    };
  }

  // Cache of registered function source hashes to avoid re-registering unchanged functions
  private registeredFunctionHashes = new Map<string, string>();

  public registerCustomFunction(name: string, source: string): void {
    const newHash = hashString(source);
    const existingHash = this.registeredFunctionHashes.get(name);
    if (existingHash === newHash) {
      return;
    }

    // eslint-disable-next-line no-new-func -- user SQL function
    const fn = new Function(`return (${source})`)();

    if (typeof fn !== 'function') {
      throw new Error(`Invalid function definition: expected a function, got ${typeof fn}`);
    }

    this.db.create_function(name, fn);
    this.registeredFunctionHashes.set(name, newHash);
  }

  /**
   * Check if a view's SQL has changed compared to what's stored.
   * Returns true if the view needs to be recreated.
   */
  public viewNeedsRecreation(viewName: string, newSql: string): boolean {
    return this.storedHashNeedsUpdate(INDEXING_SQL.SELECT_VIEW_HASH, viewName, newSql);
  }

  /**
   * Check if a function's source has changed compared to what's stored.
   * Returns true if the function needs to be re-registered.
   */
  public functionNeedsRecreation(functionName: string, newSource: string): boolean {
    const newHash = hashString(newSource);
    const cachedHash = this.registeredFunctionHashes.get(functionName);
    if (cachedHash === newHash) {
      return false;
    }
    return this.storedHashNeedsUpdate(INDEXING_SQL.SELECT_FUNCTION_HASH, functionName, newSource, newHash);
  }

  /**
   * Check if a trigger's SQL has changed compared to what's stored.
   * Returns true if the trigger needs to be recreated.
   */
  public triggerNeedsRecreation(triggerName: string, newSql: string): boolean {
    return this.storedHashNeedsUpdate(INDEXING_SQL.SELECT_TRIGGER_HASH, triggerName, newSql);
  }

  private storedHashNeedsUpdate(selectHashSql: string, name: string, source: string, sourceHash = hashString(source)): boolean {
    try {
      const result = this.db.exec(selectHashSql, [name]);
      if (result.length > 0 && result[0].values?.length > 0) {
        const existingHash = result[0].values[0][0] as string;
        return existingHash !== sourceHash;
      }
    } catch {
      // Table might not exist, needs creation
    }
    return true;
  }

  public async all(sql: string, params: (string | number | null)[] = []): Promise<Record<string, unknown>[]> {
    try {
      const stmt = this.getPreparedStatement(sql);

      try {
        if (params.length > 0) {
          stmt.bind(params);
        }

        const results = collectStatementRows(stmt);
        stmt.reset();

        if (results.length > 1000) {
          await new Promise(resolve => activeWindow.setTimeout(resolve, 0));
        }

        return results;
      }
      catch (error) {
        try {
          stmt.reset();
        }
        catch (resetError) {
          logger.warn(WARNING_MESSAGES.STATEMENT_RESET_ERROR, resetError);
        }
        throw error;
      }
    }
    catch (error: unknown) {
      throw new Error(ERROR_MESSAGES.SQL_QUERY_FAILED(getErrorMessage(error)));
    }
  }

  public runWithPreparedStatement(sql: string, params: (string | number | null)[] = []): void {
    try {
      const stmt = this.getPreparedStatement(sql);
      runPreparedStatement(stmt, params, resetError => {
        logger.warn(WARNING_MESSAGES.STATEMENT_RESET_ERROR, resetError);
      });
    }
    catch (error: unknown) {
      throw new Error(ERROR_MESSAGES.SQL_RUN_FAILED(getErrorMessage(error)));
    }
  }

  private runMultiRowInsert(baseSQL: string, columnsCount: number, rows: (string | number | null)[][], maxRowsPerBatch: number = MAX_ROWS_PER_INSERT_BATCH): void {
    if (rows.length === 0) return;

    for (let i = 0; i < rows.length; i += maxRowsPerBatch) {
      const batch = rows.slice(i, i + maxRowsPerBatch);
      const sql = this.getMultiRowInsertSql(baseSQL, columnsCount, batch.length);
      const params = batch.flat();

      this.db.run(sql, params);
    }
  }

  private getMultiRowInsertSql(baseSQL: string, columnsCount: number, rowCount: number): string {
    return getCachedMultiRowInsertSql(this.multiRowInsertSqlCache, baseSQL, columnsCount, rowCount);
  }

  public async indexNotesBatch(notesData: IndexNoteData[], isInitialIndexing: boolean = false, skipDiskSave: boolean = false): Promise<void> {
    if (notesData.length === 0) return;

    if (isInitialIndexing) {
      this.db.run('PRAGMA foreign_keys = OFF');
    }

    try {
      await this.withTx(() => this.performBatchIndexing(notesData, isInitialIndexing));
    } finally {
      if (isInitialIndexing) {
        this.db.run('PRAGMA foreign_keys = ON');
      }
    }

    if (isInitialIndexing) {
      try {
        this.db.run('ANALYZE');
      }
      catch (error) {
        logger.warn('ANALYZE failed after batch indexing', error);
      }
    }

    if (!skipDiskSave) {
      await this.saveToDisk();
    }
  }

  private performBatchIndexing(notesData: IndexNoteData[], skipDeletes: boolean = false): void {
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
      logger.warn(WARNING_MESSAGES.DUPLICATE_NOTES_IN_BATCH(duplicates.length, duplicates));
    }

    // Skip auto-sync during batch indexing - triggers will process all changes after batch completes
    notesData.forEach(data => this.performIndexingOperations(data, skipDeletes, true));
  }

  public async previewDML(sql: string, params: unknown[] = []): Promise<PreviewResult> {
    const releaseLock = await this.acquireDbLock();
    try {
      // Set preview mode to prevent sync handlers from queuing actions
      // (EditPlanner handles file sync during preview/apply cycle)
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
    const directTarget = this.extractTableRowsTarget(previewResult);
    if (directTarget) {
      this.triggerFunctions?.setDirectApplyTarget(directTarget);
    }

    try {
      // IMPORTANT: Use await, not return. With return, the finally block runs immediately
      // after the Promise is created (before SQL executes). With await, finally runs
      // after the Promise resolves (after SQL completes).
      await this.withTx(() => {
        this.applyDMLWithoutTransaction(previewResult);
      });
    } finally {
      this.triggerFunctions?.setPreviewMode(false);
      this.triggerFunctions?.setDirectApplyTarget(null);
    }
  }

  /**
   * Extract the target table for INSERT INTO table_rows operations.
   * Used to distinguish direct inserts (handled by WriteSyncService) from
   * cascade inserts (which should queue for trigger processing).
   */
  private extractTableRowsTarget(previewResult: PreviewResult): { path: string; tableIndex: number } | null {
    for (const { sql, params } of previewResult.sqlToApply) {
      if (/INSERT\s+INTO\s+table_rows/i.test(sql)) {
        if (params && params.length >= 2) {
          const path = params[0];
          const tableIndex = params[1];
          if (typeof path === 'string' && typeof tableIndex === 'number') {
            return { path, tableIndex };
          }
        }

        // Fallback: parse inline VALUES from SQL
        const valuesMatch = sql.match(/VALUES\s*\(\s*'([^']+)'\s*,\s*(\d+)/i);
        if (valuesMatch) {
          const path = valuesMatch[1];
          const tableIndex = parseInt(valuesMatch[2], 10);
          if (path && !isNaN(tableIndex)) {
            return { path, tableIndex };
          }
        }
      }
    }
    return null;
  }

  private applyDMLWithoutTransaction(previewResult: PreviewResult): void {
    for (const { sql, params } of previewResult.sqlToApply) {
      const stmt = this.db.prepare(sql);
      try {
        stmt.run(params as (string | number | null)[] || []);
      } finally {
        stmt.free();
      }
    }
  }

  /**
   * Check if the database is still healthy (WASM memory not reclaimed).
   * Returns an object with health status and diagnostic info.
   */
  public checkHealth(): { healthy: boolean; error?: string; diagnostics: Record<string, unknown> } {
    const diagnostics: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      useMemoryStorage: this.useMemoryStorage,
      hasDb: !!this.db,
      preparedStatementCount: this.preparedStatements.size
    };

    try {
      const result = this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'");
      const notesTableExists = result.length > 0 && result[0].values.length > 0;

      diagnostics.notesTableExists = notesTableExists;

      if (!notesTableExists) {
        const allTables = this.db.exec("SELECT name FROM sqlite_master WHERE type='table'");
        diagnostics.existingTables = allTables.length > 0
          ? allTables[0].values.map(row => row[0])
          : [];

        return {
          healthy: false,
          error: 'notes table does not exist',
          diagnostics
        };
      }

      const countResult = this.db.exec("SELECT COUNT(*) FROM notes");
      diagnostics.noteCount = countResult.length > 0 ? countResult[0].values[0][0] : 0;

      return { healthy: true, diagnostics };
    } catch (error) {
      diagnostics.exceptionType = error?.constructor?.name;
      diagnostics.exceptionMessage = error instanceof Error ? error.message : String(error);

      return {
        healthy: false,
        error: `Database query failed: ${error instanceof Error ? error.message : String(error)}`,
        diagnostics
      };
    }
  }

  public async close(): Promise<boolean> {
    try {
      await this.saveToDisk();

      this.cleanupPreparedStatements();

      if (typeof this.db.close === 'function') {
        this.db.close();
      }

      return true;
    }
    catch (error) {
      logger.error(CONSOLE_ERRORS.DATABASE_CLOSE_ERROR, error);
      return false;
    }
  }

  private replaceTasks(path: string, tasks: IndexNoteData['tasks'], skipDeletes: boolean = false, skipAutoSync: boolean = false): void {
    // We compare against file data, not DB data, to detect trigger modifications
    const fileTasks = new Map<number, { status: string; task_text: string }>();
    if (tasks && this.shouldPerformAutoSync(skipAutoSync, tasks.length)) {
      for (const task of tasks) {
        fileTasks.set(task.line_number, {
          status: task.status,
          task_text: task.task_text
        });
      }
    }

    replaceTasksCore(this.createIndexingAdapter(), path, tasks, skipDeletes);

    // Auto-sync: Check if a trigger modified tasks (compare DB state vs file state)
    if (this.shouldPerformAutoSync(skipAutoSync, fileTasks.size)) {
      try {
        const syncResult = this.db.exec(INDEXING_SQL.SELECT_TASKS_FOR_SYNC, [path]);
        if (syncResult.length > 0 && syncResult[0].values) {
          for (const row of syncResult[0].values) {
            const lineNumber = row[0] as number;
            const dbStatus = row[1] as string;
            const dbTaskText = row[2] as string;
            const fileTask = fileTasks.get(lineNumber);
            // If DB differs from file, a trigger modified it - queue sync
            if (fileTask && (fileTask.status !== dbStatus || fileTask.task_text !== dbTaskText)) {
              this.triggerFunctions!.queueUpdateTask(path, lineNumber, dbStatus, dbTaskText);
            }
          }
        }
      } catch (error) {
        logger.warn(WARNING_MESSAGES.AUTO_SYNC_COMPARISON_ERROR, error);
      }
    }
  }

  private replaceHeadings(path: string, headings: IndexNoteData['headings'], skipDeletes: boolean = false, skipAutoSync: boolean = false): void {
    const fileHeadingsForSync = new Map<number, { level: number; heading_text: string }>();
    if (headings && this.shouldPerformAutoSync(skipAutoSync, headings.length)) {
      for (const heading of headings) {
        fileHeadingsForSync.set(heading.line_number, {
          level: heading.level,
          heading_text: heading.heading_text
        });
      }
    }

    replaceHeadingsCore(this.createIndexingAdapter(), path, headings, skipDeletes);

    // Auto-sync: Check if a trigger modified headings (compare DB state vs file state)
    if (this.shouldPerformAutoSync(skipAutoSync, fileHeadingsForSync.size)) {
      try {
        const syncResult = this.db.exec(INDEXING_SQL.SELECT_HEADINGS_FOR_SYNC, [path]);
        if (syncResult.length > 0 && syncResult[0].values) {
          for (const row of syncResult[0].values) {
            const lineNumber = row[0] as number;
            const dbLevel = row[1] as number;
            const dbHeadingText = row[2] as string;
            const fileHeading = fileHeadingsForSync.get(lineNumber);
            if (fileHeading && (fileHeading.level !== dbLevel || fileHeading.heading_text !== dbHeadingText)) {
              this.triggerFunctions!.queueUpdateHeading(path, lineNumber, dbLevel, dbHeadingText);
            }
          }
        }
      } catch (error) {
        logger.warn(WARNING_MESSAGES.AUTO_SYNC_COMPARISON_ERROR, error);
      }
    }
  }

  private replaceListItems(path: string, listItems: IndexNoteData['listItems'], skipDeletes: boolean = false, skipAutoSync: boolean = false): void {
    // We compare against file data, not DB data, to detect trigger modifications
    const fileListItems = new Map<number, { content: string }>();
    if (listItems && this.shouldPerformAutoSync(skipAutoSync, listItems.length)) {
      for (const item of listItems) {
        fileListItems.set(item.line_number, {
          content: item.content
        });
      }
    }

    replaceListItemsCore(this.createIndexingAdapter(), path, listItems, skipDeletes);

    // Auto-sync: Check if a trigger modified list items (compare DB state vs file state)
    if (this.shouldPerformAutoSync(skipAutoSync, fileListItems.size)) {
      try {
        const syncResult = this.db.exec(INDEXING_SQL.SELECT_LIST_ITEMS_FOR_SYNC, [path]);
        if (syncResult.length > 0 && syncResult[0].values) {
          for (const row of syncResult[0].values) {
            const lineNumber = row[0] as number;
            const dbContent = row[1] as string;
            const fileItem = fileListItems.get(lineNumber);
            // If DB differs from file, a trigger modified it - queue sync
            if (fileItem && fileItem.content !== dbContent) {
              this.triggerFunctions!.queueUpdateListItem(path, lineNumber, dbContent);
            }
          }
        }
      } catch (error) {
        logger.warn(WARNING_MESSAGES.AUTO_SYNC_COMPARISON_ERROR, error);
      }
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

  public getAllUserTriggers(): Array<{trigger_name: string; path: string; trigger_sql: string; enabled: number}> {
    try {
      const results = this.db.exec(INDEXING_SQL.SELECT_ALL_USER_TRIGGERS);
      return results[0]?.values?.map(row => ({
        trigger_name: row[0] as string,
        path: row[1] as string,
        trigger_sql: row[2] as string,
        enabled: row[3] as number
      })) ?? [];
    }
    catch (e) {
      logger.warn('DatabaseService.getAllUserTriggers: Query failed', e);
      return [];
    }
  }

  /**
   * Register all user triggers from _user_triggers table with SQLite.
   * Called once after vault indexing completes to activate all triggers.
   */
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

  /**
   * Register all user functions from _user_functions table with SQLite.
   * Called once after vault indexing completes (or after database transfer from worker).
   * Functions are stored in the database but need to be re-registered with create_function
   * since that's an in-memory operation that doesn't persist in the SQLite binary.
   */
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

  /**
   * Register a single trigger at render time.
   * Called by TriggerCodeBlockProcessor when a trigger block is rendered.
   * Stores the trigger in _user_triggers table and activates it immediately.
   */
  public registerTrigger(triggerName: string, triggerSql: string, sourcePath?: string): void {
    // Validate trigger SQL - reject patterns that won't sync to files
    const disallowedPatterns = [
      { pattern: /UPDATE\s+notes\s+SET\s+content\s*=/i, message: 'UPDATE notes SET content is not auto-synced. Use vq_replace_content() or vq_set_content() instead.' },
    ];
    for (const { pattern, message } of disallowedPatterns) {
      if (pattern.test(triggerSql)) {
        throw new Error(message);
      }
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

  /**
   * Internal helper to activate a SQLite trigger.
   * Handles name prefixing and {this.path} placeholder replacement.
   */
  private activateTrigger(triggerName: string, triggerSql: string, sourcePath?: string): void {
    const prefixedName = `_vq_user_${triggerName}`;

    this.db.run(`DROP TRIGGER IF EXISTS "${prefixedName}"`);

    // Replace {this.path} placeholder with the actual source path (escaped for SQL string literals)
    const sqlWithPath = sourcePath
      ? triggerSql.replace(/\{this\.path\}/g, sourcePath.replace(/'/g, "''"))
      : triggerSql;

    // Rewrite triggers on table_rows VIEW to use _table_row_events shadow table
    // (SQLite views only support INSTEAD OF triggers, not AFTER triggers)
    const sqlWithTableRowsRewrite = sqlWithPath.replace(
      /\bON\s+table_rows\b/gi,
      'ON _table_row_events'
    );

    const prefixedSql = rewriteTriggerWithPrefix(sqlWithTableRowsRewrite, '_vq_user_');

    logger.debug(`Activating trigger ${prefixedName}`, prefixedSql);
    this.db.run(prefixedSql);

    const verify = this.db.exec(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`, [prefixedName]);
    if (verify.length > 0 && verify[0].values?.length > 0) {
      logger.debug(`Trigger ${prefixedName} verified in sqlite_master`);
    } else {
      logger.error(`Trigger ${prefixedName} NOT FOUND in sqlite_master after creation`);
    }
  }

  public getAllUserViews(): Array<{view_name: string; path: string; sql: string}> {
    try {
      const results = this.db.exec(INDEXING_SQL.SELECT_ALL_USER_VIEWS);
      return results[0]?.values?.map(row => ({
        view_name: row[0] as string,
        path: row[1] as string,
        sql: row[2] as string
      })) ?? [];
    }
    catch (e) {
      logger.warn('DatabaseService.getAllUserViews: Query failed', e);
      return [];
    }
  }

  public getAllUserFunctions(): Array<{function_name: string; path: string; source: string}> {
    try {
      const results = this.db.exec(INDEXING_SQL.SELECT_ALL_USER_FUNCTIONS);
      return results[0]?.values?.map(row => ({
        function_name: row[0] as string,
        path: row[1] as string,
        source: row[2] as string
      })) ?? [];
    }
    catch (e) {
      logger.warn('DatabaseService.getAllUserFunctions: Query failed', e);
      return [];
    }
  }

  /**
   * Register trigger functions (vq_set_property, vq_remove_property, etc.) with the database.
   * These functions are called from user-defined SQLite triggers.
   */
  public registerTriggerFunctions(triggerFunctions: TriggerFunctions): void {
    this.triggerFunctions = triggerFunctions;
    triggerFunctions.register(this.db);
  }

  /**
   * Helper to check if auto-sync should be performed.
   * Consolidates the repeated conditional check across replace* methods.
   */
  private shouldPerformAutoSync(skipAutoSync: boolean, dataLength: number | undefined): boolean {
    return !skipAutoSync &&
           !!dataLength &&
           !!this.triggerFunctions &&
           !this.triggerFunctions.getIsProcessingTriggers();
  }
}
