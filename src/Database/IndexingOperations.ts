/**
 * Shared indexing operations for DatabaseService and database.worker.
 * Uses adapter pattern to abstract away database access differences.
 */

import {
  INDEXING_SQL,
  tagsToRows,
  linksToRows,
  tableCellsToRows,
  tasksToRows,
  headingsToRows,
  listItemsToRows,
  propertyToParams,
  userViewToParams,
  userFunctionToParams,
  userTriggerToParams,
  type InputPropertyData,
} from './IndexingQueries';
import { hashString } from '../utils/StringUtils';
import {
  detectTagChanges,
  detectLinkChanges,
  detectTableCellChanges,
  detectTaskChanges,
  detectHeadingChanges,
  detectListItemChanges,
  detectPropertyChanges,
  toDbTableCell,
  toDbTask,
  toDbHeading,
  toDbListItem,
  parseTaskRows,
  parseListItemRows,
  TASK_SELECT_COLUMNS,
  LIST_ITEM_SELECT_COLUMNS,
  type TagData,
  type TagRow,
  type LinkData,
  type LinkRow,
  type DbTableCellData,
  type TableCellRow,
  type DbTaskData,
  type DbListItemData,
  type HeadingData,
  type HeadingRow,
  type InputHeadingData,
  type PropertyData,
  type PropertyChanges,
  type SqlResult,
} from './ChangeDetection';
import type {
  TableCellData as InputTableCellData,
  IndexNoteData,
  TaskData,
  ListItemData,
  UserViewData,
  UserFunctionData,
  UserTriggerData,
} from '../types';

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

interface IndexingOperationHandlers {
  insertNote(note: IndexNoteData['note']): void;
  replaceProperties(path: string, frontmatterData: IndexNoteData['frontmatterData'], skipDeletes: boolean): void;
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
export function performIndexingOperationsCore(adapter: IndexingDbAdapter, data: IndexNoteData, skipDeletes: boolean, handlers: IndexingOperationHandlers, logger: IndexingLogger): void {
  const { note, frontmatterData, tables, tableCells, tasks, headings, links, tags, listItems, userViews, userFunctions, userTriggers } = data;

  handlers.insertNote(note);

  const replacements: Array<[unknown[] | undefined, () => void]> = [
    [frontmatterData, () => handlers.replaceProperties(note.path, frontmatterData, skipDeletes)],
    [tables, () => replaceTablesCore(adapter, note.path, tables, skipDeletes)],
    [tableCells, () => replaceTableCellsCore(adapter, note.path, tableCells, skipDeletes)],
    [tasks, () => handlers.replaceTasks(note.path, tasks, skipDeletes)],
    [headings, () => handlers.replaceHeadings(note.path, headings, skipDeletes)],
    [links, () => replaceLinksCore(adapter, note.path, links, skipDeletes)],
    [tags, () => replaceTagsCore(adapter, note.path, tags, skipDeletes)],
    [listItems, () => handlers.replaceListItems(note.path, listItems, skipDeletes)],
  ];

  for (const [value, replace] of replacements) {
    if (value !== undefined) replace();
  }

  replaceUserViewsCore(adapter, note.path, userViews, skipDeletes, logger);
  handlers.replaceUserFunctions(note.path, userFunctions, skipDeletes);
  handlers.replaceUserTriggers(note.path, userTriggers, skipDeletes);
}

function replaceTagsCore(adapter: IndexingDbAdapter, path: string, tags: TagData[] | undefined, skipDeletes: boolean): void {
  if (!tags?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(INDEXING_SQL.DELETE_TAGS, [path]);
    }
    return;
  }

  const existing: TagRow[] = [];
  const result = adapter.exec(
    'SELECT id, tag_name, line_number FROM tags WHERE path = ?',
    [path]
  );
  if (result.length > 0 && result[0].values) {
    for (const row of result[0].values) {
      existing.push({
        id: row[0] as number,
        tag_name: row[1] as string,
        line_number: row[2] as number
      });
    }
  }

  const changes = detectTagChanges(tags, existing);

  if (!skipDeletes && changes.deleted.length > 0) {
    adapter.batchDeleteByIds('tags', changes.deleted);
  }

  for (const { id, new: tag } of changes.updated) {
    adapter.run('UPDATE tags SET line_number = ? WHERE id = ?', [tag.line_number, id]);
  }

  if (changes.inserted.length > 0) {
    adapter.runMultiRowInsert(
      INDEXING_SQL.INSERT_TAGS_BASE,
      INDEXING_SQL.TAGS_COLUMNS,
      tagsToRows(path, changes.inserted)
    );
  }
}

function replaceLinksCore(adapter: IndexingDbAdapter, path: string, links: LinkData[] | undefined, skipDeletes: boolean): void {
  if (!links?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(INDEXING_SQL.DELETE_LINKS, [path]);
    }
    return;
  }

  const existing: LinkRow[] = [];
  const result = adapter.exec(
    'SELECT id, link_text, link_target, link_target_path, link_type, line_number FROM links WHERE path = ?',
    [path]
  );
  if (result.length > 0 && result[0].values) {
    for (const row of result[0].values) {
      existing.push({
        id: row[0] as number,
        link_text: row[1] as string,
        link_target: row[2] as string,
        link_target_path: row[3] as string | null,
        link_type: row[4] as string,
        line_number: row[5] as number,
      });
    }
  }

  const changes = detectLinkChanges(links, existing);

  if (!skipDeletes && changes.deleted.length > 0) {
    adapter.batchDeleteByIds('links', changes.deleted);
  }

  for (const { id, new: link } of changes.updated) {
    adapter.run(
      'UPDATE links SET link_text = ?, link_target = ?, link_target_path = ?, link_type = ?, line_number = ? WHERE id = ?',
      [link.link_text, link.link_target, link.link_target_path, link.link_type, link.line_number, id]
    );
  }

  if (changes.inserted.length > 0) {
    adapter.runMultiRowInsert(
      INDEXING_SQL.INSERT_LINKS_BASE,
      INDEXING_SQL.LINKS_COLUMNS,
      linksToRows(path, changes.inserted)
    );
  }
}

function replaceTableCellsCore(adapter: IndexingDbAdapter, path: string, tableCells: InputTableCellData[] | undefined, skipDeletes: boolean): void {
  if (!tableCells?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(INDEXING_SQL.DELETE_TABLE_CELLS, [path]);
    }
    return;
  }

  const existing: TableCellRow[] = [];
  const result = adapter.exec(
    'SELECT id, table_index, table_name, row_index, column_name, cell_value, line_number FROM table_cells WHERE path = ?',
    [path]
  );
  if (result.length > 0 && result[0].values) {
    for (const row of result[0].values) {
      existing.push({
        id: row[0] as number,
        table_index: row[1] as number,
        table_name: row[2] as string | null,
        row_index: row[3] as number,
        column_name: row[4] as string,
        cell_value: row[5] as string,
        line_number: row[6] as number | null
      });
    }
  }

  const file: DbTableCellData[] = tableCells.map(toDbTableCell);

  const changes = detectTableCellChanges(file, existing);

  if (!skipDeletes && changes.deleted.length > 0) {
    adapter.batchDeleteByIds('table_cells', changes.deleted);
  }

  for (const { id, old, new: cell } of changes.updated) {
    const contentChanged = old.table_name !== cell.table_name || old.cell_value !== cell.cell_value;
    if (contentChanged) {
      adapter.run(
        'UPDATE table_cells SET table_name = ?, cell_value = ?, line_number = ? WHERE id = ?',
        [cell.table_name, cell.cell_value, cell.line_number, id]
      );
    } else {
      adapter.run('UPDATE table_cells SET line_number = ? WHERE id = ?', [cell.line_number, id]);
    }
  }

  if (changes.inserted.length > 0) {
    adapter.runMultiRowInsert(
      INDEXING_SQL.INSERT_TABLE_CELLS_BASE,
      INDEXING_SQL.TABLE_CELLS_COLUMNS,
      tableCellsToRows(path, changes.inserted)
    );
  }
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

/** Uses position-based matching by table_index. */
function replaceTablesCore(adapter: IndexingDbAdapter, path: string, tables: IndexNoteData['tables'], skipDeletes: boolean): void {
  if (!tables?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(INDEXING_SQL.DELETE_TABLES, [path]);
    }
    return;
  }

  const existing = adapter.exec(
    'SELECT table_index, table_name, block_id, start_offset, end_offset, line_number FROM tables WHERE path = ? ORDER BY table_index',
    [path]
  );

  const existingRows: TableDbRow[] = [];
  if (existing.length > 0 && existing[0].values) {
    for (const row of existing[0].values) {
      existingRows.push({
        table_index: row[0] as number,
        table_name: row[1] as string | null,
        block_id: row[2] as string | null,
        start_offset: row[3] as number | null,
        end_offset: row[4] as number | null,
        line_number: row[5] as number | null
      });
    }
  }

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
    adapter.run(`DELETE FROM tables WHERE path = ? AND table_index IN (${placeholders})`, [path, ...deleteIndices]);
  }

  for (const { tableIndex, table } of updates) {
    adapter.run(
      'UPDATE tables SET table_index = ?, table_name = ?, block_id = ?, start_offset = ?, end_offset = ?, line_number = ? WHERE path = ? AND table_index = ?',
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
    adapter.runMultiRowInsert(INDEXING_SQL.INSERT_TABLES_BASE, INDEXING_SQL.TABLES_COLUMNS, rows);
  }
}

/** Auto-sync logic is handled by DatabaseService, not this shared function. */
export function replaceTasksCore(adapter: IndexingDbAdapter, path: string, tasks: TaskData[] | undefined, skipDeletes: boolean): void {
  if (!tasks?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(INDEXING_SQL.DELETE_TASKS, [path]);
    }
    return;
  }

  const result = adapter.exec(`SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE path = ?`, [path]);
  const existing = parseTaskRows(result);
  const file = tasks.map(toDbTask);

  const changes = detectTaskChanges(file, existing);

  if (!skipDeletes && changes.deleted.length > 0) {
    adapter.batchDeleteByIds('tasks', changes.deleted);
  }

  for (const { id, new: task } of changes.updated) {
    adapter.run(INDEXING_SQL.UPDATE_TASK, [
      task.task_text,
      task.status,
      task.priority,
      task.due_date,
      task.scheduled_date,
      task.start_date,
      task.created_date,
      task.done_date,
      task.cancelled_date,
      task.recurrence,
      task.on_completion,
      task.task_id,
      task.depends_on,
      task.tags,
      task.line_number,
      task.block_id,
      task.start_offset,
      task.end_offset,
      task.anchor_hash,
      task.section_heading,
      id
    ]);
  }

  if (changes.inserted.length > 0) {
    const tasksData = changes.inserted.map((task: DbTaskData) => ({
      task_text: task.task_text,
      status: task.status,
      priority: task.priority ?? undefined,
      due_date: task.due_date ?? undefined,
      scheduled_date: task.scheduled_date ?? undefined,
      start_date: task.start_date ?? undefined,
      created_date: task.created_date ?? undefined,
      done_date: task.done_date ?? undefined,
      cancelled_date: task.cancelled_date ?? undefined,
      recurrence: task.recurrence ?? undefined,
      on_completion: task.on_completion ?? undefined,
      task_id: task.task_id ?? undefined,
      depends_on: task.depends_on ?? undefined,
      tags: task.tags ?? undefined,
      line_number: task.line_number,
      block_id: task.block_id ?? undefined,
      anchor_hash: task.anchor_hash ?? undefined,
      start_offset: task.start_offset ?? undefined,
      end_offset: task.end_offset ?? undefined,
      section_heading: task.section_heading ?? undefined
    }));
    adapter.runMultiRowInsert(INDEXING_SQL.INSERT_TASKS_BASE, INDEXING_SQL.TASKS_COLUMNS, tasksToRows(path, tasksData));
  }
}

/** Auto-sync logic is handled by DatabaseService, not this shared function. */
export function replaceHeadingsCore(adapter: IndexingDbAdapter, path: string, headings: InputHeadingData[] | undefined, skipDeletes: boolean): void {
  if (!headings?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(INDEXING_SQL.DELETE_HEADINGS, [path]);
    }
    return;
  }

  const existing: HeadingRow[] = [];
  const result = adapter.exec(
    'SELECT id, level, heading_text, line_number, block_id, anchor_hash, start_offset, end_offset FROM headings WHERE path = ?',
    [path]
  );
  if (result.length > 0 && result[0].values) {
    for (const row of result[0].values) {
      existing.push({
        id: row[0] as number,
        level: row[1] as number,
        heading_text: row[2] as string,
        line_number: row[3] as number,
        block_id: row[4] as string | null,
        anchor_hash: row[5] as string | null,
        start_offset: row[6] as number | null,
        end_offset: row[7] as number | null
      });
    }
  }

  const file: HeadingData[] = headings.map(toDbHeading);

  const changes = detectHeadingChanges(file, existing);

  if (!skipDeletes && changes.deleted.length > 0) {
    adapter.batchDeleteByIds('headings', changes.deleted);
  }

  for (const { id, new: heading } of changes.updated) {
    adapter.run(INDEXING_SQL.UPDATE_HEADING, [
      heading.level,
      heading.heading_text,
      heading.line_number,
      heading.block_id,
      heading.start_offset,
      heading.end_offset,
      heading.anchor_hash,
      id
    ]);
  }

  if (changes.inserted.length > 0) {
    const headingsData = changes.inserted.map(heading => ({
      level: heading.level,
      heading_text: heading.heading_text,
      line_number: heading.line_number,
      block_id: heading.block_id ?? undefined,
      anchor_hash: heading.anchor_hash ?? undefined,
      start_offset: heading.start_offset ?? undefined,
      end_offset: heading.end_offset ?? undefined
    }));
    adapter.runMultiRowInsert(INDEXING_SQL.INSERT_HEADINGS_BASE, INDEXING_SQL.HEADINGS_COLUMNS, headingsToRows(path, headingsData));
  }
}

/** Auto-sync logic is handled by DatabaseService, not this shared function. */
export function replaceListItemsCore(adapter: IndexingDbAdapter, path: string, listItems: ListItemData[] | undefined, skipDeletes: boolean): void {
  if (!listItems?.length) {
    if (!skipDeletes) {
      adapter.runPrepared(INDEXING_SQL.DELETE_LIST_ITEMS, [path]);
    }
    return;
  }

  const result = adapter.exec(`SELECT ${LIST_ITEM_SELECT_COLUMNS} FROM list_items WHERE path = ?`, [path]);
  const existing = parseListItemRows(result);
  const file = listItems.map(toDbListItem);

  const changes = detectListItemChanges(file, existing);

  if (!skipDeletes && changes.deleted.length > 0) {
    adapter.batchDeleteByIds('list_items', changes.deleted);
  }

  for (const { id, new: item } of changes.updated) {
    adapter.run(INDEXING_SQL.UPDATE_LIST_ITEM, [
      item.list_index,
      item.item_index,
      item.parent_index,
      item.content,
      item.list_type,
      item.indent_level,
      item.line_number,
      item.block_id,
      item.anchor_hash,
      item.start_offset,
      item.end_offset,
      id
    ]);
  }

  if (changes.inserted.length > 0) {
    const listItemsData = changes.inserted.map((item: DbListItemData) => ({
      list_index: item.list_index,
      item_index: item.item_index,
      parent_index: item.parent_index,
      content: item.content,
      list_type: item.list_type,
      indent_level: item.indent_level,
      line_number: item.line_number,
      block_id: item.block_id ?? undefined,
      anchor_hash: item.anchor_hash ?? undefined,
      start_offset: item.start_offset ?? undefined,
      end_offset: item.end_offset ?? undefined
    }));
    adapter.runMultiRowInsert(INDEXING_SQL.INSERT_LIST_ITEMS_BASE, INDEXING_SQL.LIST_ITEMS_COLUMNS, listItemsToRows(path, listItemsData));
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

  const existing: PropertyData[] = [];
  const result = adapter.exec(
    'SELECT key, value, value_type, array_index FROM properties WHERE path = ?',
    [path]
  );
  if (result.length > 0 && result[0].values) {
    for (const row of result[0].values) {
      existing.push({
        key: row[0] as string,
        value: row[1] as string,
        value_type: row[2] as string,
        array_index: row[3] as number | null
      });
    }
  }

  const file: PropertyData[] = propertiesData.map(p => ({
    key: p.key,
    value: p.value,
    value_type: p.valueType,
    array_index: p.arrayIndex
  }));

  const changes = detectPropertyChanges(file, existing);

  for (const { id, new: prop } of changes.updated) {
    adapter.run(
      'UPDATE properties SET key = ?, value = ?, value_type = ?, array_index = ? WHERE path = ? AND key = ? AND COALESCE(array_index, -1) = ?',
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
    } catch {
      // Silently skip duplicate property inserts
    }
  }

  // Worker mode handles deletes here; main-thread callers can override delete handling.
  if (!skipDeletes && changes.deleted.length > 0) {
    for (const id of changes.deleted) {
      adapter.run(
        'DELETE FROM properties WHERE path = ? AND key = ? AND COALESCE(array_index, -1) = ?',
        [path, id.key, id.array_index ?? -1]
      );
    }
  }

  return { existing, changes };
}

function getViewsForPathCore(adapter: IndexingDbAdapter, path: string, logger: IndexingLogger): string[] {
  try {
    const results = adapter.exec(INDEXING_SQL.SELECT_USER_VIEWS_FOR_PATH, [path]);
    return results[0]?.values?.map(row => row[0] as string) ?? [];
  } catch (error) {
    logger.error(`Failed to load views for "${path}"`, error);
    throw error;
  }
}

function replaceUserViewsCore(adapter: IndexingDbAdapter, path: string, userViews: UserViewData[] | undefined, skipDeletes: boolean, logger: IndexingLogger): void {
  if (userViews === undefined) {
    return;
  }

  if (!skipDeletes) {
    const existingViews = getViewsForPathCore(adapter, path, logger);
    adapter.runPrepared(INDEXING_SQL.DELETE_USER_VIEWS, [path]);

    for (const viewName of existingViews) {
      try {
        adapter.run(`DROP VIEW IF EXISTS "${viewName}"`, []);
      } catch (error) {
        logger.debug(`Failed to drop view "${viewName}"`, error);
      }
    }
  }

  if (userViews.length > 0) {
    for (const view of userViews) {
      const sqlHash = hashString(view.sql);
      adapter.runPrepared(INDEXING_SQL.INSERT_USER_VIEW, userViewToParams(path, view, sqlHash));
    }

    for (const { view_name: viewName, sql } of userViews) {
      try {
        adapter.run(`DROP VIEW IF EXISTS "${viewName}"`, []);
        adapter.run(sql, []);
      } catch (error) {
        logger.error(`Failed to create view "${viewName}"`, error);
      }
    }
  }
}

type RegisterFunctionHook = (name: string, source: string) => void;

export function replaceUserFunctionsCore(adapter: IndexingDbAdapter, path: string, userFunctions: UserFunctionData[] | undefined, skipDeletes: boolean, registerFunction: RegisterFunctionHook, logger: IndexingLogger): void {
  if (!skipDeletes) {
    adapter.runPrepared(INDEXING_SQL.DELETE_USER_FUNCTIONS, [path]);
  }

  if (userFunctions?.length) {
    for (const func of userFunctions) {
      const sourceHash = hashString(func.source);
      adapter.runPrepared(INDEXING_SQL.INSERT_USER_FUNCTION, userFunctionToParams(path, func, sourceHash));
    }

    for (const { function_name, source } of userFunctions) {
      try {
        registerFunction(function_name, source);
      } catch (error) {
        logger.error(`Failed to register function "${function_name}"`, error);
      }
    }
  }
}

function getTriggersForPathCore(adapter: IndexingDbAdapter, path: string, logger: IndexingLogger): string[] {
  try {
    const results = adapter.exec(INDEXING_SQL.SELECT_USER_TRIGGERS_FOR_PATH, [path]);
    return results[0]?.values?.map(row => row[0] as string) ?? [];
  } catch (error) {
    logger.error(`Failed to load triggers for "${path}"`, error);
    throw error;
  }
}

type ActivateTriggerHook = (triggerName: string, triggerSql: string, path: string) => void;

export function replaceUserTriggersCore(adapter: IndexingDbAdapter, path: string, userTriggers: UserTriggerData[] | undefined, skipDeletes: boolean, activateTrigger: ActivateTriggerHook | null, logger: IndexingLogger): void {
  if (userTriggers === undefined) {
    return;
  }

  if (!skipDeletes) {
    const existingTriggers = getTriggersForPathCore(adapter, path, logger);
    adapter.runPrepared(INDEXING_SQL.DELETE_USER_TRIGGERS, [path]);

    for (const triggerName of existingTriggers) {
      try {
        adapter.run(`DROP TRIGGER IF EXISTS "_vq_user_${triggerName}"`, []);
      } catch (error) {
        logger.debug(`Failed to drop trigger "${triggerName}"`, error);
      }
    }
  }

  if (userTriggers?.length) {
    for (const trigger of userTriggers) {
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
  }
}
