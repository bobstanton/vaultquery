/**
 * Shared SQL registry and parameter helpers for indexing operations.
 * Used by DatabaseService (main thread), database.worker.ts (web worker),
 * and IndexingService.
 *
 */

import type { NoteRecord, UserViewData, UserFunctionData, UserTriggerData } from '../types';

export const INDEXING_SQL = {
  // Notes - see insertNoteCore in IndexingOperations.ts for why these are
  // separate INSERT/UPDATE statements rather than an UPSERT.
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
  DELETE_ALL_NOTES: 'DELETE FROM notes',
  DELETE_NOTES_BY_PATH_IN: 'DELETE FROM notes WHERE path IN ',

  // Properties - Use separate INSERT/UPDATE for proper trigger semantics
  SELECT_PROPERTIES_FOR_PATH: 'SELECT key, value, value_type, array_index FROM properties WHERE path = ?',
  SELECT_NOTE_PROPERTY_KEYS: 'SELECT DISTINCT key FROM properties WHERE path = ? AND array_index IS NULL',
  INSERT_PROPERTY: 'INSERT INTO properties (path, key, value, value_type, array_index) VALUES (?, ?, ?, ?, ?)',
  UPDATE_PROPERTY_BY_KEY: 'UPDATE properties SET key = ?, value = ?, value_type = ?, array_index = ? WHERE path = ? AND key = ? AND COALESCE(array_index, -1) = ?',
  DELETE_PROPERTY_BY_KEY: 'DELETE FROM properties WHERE path = ? AND key = ? AND COALESCE(array_index, -1) = ?',
  DELETE_PROPERTIES: 'DELETE FROM properties WHERE path = ?',
  DELETE_STALE_PROPERTIES: 'DELETE FROM properties WHERE path = ? AND (key, COALESCE(array_index, -1)) NOT IN ',

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
