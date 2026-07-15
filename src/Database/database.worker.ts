import initSqlJs, { Database, Statement, type SqlJsStatic } from 'sql.js';
import { WorkerSQLFunctions } from './WorkerSQLFunctions';
import { EnabledFeatures, migrateLinksColumns } from './DatabaseSchema';
import { createSchema as createSchemaCore, createIndexes as createIndexesCore, runPragmaStatements as runPragmaStatementsCore, MatRefreshSqlCache, LINKS_MIGRATED_LOG_MESSAGE } from './SchemaOperations';
import type { IndexCreationState } from './SchemaOperations';
import { StatementCache } from './StatementCache';
import { DatabaseSchemaManager } from './DatabaseSchemaManager';
import { INDEXING_SQL, PREPARED_STATEMENT_CACHE_LIMIT, MAX_ROWS_PER_INSERT_BATCH } from './IndexingQueries';
import type { WorkerRequest, WorkerResponse } from './worker-types';
import type { IndexNoteData } from '../types/types.d.ts';
import { hashString } from '../utils/StringUtils';
import { getErrorMessage } from '../utils/ErrorMessages';
import { createUserSqlFunction } from '../utils/UserFunctionEvaluator';
import { checkSqlJsDatabaseHealth } from './DatabaseHealth';
import { collectStatementRows, runMultiRowInsertBatches, runPreparedStatement } from './StatementRows';
import { batchDeleteRowsByIds } from './BatchDelete';
import { queryRows } from './QueryRows';
import { insertNoteCore, replaceTasksCore, replaceHeadingsCore, replaceListItemsCore, replacePropertiesCore, replaceUserFunctionsCore, replaceUserTriggersCore, performIndexingOperationsCore } from './IndexingOperations';
import type { IndexingLogger, IndexingDbAdapter } from './IndexingOperations';

const CDN_URL = 'https://sql.js.org/dist/sql-wasm.wasm';

let db: Database | null = null;
let sqlJsModule: SqlJsStatic | null = null;
let schemaManager: DatabaseSchemaManager | null = null;
const indexState: IndexCreationState = { indexesCreated: false, enabledFeatures: null };
const multiRowInsertSqlCache = new Map<string, string>();
const logger: IndexingLogger = {
  debug: () => {},
  warn: (message: string, ...data: unknown[]) => console.warn(`[Worker] ${message}`, ...data),
  error: (message: string, ...data: unknown[]) => console.error(`[Worker] ${message}`, ...data),
};
const statementCache = new StatementCache(PREPARED_STATEMENT_CACHE_LIMIT, (message, error) => logger.warn(message, error));
const matRefreshSqlCache = new MatRefreshSqlCache((message, error) => logger.warn(message, error));

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
  return statementCache.get(db, sql);
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

function batchDeleteByIds(tableName: string, ids: number[]): void {
  if (!db || ids.length === 0) return;
  const activeDb = db;
  batchDeleteRowsByIds(tableName, ids, (sql, params) => activeDb.run(sql, params));
}

function createSchema(): void {
  if (!db) return;
  createSchemaCore(db, message => logger.warn(message));
  indexState.indexesCreated = false;
}

function createIndexes(features?: EnabledFeatures): void {
  if (!db) return;
  createIndexesCore(db, features, indexState, (message, error) => logger.error(message, error));
}

function runPragmaStatements(): void {
  if (!db) return;
  runPragmaStatementsCore(db, error => logger.warn('Some PRAGMA statements not available:', error));
}

function checkHealth(): { healthy: boolean; error?: string; diagnostics: Record<string, unknown> } {
  return checkSqlJsDatabaseHealth(db, {
    timestamp: new Date().toISOString(),
    mode: 'worker',
    preparedStatementCount: statementCache.size,
    indexesCreated: indexState.indexesCreated,
  });
}

function createIndexingAdapter(): IndexingDbAdapter {
  if (!db) throw new Error('Database not initialized');
  return {
    exec: (sql, params) => db!.exec(sql, params as (string | number | null | Uint8Array)[] | undefined),
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

function propertiesMatRefreshSql(): { deleteSql: string; insertSql: string } | null {
  if (!db) return null;
  return matRefreshSqlCache.get(db, getAllPropertyKeys);
}

function registerCustomFunction(name: string, source: string): void {
  if (!db) return;
  db.create_function(name, createUserSqlFunction(source));
}

function performIndexingOperations(data: IndexNoteData, skipDeletes: boolean): void {
  const adapter = createIndexingAdapter();
  performIndexingOperationsCore(adapter, data, skipDeletes, {
    insertNote: note => insertNoteCore(adapter, note),
    replaceProperties,
    propertiesMatRefreshSql,
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

function workerQueryRows<T>(sql: string, mapRow: (row: unknown[]) => T): T[] {
  if (!db) return [];
  return queryRows(queryValues, sql, mapRow);
}

function getAllPropertyKeys(): string[] {
  return schemaManager?.getAllPropertyKeys() ?? [];
}

function getViewNames(): string[] {
  return schemaManager?.getViewNames() ?? [];
}

function getViewColumns(viewName: string): string[] {
  return schemaManager?.getViewColumns(viewName) ?? [];
}

function getAllUserViews(): Array<{view_name: string; path: string; sql: string}> {
  return workerQueryRows(INDEXING_SQL.SELECT_ALL_USER_VIEWS, row => ({
    view_name: row[0] as string,
    path: row[1] as string,
    sql: row[2] as string
  }));
}

function getAllUserFunctions(): Array<{function_name: string; path: string; source: string}> {
  return workerQueryRows(INDEXING_SQL.SELECT_ALL_USER_FUNCTIONS, row => ({
    function_name: row[0] as string,
    path: row[1] as string,
    source: row[2] as string
  }));
}

function getAllUserTriggers(): Array<{trigger_name: string; path: string; trigger_sql: string; enabled: number}> {
  return workerQueryRows(INDEXING_SQL.SELECT_ALL_USER_TRIGGERS, row => ({
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

  // Activation happens on the main thread; see registerUserTriggers.
}

/**
 * No-op in the worker: user triggers call vq_* functions, which are only
 * registered on the main thread, so activation happens there after the
 * database is transferred.
 */
function registerUserTriggers(): void {
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
        schemaManager = new DatabaseSchemaManager(db);
        matRefreshSqlCache.invalidate();
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
        statementCache.freeAll();

        db.close();
        db = new sqlJsModule.Database(new Uint8Array(request.data));
        schemaManager = new DatabaseSchemaManager(db);
        matRefreshSqlCache.invalidate();
        runPragmaStatements();
        WorkerSQLFunctions.register(db);
        if (migrateLinksColumns(db)) {
          logger.warn(LINKS_MIGRATED_LOG_MESSAGE);
        }

        respond({ type: 'success', id: request.id });
        break;
      }

      case 'close': {
        statementCache.freeAll();

        if (db) {
          db.close();
          db = null;
        }
        schemaManager = null;
        matRefreshSqlCache.invalidate();
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'rebuildPropertiesView': {
        matRefreshSqlCache.invalidate();
        schemaManager?.rebuildPropertiesView();
        respond({ type: 'success', id: request.id });
        break;
      }

      case 'rebuildTableViews': {
        schemaManager?.rebuildTableViews(request.enableDynamicTableViews);
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
