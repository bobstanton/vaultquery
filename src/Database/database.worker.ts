import initSqlJs, { Database, Statement, type SqlJsStatic } from 'sql.js';
import { WorkerSQLFunctions } from './WorkerSQLFunctions';
import { getTablesOnlySQL, getIndexesForFeatures, EnabledFeatures, generateDynamicPropertiesView, generateNotePropertiesView, generateDynamicTableViews, TableStructure } from './DatabaseSchema';
import { PRAGMA_STATEMENTS, SQL_QUERIES, getViewColumnsPragma, processTableStructureResults } from './SchemaQueries';
import {
  INDEXING_SQL,
  PREPARED_STATEMENT_CACHE_LIMIT,
  MAX_ROWS_PER_INSERT_BATCH,
  noteToParams,
  noteToUpdateParams,
} from './IndexingQueries';
import type { WorkerRequest, WorkerResponse } from './worker-types';
import type { IndexNoteData } from '../types/types.d.ts';
import { hashString } from '../utils/StringUtils';
import { getErrorMessage } from '../utils/ErrorMessages';
import { createUserSqlFunction } from '../utils/UserFunctionEvaluator';
import { type SqlResult } from './ChangeDetection';
import { checkSqlJsDatabaseHealth } from './DatabaseHealth';
import { collectStatementRows, runMultiRowInsertBatches, runPreparedStatement } from './StatementRows';
import { batchDeleteRowsByIds } from './BatchDelete';
import {
  replaceTasksCore,
  replaceHeadingsCore,
  replaceListItemsCore,
  replacePropertiesCore,
  replaceUserFunctionsCore,
  replaceUserTriggersCore,
  performIndexingOperationsCore,
  type IndexingLogger,
  type IndexingDbAdapter,
} from './IndexingOperations';

const CDN_URL = 'https://sql.js.org/dist/sql-wasm.wasm';

let db: Database | null = null;
let sqlJsModule: SqlJsStatic | null = null;
let indexesCreated = false;
let enabledFeatures: EnabledFeatures | null = null;
const preparedStatements = new Map<string, Statement>();
const multiRowInsertSqlCache = new Map<string, string>();
const logger: IndexingLogger = {
  debug: () => {},
  warn: (message: string, ...data: unknown[]) => console.warn(`[Worker] ${message}`, ...data),
  error: (message: string, ...data: unknown[]) => console.error(`[Worker] ${message}`, ...data),
};

function respond(response: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(response, { transfer });
  } else {
    self.postMessage(response);
  }
}

function handleError(id: number, error: unknown): void {
  respond({ type: 'error', id, error: getErrorMessage(error) });
}

function getPreparedStatement(sql: string): Statement {
  if (!db) throw new Error('Database not initialized');

  const cached = preparedStatements.get(sql);
  if (cached) {
    preparedStatements.delete(sql);
    preparedStatements.set(sql, cached);
    return cached;
  }

  const stmt = db.prepare(sql);
  preparedStatements.set(sql, stmt);

  if (preparedStatements.size > PREPARED_STATEMENT_CACHE_LIMIT) {
    const firstKey = preparedStatements.keys().next().value;
    if (firstKey) {
      const oldStmt = preparedStatements.get(firstKey);
      if (oldStmt) {
        freePreparedStatement(oldStmt);
      }
      preparedStatements.delete(firstKey);
    }
  }

  return stmt;
}

function freePreparedStatement(stmt: Statement): void {
  try {
    stmt.free();
  }
  catch (error) {
    logger.warn('Failed to free prepared statement', error);
  }
}

function queryValues(sql: string): unknown[][] {
  if (!db) throw new Error('Database not initialized');

  try {
    return db.exec(sql)[0]?.values ?? [];
  }
  catch (error) {
    logger.error('Worker query failed', sql, error);
    throw error;
  }
}

function safeQueryValues(sql: string): unknown[][] {
  try {
    return queryValues(sql);
  }
  catch {
    return [];
  }
}

function batchDeleteByIds(tableName: string, ids: number[]): void {
  if (!db || ids.length === 0) return;
  const activeDb = db;
  batchDeleteRowsByIds(tableName, ids, (sql, params) => activeDb.run(sql, params));
}

function execSchemaBundle(sql: string): void {
  if (!db) return;
  db.run('BEGIN');
  try {
    db.run('PRAGMA foreign_keys = ON;');
    db.exec(sql);
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function createSchema(): void {
  execSchemaBundle(getTablesOnlySQL());
  indexesCreated = false;
}

function createIndexes(features?: EnabledFeatures): void {
  if (!db) return;

  if (features) {
    enabledFeatures = features;
  }

  if (indexesCreated) return;

  try {
    const effectiveFeatures = enabledFeatures ?? {
      indexContent: true,
      indexFrontmatter: true,
      indexTables: true,
      indexTasks: true,
      indexHeadings: true,
      indexLinks: true,
      indexTags: true,
      indexListItems: true
    };
    execSchemaBundle(getIndexesForFeatures(effectiveFeatures));
    indexesCreated = true;
  } catch (error) {
    console.warn('[Worker] Error creating indexes (may already exist):', error);
    indexesCreated = true;
  }
}

function runPragmaStatements(): void {
  if (!db) return;
  try {
    for (const pragma of PRAGMA_STATEMENTS) {
      db.run(pragma);
    }
  } catch (error) {
    console.warn('[Worker] Some PRAGMA statements not available:', error);
  }
}

function checkHealth(): { healthy: boolean; error?: string; diagnostics: Record<string, unknown> } {
  return checkSqlJsDatabaseHealth(db, {
    timestamp: new Date().toISOString(),
    mode: 'worker',
    preparedStatementCount: preparedStatements.size,
    indexesCreated,
  });
}

function createIndexingAdapter(): IndexingDbAdapter {
  if (!db) throw new Error('Database not initialized');
  return {
    exec: (sql, params) => db!.exec(sql, params as (string | number | null | Uint8Array)[] | undefined) as SqlResult,
    run: (sql, params) => db!.run(sql, params as (string | number | null | Uint8Array)[]),
    runPrepared: (sql, params) => {
      const stmt = getPreparedStatement(sql);
      runPreparedStatement(stmt, params, resetError => {
        logger.warn('Failed to reset prepared statement', resetError);
      });
    },
    batchDeleteByIds: (table, ids) => batchDeleteByIds(table, ids),
    runMultiRowInsert: (base, cols, rows) => runMultiRowInsertBatches(multiRowInsertSqlCache, base, cols, rows, MAX_ROWS_PER_INSERT_BATCH, (sql, params) => {
      db!.run(sql, params);
    }),
  };
}

// Use separate INSERT/UPDATE to allow AFTER UPDATE triggers to modify the row
// UPSERT conflicts with triggers that UPDATE the same row during execution
function insertNote(note: IndexNoteData['note']): void {
  if (!db) throw new Error('Database not initialized');

  const exists = db.exec(INDEXING_SQL.CHECK_NOTE_EXISTS, [note.path]);
  if (exists.length > 0 && exists[0].values && exists[0].values.length > 0) {
    const stmt = getPreparedStatement(INDEXING_SQL.UPDATE_NOTE);
    runPreparedStatement(stmt, noteToUpdateParams(note), resetError => {
      logger.warn('Failed to reset prepared statement', resetError);
    });
  } else {
    const stmt = getPreparedStatement(INDEXING_SQL.INSERT_NOTE);
    runPreparedStatement(stmt, noteToParams(note), resetError => {
      logger.warn('Failed to reset prepared statement', resetError);
    });
  }
}

function replaceProperties(path: string, propertiesData?: Array<{key: string; value: string; valueType: string; arrayIndex: number | null}>, skipDeletes: boolean = false): void {
  replacePropertiesCore(createIndexingAdapter(), path, propertiesData, skipDeletes);
}

function replaceTasks(path: string, tasks?: IndexNoteData['tasks'], skipDeletes: boolean = false): void {
  replaceTasksCore(createIndexingAdapter(), path, tasks, skipDeletes);
}

function replaceHeadings(path: string, headings?: IndexNoteData['headings'], skipDeletes: boolean = false): void {
  replaceHeadingsCore(createIndexingAdapter(), path, headings, skipDeletes);
}

function replaceListItems(path: string, listItems?: IndexNoteData['listItems'], skipDeletes: boolean = false): void {
  replaceListItemsCore(createIndexingAdapter(), path, listItems, skipDeletes);
}

function replaceUserFunctions(path: string, userFunctions?: IndexNoteData['userFunctions'], skipDeletes: boolean = false): void {
  replaceUserFunctionsCore(createIndexingAdapter(), path, userFunctions, skipDeletes, registerCustomFunction, logger);
}

function replaceUserTriggers(path: string, userTriggers?: IndexNoteData['userTriggers'], skipDeletes: boolean = false): void {
  // Worker does NOT activate triggers - they require vq_* functions which are only available on main thread
  replaceUserTriggersCore(createIndexingAdapter(), path, userTriggers, skipDeletes, null, logger);
}

function registerCustomFunction(name: string, source: string): void {
  if (!db) return;
  db.create_function(name, createUserSqlFunction(source));
}

function performIndexingOperations(data: IndexNoteData, skipDeletes: boolean): void {
  performIndexingOperationsCore(createIndexingAdapter(), data, skipDeletes, {
    insertNote,
    replaceProperties,
    replaceTasks,
    replaceHeadings,
    replaceListItems,
    replaceUserFunctions,
    replaceUserTriggers,
  }, logger);
}

function withTx<T>(fn: () => T): T {
  if (!db) throw new Error('Database not initialized');

  db.run('BEGIN TRANSACTION');
  try {
    const result = fn();
    db.run('COMMIT');
    return result;
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {
      // The original error is more useful than a failed rollback.
    }
    throw error;
  }
}

function getAllPropertyKeys(): string[] {
  if (!db) return [];
  return safeQueryValues(SQL_QUERIES.GET_ALL_PROPERTY_KEYS).map(row => row[0] as string);
}

function getViewNames(): string[] {
  if (!db) return [];
  return safeQueryValues(SQL_QUERIES.GET_VIEW_NAMES).map(row => row[0] as string);
}

function getViewColumns(viewName: string): string[] {
  if (!db) return [];
  return safeQueryValues(getViewColumnsPragma(viewName)).map(row => row[1] as string);
}

function getAllUserViews(): Array<{view_name: string; path: string; sql: string}> {
  if (!db) return [];
  return safeQueryValues(INDEXING_SQL.SELECT_ALL_USER_VIEWS).map(row => ({
    view_name: row[0] as string,
    path: row[1] as string,
    sql: row[2] as string
  }));
}

function getAllUserFunctions(): Array<{function_name: string; path: string; source: string}> {
  if (!db) return [];
  return safeQueryValues(INDEXING_SQL.SELECT_ALL_USER_FUNCTIONS).map(row => ({
    function_name: row[0] as string,
    path: row[1] as string,
    source: row[2] as string
  }));
}

function getAllUserTriggers(): Array<{trigger_name: string; path: string; trigger_sql: string; enabled: number}> {
  if (!db) return [];
  return safeQueryValues(INDEXING_SQL.SELECT_ALL_USER_TRIGGERS).map(row => ({
    trigger_name: row[0] as string,
    path: row[1] as string,
    trigger_sql: row[2] as string,
    enabled: row[3] as number
  }));
}

/**
 * Register a single trigger at render time.
 * Stores the trigger in _user_triggers table but does NOT activate it.
 * Triggers are only activated on the main thread where vq_* functions are available.
 */
function registerTrigger(triggerName: string, triggerSql: string, sourcePath?: string): void {
  if (!db) return;

  if (sourcePath) {
    const sqlHash = hashString(triggerSql);
    const stmt = getPreparedStatement(INDEXING_SQL.INSERT_USER_TRIGGER);
    runPreparedStatement(stmt, [triggerName, sourcePath, triggerSql, sqlHash], resetError => {
      logger.warn('Failed to reset prepared statement', resetError);
    });
  }

  // NOTE: Do NOT activate trigger in worker - vq_* functions are not available here
  // Triggers will be activated on the main thread after DB transfer
}

/**
 * Register all user triggers from _user_triggers table with SQLite.
 * NOTE: This is a no-op in the worker. Triggers that use vq_* functions can only
 * be activated on the main thread where those functions are registered.
 * The main thread will call registerUserTriggers() after receiving the DB.
 */
function registerUserTriggers(): void {
  // No-op in worker - triggers are activated on main thread only
  // because vq_* functions (vq_set_property, vq_rename_note, etc.) are not available here
}

function rebuildPropertiesView(): void {
  if (!db) return;
  try {
    const propertyKeys = getAllPropertyKeys();
    const viewSQL = generateDynamicPropertiesView(propertyKeys);
    db.exec(viewSQL);
    const notePropertiesSQL = generateNotePropertiesView(propertyKeys);
    db.exec(notePropertiesSQL);
  } catch (error) {
    console.error('[Worker] Error rebuilding properties view:', error);
    throw error;
  }
}

function discoverTableStructures(): TableStructure[] {
  if (!db) return [];

  try {
    const results = db.exec(SQL_QUERIES.DISCOVER_TABLE_STRUCTURES);

    if (results.length === 0 || !results[0].values) {
      return [];
    }

    return processTableStructureResults(results[0].values as unknown[][]);
  } catch (error) {
    console.warn('[Worker] Error discovering table structures:', error);
    return [];
  }
}

let lastTableStructuresHash: string | null = null;

function rebuildTableViews(enableDynamicTableViews: boolean): void {
  if (!db || !enableDynamicTableViews) return;

  const structures = discoverTableStructures();
  if (structures.length === 0) {
    return;
  }

  // Skip the DROP/CREATE churn when the structures are unchanged.
  const structuresHash = hashString(JSON.stringify(structures));
  if (structuresHash === lastTableStructuresHash) {
    return;
  }

  const sql = generateDynamicTableViews(structures);
  if (sql) {
    db.exec(sql);
  }
  lastTableStructuresHash = structuresHash;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case 'init': {
        sqlJsModule = await initSqlJs({
          wasmBinary: request.wasmBinary,
          locateFile: request.wasmBinary ? undefined : (() => CDN_URL)
        });

        db = new sqlJsModule.Database();
        runPragmaStatements();
        WorkerSQLFunctions.register(db);
        createSchema();

        try {
          db.run('PRAGMA optimize');
        } catch {
          // PRAGMA optimize is optional and may be unavailable in older SQLite builds.
        }

        respond({ type: 'success', id: request.id });
        break;
      }

      case 'query': {
        if (!db) throw new Error('Database not initialized');

        const stmt = getPreparedStatement(request.sql);
        try {
          if (request.params.length > 0) {
            stmt.bind(request.params);
          }

          const results = collectStatementRows(stmt);
          stmt.reset();

          respond({ type: 'success', id: request.id, result: results });
        } catch (error) {
          try { stmt.reset(); } catch {
            // Preserve the query error if statement cleanup also fails.
          }
          throw error;
        }
        break;
      }

      case 'run': {
        if (!db) throw new Error('Database not initialized');
        db.run(request.sql, request.params);
        respond({ type: 'success', id: request.id, result: db.getRowsModified() });
        break;
      }

      case 'indexNote': {
        createIndexes();
        withTx(() => performIndexingOperations(request.data, false));
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'indexNotesBatch': {
        if (!db) throw new Error('Database not initialized');

        if (request.notesData.length === 0) {
          respond({ type: 'success', id: request.id });
          break;
        }

        if (request.isInitialIndexing) {
          db.run('PRAGMA foreign_keys = OFF');
        }

        try {
          withTx(() => {
            for (const data of request.notesData) {
              performIndexingOperations(data, request.isInitialIndexing);
            }
          });
        } finally {
          if (request.isInitialIndexing) {
            db.run('PRAGMA foreign_keys = ON');
          }
        }

        if (request.isInitialIndexing) {
          try {
            db.run('ANALYZE');
          } catch {
            // ANALYZE improves planner statistics but is not required for correctness.
          }
        }

        respond({ type: 'success', id: request.id });
        break;
      }

      case 'createIndexes': {
        createIndexes(request.features);
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'registerFunction': {
        registerCustomFunction(request.name, request.source);
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'deleteNote': {
        if (!db) throw new Error('Database not initialized');
        db.run('DELETE FROM notes WHERE path = ?', [request.path]);
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'export': {
        if (!db) throw new Error('Database not initialized');
        const data = db.export();
        // Transfer instead of structured-clone: the database can be tens of
        // megabytes, and export() already returned a fresh buffer we own.
        respond({ type: 'success', id: request.id, result: data.buffer }, [data.buffer]);
        break;
      }

      case 'import': {
        if (!db) throw new Error('Database not initialized');
        if (!sqlJsModule) throw new Error('SQL.js module not initialized');
        for (const stmt of preparedStatements.values()) {
          try { stmt.free(); } catch {
            // Continue importing even if a stale prepared statement cannot be freed.
          }
        }
        preparedStatements.clear();

        db.close();
        db = new sqlJsModule.Database(new Uint8Array(request.data));
        lastTableStructuresHash = null;
        runPragmaStatements();
        WorkerSQLFunctions.register(db);

        respond({ type: 'success', id: request.id });
        break;
      }

      case 'close': {
        for (const stmt of preparedStatements.values()) {
          try { stmt.free(); } catch {
            // Continue closing the worker even if statement cleanup fails.
          }
        }
        preparedStatements.clear();

        if (db) {
          db.close();
          db = null;
        }
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'rebuildPropertiesView': {
        rebuildPropertiesView();
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'rebuildTableViews': {
        rebuildTableViews(request.enableDynamicTableViews);
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'getAllPropertyKeys': {
        respond({ type: 'success', id: request.id, result: getAllPropertyKeys() });
        break;
      }

      case 'getViewNames': {
        respond({ type: 'success', id: request.id, result: getViewNames() });
        break;
      }

      case 'getViewColumns': {
        respond({ type: 'success', id: request.id, result: getViewColumns(request.viewName) });
        break;
      }

      case 'getAllUserViews': {
        respond({ type: 'success', id: request.id, result: getAllUserViews() });
        break;
      }

      case 'getAllUserFunctions': {
        respond({ type: 'success', id: request.id, result: getAllUserFunctions() });
        break;
      }

      case 'getAllUserTriggers': {
        respond({ type: 'success', id: request.id, result: getAllUserTriggers() });
        break;
      }

      case 'registerTrigger': {
        registerTrigger(request.triggerName, request.triggerSql, request.sourcePath);
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'registerUserTriggers': {
        registerUserTriggers();
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'health': {
        respond({ type: 'success', id: request.id, result: checkHealth() });
        break;
      }

      default: {
        respond({ type: 'error', id: (request as { id: number }).id, error: `Unknown request type` });
      }
    }
  } catch (error) {
    handleError(request.id, error);
  }
};

respond({ type: 'ready' });
