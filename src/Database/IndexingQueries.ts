/**
 * Shared SQL queries and row transformation functions for indexing operations.
 * Used by both DatabaseService (main thread) and database.worker.ts (web worker).
 */

import type { NoteRecord, TaskData, ListItemData, UserViewData, UserFunctionData, UserTriggerData } from '../types';
import type { TagData, LinkData, InputHeadingData, DbTableCellData } from './ChangeDetection';

export const INDEXING_SQL = {
  // Notes - Use separate INSERT/UPDATE to allow AFTER UPDATE triggers to modify the row
  // UPSERT (ON CONFLICT DO UPDATE) conflicts with triggers that UPDATE the same row
  CHECK_NOTE_EXISTS: 'SELECT 1 FROM notes WHERE path = ? LIMIT 1',
  INSERT_NOTE: 'INSERT INTO notes (path, title, content, created, modified, size) VALUES (?, ?, ?, ?, ?, ?)',
  UPDATE_NOTE: `UPDATE notes SET
      title = ?,
      content = ?,
      created = ?,
      modified = ?,
      size = ?
    WHERE path = ?`,
  DELETE_NOTE: 'DELETE FROM notes WHERE path = ?',

  // Properties - Use separate INSERT/UPDATE for proper trigger semantics
  INSERT_PROPERTY: 'INSERT INTO properties (path, key, value, value_type, array_index) VALUES (?, ?, ?, ?, ?)',
  UPDATE_PROPERTY: 'UPDATE properties SET value = ?, value_type = ? WHERE path = ? AND key = ? AND COALESCE(array_index, -1) = COALESCE(?, -1)',
  DELETE_PROPERTIES: 'DELETE FROM properties WHERE path = ?',
  DELETE_STALE_PROPERTIES: 'DELETE FROM properties WHERE path = ? AND (key, COALESCE(array_index, -1)) NOT IN ',

  INSERT_TABLE_CELLS_BASE: 'INSERT INTO table_cells (path, table_index, table_name, row_index, column_name, cell_value, value_type, line_number) VALUES ',
  DELETE_TABLE_CELLS: 'DELETE FROM table_cells WHERE path = ?',
  TABLE_CELLS_COLUMNS: 8,

  INSERT_TABLES_BASE: 'INSERT INTO tables (path, table_index, table_name, block_id, start_offset, end_offset, line_number) VALUES ',
  DELETE_TABLES: 'DELETE FROM tables WHERE path = ?',
  TABLES_COLUMNS: 7,

  INSERT_LINKS_BASE: 'INSERT INTO links (path, link_text, link_target, link_target_path, link_type, line_number) VALUES ',
  DELETE_LINKS: 'DELETE FROM links WHERE path = ?',
  LINKS_COLUMNS: 6,

  INSERT_TAGS_BASE: 'INSERT INTO tags (path, tag_name, line_number) VALUES ',
  DELETE_TAGS: 'DELETE FROM tags WHERE path = ?',
  TAGS_COLUMNS: 3,

  INSERT_TASKS_BASE: 'INSERT INTO tasks (path, task_text, status, priority, due_date, scheduled_date, start_date, created_date, done_date, cancelled_date, recurrence, on_completion, task_id, depends_on, tags, line_number, block_id, start_offset, end_offset, anchor_hash, section_heading) VALUES ',
  UPDATE_TASK: `UPDATE tasks SET task_text = ?, status = ?, priority = ?, due_date = ?, scheduled_date = ?,
    start_date = ?, created_date = ?, done_date = ?, cancelled_date = ?, recurrence = ?,
    on_completion = ?, task_id = ?, depends_on = ?, tags = ?, line_number = ?, block_id = ?,
    start_offset = ?, end_offset = ?, anchor_hash = ?, section_heading = ? WHERE id = ?`,
  DELETE_TASKS: 'DELETE FROM tasks WHERE path = ?',
  TASKS_COLUMNS: 21,

  INSERT_HEADINGS_BASE: 'INSERT INTO headings (path, level, heading_text, line_number, block_id, start_offset, end_offset, anchor_hash) VALUES ',
  UPDATE_HEADING: 'UPDATE headings SET level = ?, heading_text = ?, line_number = ?, block_id = ?, start_offset = ?, end_offset = ?, anchor_hash = ? WHERE id = ?',
  DELETE_HEADINGS: 'DELETE FROM headings WHERE path = ?',
  HEADINGS_COLUMNS: 8,

  INSERT_LIST_ITEMS_BASE: 'INSERT INTO list_items (path, list_index, item_index, parent_index, content, list_type, indent_level, line_number, block_id, start_offset, end_offset, anchor_hash) VALUES ',
  UPDATE_LIST_ITEM: `UPDATE list_items SET list_index = ?, item_index = ?, parent_index = ?, content = ?,
    list_type = ?, indent_level = ?, line_number = ?, block_id = ?, anchor_hash = ?,
    start_offset = ?, end_offset = ? WHERE id = ?`,
  DELETE_LIST_ITEMS: 'DELETE FROM list_items WHERE path = ?',
  LIST_ITEMS_COLUMNS: 12,

  INSERT_USER_VIEW: 'INSERT OR REPLACE INTO _user_views (view_name, path, sql, sql_hash) VALUES (?, ?, ?, ?)',
  DELETE_USER_VIEWS: 'DELETE FROM _user_views WHERE path = ?',
  SELECT_USER_VIEWS_FOR_PATH: 'SELECT view_name FROM _user_views WHERE path = ?',
  SELECT_VIEW_HASH: 'SELECT sql_hash FROM _user_views WHERE view_name = ?',

  INSERT_USER_FUNCTION: 'INSERT OR REPLACE INTO _user_functions (function_name, path, source, source_hash) VALUES (?, ?, ?, ?)',
  DELETE_USER_FUNCTIONS: 'DELETE FROM _user_functions WHERE path = ?',
  SELECT_FUNCTION_HASH: 'SELECT source_hash FROM _user_functions WHERE function_name = ?',

  // User triggers - uses trigger_name as PRIMARY KEY (global, like views/functions)
  INSERT_USER_TRIGGER: 'INSERT OR REPLACE INTO _user_triggers (trigger_name, path, trigger_sql, sql_hash) VALUES (?, ?, ?, ?)',
  DELETE_USER_TRIGGERS: 'DELETE FROM _user_triggers WHERE path = ?',
  SELECT_USER_TRIGGERS_FOR_PATH: 'SELECT trigger_name FROM _user_triggers WHERE path = ?',
  SELECT_ALL_USER_TRIGGERS: 'SELECT trigger_name, path, trigger_sql, enabled FROM _user_triggers WHERE enabled = 1',
  SELECT_TRIGGER_HASH: 'SELECT sql_hash FROM _user_triggers WHERE trigger_name = ?',

  // Auto-sync queries (for detecting trigger modifications)
  SELECT_PROPERTIES_FOR_SYNC: 'SELECT key, array_index FROM properties WHERE path = ?',
  SELECT_PROPERTIES_VALUES_FOR_SYNC: 'SELECT key, value FROM properties WHERE path = ? AND array_index IS NULL',
  SELECT_TASKS_FOR_SYNC: 'SELECT line_number, status, task_text FROM tasks WHERE path = ?',
  SELECT_HEADINGS_FOR_SYNC: 'SELECT line_number, level, heading_text FROM headings WHERE path = ?',
  SELECT_LIST_ITEMS_FOR_SYNC: 'SELECT line_number, content FROM list_items WHERE path = ?',

  SELECT_ALL_USER_VIEWS: 'SELECT view_name, path, sql FROM _user_views',
  SELECT_ALL_USER_FUNCTIONS: 'SELECT function_name, path, source FROM _user_functions',
} as const;

export function noteToParams(note: NoteRecord): (string | number | null)[] {
  return [note.path, note.title, note.content, note.created, note.modified, note.size];
}

export function noteToUpdateParams(note: NoteRecord): (string | number | null)[] {
  return [note.title, note.content, note.created, note.modified, note.size, note.path];
}

/**
 * Input property data format (camelCase).
 * Different from ChangeDetection.PropertyData which uses snake_case for DB rows.
 */
export interface InputPropertyData {
  key: string;
  value: string;
  valueType: string;
  arrayIndex: number | null;
}

export function propertyToParams(path: string, property: InputPropertyData): (string | number | null)[] {
  return [path, property.key, property.value, property.valueType, property.arrayIndex];
}

export function linksToRows(path: string, links: LinkData[]): (string | number | null)[][] {
  return links.map(link => [
    path,
    link.link_text,
    link.link_target,
    link.link_target_path,
    link.link_type,
    link.line_number
  ]);
}

export function tagsToRows(path: string, tags: TagData[]): (string | number | null)[][] {
  return tags.map(tag => [path, tag.tag_name, tag.line_number]);
}

export function tableCellsToRows(path: string, cells: DbTableCellData[]): (string | number | null)[][] {
  return cells.map(cell => [
    path,
    cell.table_index,
    cell.table_name,
    cell.row_index,
    cell.column_name,
    cell.cell_value,
    TABLE_CELL_VALUE_TYPE,
    cell.line_number
  ]);
}

export function tasksToRows(path: string, tasks: TaskData[]): (string | number | null)[][] {
  return tasks.map(task => [
    path,
    task.task_text,
    task.status ?? DEFAULT_TASK_STATUS,
    task.priority ?? null,
    task.due_date ?? null,
    task.scheduled_date ?? null,
    task.start_date ?? null,
    task.created_date ?? null,
    task.done_date ?? null,
    task.cancelled_date ?? null,
    task.recurrence ?? null,
    task.on_completion ?? null,
    task.task_id ?? null,
    task.depends_on ?? null,
    task.tags ?? null,
    task.line_number,
    task.block_id ?? null,
    task.start_offset ?? null,
    task.end_offset ?? null,
    task.anchor_hash ?? null,
    task.section_heading ?? null
  ]);
}

export function headingsToRows(path: string, headings: InputHeadingData[]): (string | number | null)[][] {
  return headings.map(heading => [
    path,
    heading.level,
    heading.heading_text,
    heading.line_number,
    heading.block_id ?? null,
    heading.start_offset ?? null,
    heading.end_offset ?? null,
    heading.anchor_hash ?? null
  ]);
}

export function listItemsToRows(path: string, listItems: ListItemData[]): (string | number | null)[][] {
  return listItems.map(item => [
    path,
    item.list_index,
    item.item_index,
    item.parent_index,
    item.content,
    item.list_type,
    item.indent_level,
    item.line_number,
    item.block_id ?? null,
    item.start_offset ?? null,
    item.end_offset ?? null,
    item.anchor_hash ?? null
  ]);
}

export function userViewToParams(path: string, view: UserViewData, sqlHash: string): (string | number | null)[] {
  return [view.view_name, path, view.sql, sqlHash];
}

export function userFunctionToParams(path: string, func: UserFunctionData, sourceHash: string): (string | number | null)[] {
  return [func.function_name, path, func.source, sourceHash];
}

export function userTriggerToParams(path: string, trigger: UserTriggerData, sqlHash: string): (string | number | null)[] {
  return [trigger.trigger_name, path, trigger.trigger_sql, sqlHash];
}

export const PREPARED_STATEMENT_CACHE_LIMIT = 300;

/** Batch size for deleting rows by ID */
export const BATCH_DELETE_CHUNK_SIZE = 500;

/** Max rows per INSERT batch */
export const MAX_ROWS_PER_INSERT_BATCH = 100;

/** Default task status when not specified */
export const DEFAULT_TASK_STATUS = 'TODO';

/** Value type for table cells (always string) */
const TABLE_CELL_VALUE_TYPE = 'string';
