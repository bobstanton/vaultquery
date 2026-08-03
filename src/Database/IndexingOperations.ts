/**
 * Shared indexing operations for DatabaseService and database.worker.
 * Uses adapter pattern to abstract away database access differences.
 */

import { INDEXING_SQL, noteToParams, noteToUpdateParams, propertyToParams, userViewToParams, userFunctionToParams, userTriggerToParams } from './IndexingQueries';
import type { InputPropertyData } from './IndexingQueries';
import { hashString } from '../utils/StringUtils';
import { TASKS_ENTITY, HEADINGS_ENTITY, LIST_ITEMS_ENTITY, LINKS_ENTITY, TAGS_ENTITY, TABLE_CELLS_ENTITY, EMBEDS_ENTITY, BLOCKS_ENTITY, UNRESOLVED_LINKS_ENTITY, TABLES_SQL, detectEntityChanges, entityInsertRow, entityUpdatePlan, mapEntityRow } from './EntityDescriptors';
import type { EntityDescriptor, InsertEntityDescriptor, SqlParam, SqlResult } from './EntityDescriptors';
import { detectPropertyChanges } from './ChangeDetection';
import type { PropertyData, PropertyChanges } from './ChangeDetection';
import type { IndexNoteData, UserViewData, UserFunctionData, UserTriggerData } from '../types';

export interface IndexingLogger {
  debug(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

/**
 * Adapter interface for database operations.
 * Abstracts the differences between main thread and worker database access.
 */
export interface IndexingDbAdapter {
  /** Execute a query and return results */
  exec(sql: string, params?: unknown[]): SqlResult;
  /** Run a statement (no results) */
  run(sql: string, params: unknown[]): void;
  /** Run with prepared statement caching */
  runPrepared(sql: string, params: (string | number | null)[]): void;
  /** Batch delete rows by ID */
  batchDeleteByIds(tableName: string, ids: number[]): void;
  /** Multi-row insert */
  runMultiRowInsert(baseSQL: string, columnsCount: number, rows: (string | number | null)[][]): void;
}

type SqlRow = SqlResult[number]['values'][number];

function execRows<T>(adapter: IndexingDbAdapter, sql: string, params: unknown[], mapRow: (row: SqlRow) => T): T[] {
  const result = adapter.exec(sql, params);
  if (result.length === 0) {
    return [];
  }
  return result[0].values.map(mapRow);
}

interface IndexingOperationHandlers {
  insertNote(note: IndexNoteData['note']): void;
  replaceProperties(path: string, frontmatterData: IndexNoteData['frontmatterData'], skipDeletes: boolean): void;
  propertiesMatRefreshSql?(): { deleteSql: string; insertSql: string } | null;
  replaceTasks(path: string, tasks: IndexNoteData['tasks'], skipDeletes: boolean): void;
  replaceHeadings(path: string, headings: IndexNoteData['headings'], skipDeletes: boolean): void;
  replaceListItems(path: string, listItems: IndexNoteData['listItems'], skipDeletes: boolean): void;
  replaceUserFunctions(path: string, userFunctions: IndexNoteData['userFunctions'], skipDeletes: boolean): void;
  replaceUserTriggers(path: string, userTriggers: IndexNoteData['userTriggers'], skipDeletes: boolean): void;
}

/**
 * Shared orchestration for applying indexed note data.
 * Main-thread and worker databases provide handlers for operations that need
 * environment-specific behavior, while pure table replacements stay shared here.
 */
export function insertNoteCore(adapter: IndexingDbAdapter, note: IndexNoteData['note']): void {
  const exists = adapter.exec(INDEXING_SQL.CHECK_NOTE_EXISTS, [note.path]);

  if (exists.length > 0 && exists[0].values.length > 0) {
    adapter.runPrepared(INDEXING_SQL.UPDATE_NOTE, noteToUpdateParams(note));
  } else {
    adapter.runPrepared(INDEXING_SQL.INSERT_NOTE, noteToParams(note));
  }
}

export function performIndexingOperationsCore(adapter: IndexingDbAdapter, data: IndexNoteData, skipDeletes: boolean, handlers: IndexingOperationHandlers, logger: IndexingLogger): void {
  const { note, frontmatterData, tables, tableCells, tasks, headings, links, unresolvedLinks, embeds, tags, listItems, blocks, userViews, userFunctions, userTriggers } = data;

  handlers.insertNote(note);

  const replacements: Array<[unknown[] | undefined, () => void]> = [
    [frontmatterData, () => {
      handlers.replaceProperties(note.path, frontmatterData, skipDeletes);
      const matRefresh = handlers.propertiesMatRefreshSql?.();
      if (matRefresh) {
        adapter.run(matRefresh.deleteSql, [note.path]);
        adapter.run(matRefresh.insertSql, [note.path]);
      }
    }],
    [tables, () => replaceTablesCore(adapter, note.path, tables, skipDeletes)],
    [tableCells, () => replaceEntityCore(adapter, TABLE_CELLS_ENTITY, note.path, tableCells, skipDeletes)],
    [tasks, () => handlers.replaceTasks(note.path, tasks, skipDeletes)],
    [headings, () => handlers.replaceHeadings(note.path, headings, skipDeletes)],
    [links, () => replaceEntityCore(adapter, LINKS_ENTITY, note.path, links, skipDeletes)],
    [unresolvedLinks, () => replaceInsertEntityCore(adapter, UNRESOLVED_LINKS_ENTITY, note.path, unresolvedLinks, skipDeletes)],
    [embeds, () => replaceInsertEntityCore(adapter, EMBEDS_ENTITY, note.path, embeds, skipDeletes)],
    [tags, () => replaceEntityCore(adapter, TAGS_ENTITY, note.path, tags, skipDeletes)],
    [listItems, () => handlers.replaceListItems(note.path, listItems, skipDeletes)],
    [blocks, () => replaceInsertEntityCore(adapter, BLOCKS_ENTITY, note.path, blocks, skipDeletes)],
  ];

  for (const [value, replace] of replacements) {
    if (value !== undefined) replace();
  }

  replaceUserViewsCore(adapter, note.path, userViews, skipDeletes, logger);
  handlers.replaceUserFunctions(note.path, userFunctions, skipDeletes);
  handlers.replaceUserTriggers(note.path, userTriggers, skipDeletes);
}

export function replaceEntityCore<TInput, TRow extends Record<string, SqlParam>>(
  adapter: IndexingDbAdapter,
  entity: EntityDescriptor<TInput, TRow>,
  path: string,
  items: TInput[] | undefined,
  skipDeletes: boolean
): void {
  if (!items?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(entity.deleteByPathSql, [path]);
    }
    return;
  }

  const existing = execRows(adapter, entity.selectSql, [path], row => mapEntityRow(entity, row));
  const file = items.map(entity.normalize);

  const changes = detectEntityChanges(entity, file, existing);

  if (!skipDeletes && changes.deleted.length > 0) {
    adapter.batchDeleteByIds(entity.table, changes.deleted);
  }

  for (const { id, old, new: row } of changes.updated) {
    const plan = entityUpdatePlan(entity, old, row);
    adapter.run(plan.sql, [...plan.params, id]);
  }

  if (changes.inserted.length > 0) {
    adapter.runMultiRowInsert(
      entity.insertBaseSql,
      entity.insertColumnCount,
      changes.inserted.map(row => entityInsertRow(entity, path, row))
    );
  }
}

function replaceInsertEntityCore<TInput, TRow extends Record<string, SqlParam>>(
  adapter: IndexingDbAdapter,
  entity: InsertEntityDescriptor<TInput, TRow>,
  path: string,
  items: TInput[] | undefined,
  skipDeletes: boolean
): void {
  if (!skipDeletes) {
    adapter.runPrepared(entity.deleteByPathSql, [path]);
  }
  if (items?.length) {
    adapter.runMultiRowInsert(
      entity.insertBaseSql,
      entity.insertColumnCount,
      items.map(item => entityInsertRow(entity, path, entity.normalize(item)))
    );
  }
}

export function replaceTasksCore(adapter: IndexingDbAdapter, path: string, tasks: IndexNoteData['tasks'], skipDeletes: boolean): void {
  replaceEntityCore(adapter, TASKS_ENTITY, path, tasks, skipDeletes);
}

export function replaceHeadingsCore(adapter: IndexingDbAdapter, path: string, headings: IndexNoteData['headings'], skipDeletes: boolean): void {
  replaceEntityCore(adapter, HEADINGS_ENTITY, path, headings, skipDeletes);
}

export function replaceListItemsCore(adapter: IndexingDbAdapter, path: string, listItems: IndexNoteData['listItems'], skipDeletes: boolean): void {
  replaceEntityCore(adapter, LIST_ITEMS_ENTITY, path, listItems, skipDeletes);
}

/** Input table data format from IndexNoteData */
type InputTableData = NonNullable<IndexNoteData['tables']>[0];

/** DB row format for existing tables */
interface TableDbRow {
  table_index: number;
  table_name: string | null;
  block_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  line_number: number | null;
}

function replaceTablesCore(adapter: IndexingDbAdapter, path: string, tables: IndexNoteData['tables'], skipDeletes: boolean): void {
  if (!tables?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(TABLES_SQL.DELETE_BY_PATH, [path]);
    }
    return;
  }

  const existingRows: TableDbRow[] = execRows(
    adapter,
    TABLES_SQL.SELECT,
    [path],
    row => ({
      table_index: row[0] as number,
      table_name: row[1] as string | null,
      block_id: row[2] as string | null,
      start_offset: row[3] as number | null,
      end_offset: row[4] as number | null,
      line_number: row[5] as number | null
    })
  );

  const sortedFileTables = [...tables].sort((a, b) => a.table_index - b.table_index);

  const existingCount = existingRows.length;
  const fileCount = sortedFileTables.length;

  // Deletes must run before updates/inserts to avoid table_index PK conflicts.
  const deleteIndices: number[] = [];
  const updates: Array<{ tableIndex: number; table: InputTableData }> = [];
  const inserts: InputTableData[] = [];

  for (let i = 0; i < Math.max(existingCount, fileCount); i++) {
    if (i < existingCount && i < fileCount) {
      const existingRow = existingRows[i];
      const fileTable = sortedFileTables[i];
      const newStart = fileTable.start_offset ?? null;
      const newEnd = fileTable.end_offset ?? null;

      const hasChanged = existingRow.table_index !== fileTable.table_index ||
                        existingRow.table_name !== (fileTable.table_name || null) ||
                        existingRow.block_id !== (fileTable.block_id || null) ||
                        existingRow.start_offset !== newStart ||
                        existingRow.end_offset !== newEnd ||
                        existingRow.line_number !== fileTable.line_number;

      if (hasChanged) {
        updates.push({ tableIndex: existingRow.table_index, table: fileTable });
      }
    } else if (i >= existingCount) {
      inserts.push(sortedFileTables[i]);
    } else {
      if (!skipDeletes) {
        deleteIndices.push(existingRows[i].table_index);
      }
    }
  }

  if (deleteIndices.length > 0) {
    const placeholders = deleteIndices.map(() => '?').join(',');
    adapter.run(`${TABLES_SQL.DELETE_BY_INDEX_IN}(${placeholders})`, [path, ...deleteIndices]);
  }

  for (const { tableIndex, table } of updates) {
    adapter.run(
      TABLES_SQL.UPDATE,
      [
        table.table_index,
        table.table_name || null,
        table.block_id || null,
        table.start_offset ?? null,
        table.end_offset ?? null,
        table.line_number,
        path,
        tableIndex
      ]
    );
  }

  if (inserts.length > 0) {
    const rows = inserts.map(table => [
      path,
      table.table_index,
      table.table_name || null,
      table.block_id || null,
      table.start_offset ?? null,
      table.end_offset ?? null,
      table.line_number
    ]);
    adapter.runMultiRowInsert(TABLES_SQL.INSERT_BASE, TABLES_SQL.INSERT_COLUMNS, rows);
  }
}

/** Result of property replacement for caller to handle deletes */
interface ReplacePropertiesResult {
  existing: PropertyData[];
  changes: PropertyChanges;
}

/**
 * Returns changes so callers can handle deletes with DatabaseService-specific
 * auto-sync and trigger protections.
 */
export function replacePropertiesCore(adapter: IndexingDbAdapter, path: string, propertiesData: InputPropertyData[] | undefined, skipDeletes: boolean): ReplacePropertiesResult | null {
  if (!propertiesData?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(INDEXING_SQL.DELETE_PROPERTIES, [path]);
    }
    return null;
  }

  const existing: PropertyData[] = execRows(
    adapter,
    INDEXING_SQL.SELECT_PROPERTIES_FOR_PATH,
    [path],
    row => ({
      key: row[0] as string,
      value: row[1] as string,
      value_type: row[2] as string,
      array_index: row[3] as number | null
    })
  );

  const file: PropertyData[] = propertiesData.map(p => ({
    key: p.key,
    value: p.value,
    value_type: p.valueType,
    array_index: p.arrayIndex
  }));

  const changes = detectPropertyChanges(file, existing);

  for (const { id, new: prop } of changes.updated) {
    adapter.run(
      INDEXING_SQL.UPDATE_PROPERTY_BY_KEY,
      [prop.key, prop.value, prop.value_type, prop.array_index, path, id.key, id.array_index ?? -1]
    );
  }

  for (const prop of changes.inserted) {
    try {
      adapter.runPrepared(INDEXING_SQL.INSERT_PROPERTY, propertyToParams(path, {
        key: prop.key,
        value: prop.value,
        valueType: prop.value_type,
        arrayIndex: prop.array_index
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE constraint failed: properties/.test(message)) {
        throw error;
      }
    }
  }

  // Worker mode handles deletes here; main-thread callers can override delete handling.
  if (!skipDeletes && changes.deleted.length > 0) {
    for (const id of changes.deleted) {
      adapter.run(
        INDEXING_SQL.DELETE_PROPERTY_BY_KEY,
        [path, id.key, id.array_index ?? -1]
      );
    }
  }

  return { existing, changes };
}

interface UserEntityKind<T> {
  label: string;
  deleteForPathSql: string;
  dropStep?: {
    selectForPathSql: string;
    dropExisting(name: string): void;
  };
  reinsert(items: T[]): void;
}

function replaceUserEntitiesCore<T>(adapter: IndexingDbAdapter, path: string, items: T[] | undefined, skipDeletes: boolean, kind: UserEntityKind<T>, logger: IndexingLogger): void {
  if (items === undefined) {
    return;
  }

  if (!skipDeletes) {
    const existingNames = kind.dropStep
      ? adapter.exec(kind.dropStep.selectForPathSql, [path])[0]?.values?.map(row => row[0] as string) ?? []
      : [];
    adapter.runPrepared(kind.deleteForPathSql, [path]);

    for (const name of existingNames) {
      try {
        kind.dropStep?.dropExisting(name);
      } catch (error) {
        logger.debug(`Failed to drop ${kind.label} "${name}"`, error);
      }
    }
  }

  if (items.length > 0) {
    kind.reinsert(items);
  }
}

function replaceUserViewsCore(adapter: IndexingDbAdapter, path: string, userViews: UserViewData[] | undefined, skipDeletes: boolean, logger: IndexingLogger): void {
  replaceUserEntitiesCore(adapter, path, userViews, skipDeletes, {
    label: 'view',
    deleteForPathSql: INDEXING_SQL.DELETE_USER_VIEWS,
    dropStep: {
      selectForPathSql: INDEXING_SQL.SELECT_USER_VIEWS_FOR_PATH,
      dropExisting: (viewName) => adapter.run(`DROP VIEW IF EXISTS "${viewName}"`, []),
    },
    reinsert: (views) => {
      for (const view of views) {
        const sqlHash = hashString(view.sql);
        adapter.runPrepared(INDEXING_SQL.INSERT_USER_VIEW, userViewToParams(path, view, sqlHash));
      }

      for (const { view_name: viewName, sql } of views) {
        try {
          adapter.run(`DROP VIEW IF EXISTS "${viewName}"`, []);
          adapter.run(sql, []);
        } catch (error) {
          logger.error(`Failed to create view "${viewName}"`, error);
        }
      }
    },
  }, logger);
}

type RegisterFunctionHook = (name: string, source: string) => void;

export function replaceUserFunctionsCore(adapter: IndexingDbAdapter, path: string, userFunctions: UserFunctionData[] | undefined, skipDeletes: boolean, registerFunction: RegisterFunctionHook, logger: IndexingLogger): void {
  replaceUserEntitiesCore(adapter, path, userFunctions, skipDeletes, {
    label: 'function',
    deleteForPathSql: INDEXING_SQL.DELETE_USER_FUNCTIONS,
    reinsert: (functions) => {
      for (const func of functions) {
        const sourceHash = hashString(func.source);
        adapter.runPrepared(INDEXING_SQL.INSERT_USER_FUNCTION, userFunctionToParams(path, func, sourceHash));
      }

      for (const { function_name, source } of functions) {
        try {
          registerFunction(function_name, source);
        } catch (error) {
          logger.error(`Failed to register function "${function_name}"`, error);
        }
      }
    },
  }, logger);
}

type ActivateTriggerHook = (triggerName: string, triggerSql: string, path: string) => void;

export function replaceUserTriggersCore(adapter: IndexingDbAdapter, path: string, userTriggers: UserTriggerData[] | undefined, skipDeletes: boolean, activateTrigger: ActivateTriggerHook | null, logger: IndexingLogger): void {
  replaceUserEntitiesCore(adapter, path, userTriggers, skipDeletes, {
    label: 'trigger',
    deleteForPathSql: INDEXING_SQL.DELETE_USER_TRIGGERS,
    dropStep: {
      selectForPathSql: INDEXING_SQL.SELECT_USER_TRIGGERS_FOR_PATH,
      dropExisting: (triggerName) => adapter.run(`DROP TRIGGER IF EXISTS "_vq_user_${triggerName}"`, []),
    },
    reinsert: (triggers) => {
      for (const trigger of triggers) {
        const sqlHash = hashString(trigger.trigger_sql);
        adapter.runPrepared(INDEXING_SQL.INSERT_USER_TRIGGER, userTriggerToParams(path, trigger, sqlHash));

        if (activateTrigger) {
          try {
            activateTrigger(trigger.trigger_name, trigger.trigger_sql, path);
          } catch (error) {
            logger.warn(`Failed to activate trigger "${trigger.trigger_name}" during indexing`, error);
          }
        }
      }
    },
  }, logger);
}
