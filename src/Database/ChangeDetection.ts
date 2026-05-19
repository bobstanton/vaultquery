/**
 * Change Detection
 *
 * Generates minimal UPDATE/INSERT/DELETE operations with proper trigger semantics.
 */

import { DEFAULT_TASK_STATUS } from './IndexingQueries';
import type {
  TaskData as InputTaskData,
  ListItemData as InputListItemData,
  TableCellData as InputTableCellData,
  TaskMetadataFields,
} from '../types';

/** Input heading format from types.d.ts (inline in IndexNoteData) */
export interface InputHeadingData {
  level: number;
  heading_text: string;
  line_number: number;
  block_id?: string;
  start_offset?: number;
  end_offset?: number;
  anchor_hash?: string;
}

/**
 * Result of change detection. Same shape for all entity types.
 * - updated: Existing rows that need UPDATE (provides old + new for trigger WHEN clauses)
 * - inserted: New rows that need INSERT
 * - deleted: Row IDs that need DELETE
 */
interface Changes<TData, TId = number> {
  updated: Array<{ id: TId; old: TData; new: TData }>;
  inserted: TData[];
  deleted: TId[];
}

export interface TagData {
  tag_name: string;
  line_number: number;
}

export interface LinkData {
  link_text: string;
  link_target: string;
  link_target_path: string | null;
  link_type: string;
  line_number: number;
}

export interface HeadingData {
  level: number;
  heading_text: string;
  line_number: number;
  block_id: string | null;
  anchor_hash: string | null;
  start_offset: number | null;
  end_offset: number | null;
}

export interface PropertyData {
  key: string;
  value: string;
  value_type: string;
  array_index: number | null;
}

export interface DbTableCellData {
  table_index: number;
  table_name: string | null;
  row_index: number;
  column_name: string;
  cell_value: string;
  line_number: number | null;
}

/** Database record format for tasks. All nullable fields use `| null`. */
export interface DbTaskData extends TaskMetadataFields {
  task_text: string;
  status: string;
  line_number: number;
}

/** Database record format for list items. All nullable fields use `| null`. */
export interface DbListItemData {
  list_index: number;
  item_index: number;
  parent_index: number | null;
  content: string;
  list_type: 'bullet' | 'number';
  indent_level: number;
  line_number: number;
  block_id: string | null;
  anchor_hash: string | null;
  start_offset: number | null;
  end_offset: number | null;
}

export interface TagRow extends TagData { id: number }
export interface LinkRow extends LinkData { id: number }
export interface HeadingRow extends HeadingData { id: number }
export interface TableCellRow extends DbTableCellData { id: number }
interface TaskRow extends DbTaskData { id: number }
interface ListItemRow extends DbListItemData { id: number }

interface PropertyKey {
  key: string;
  array_index: number | null;
}

type TagChanges = Changes<TagData>;
type LinkChanges = Changes<LinkData>;
type HeadingChanges = Changes<HeadingData>;
type TableCellChanges = Changes<DbTableCellData>;
export type PropertyChanges = Changes<PropertyData, PropertyKey>;
type TaskChanges = Changes<DbTaskData>;
type ListItemChanges = Changes<DbListItemData>;

type SqlValue = string | number | null | Uint8Array;
export type SqlResult = Array<{ columns: string[]; values: SqlValue[][] }>;

/**
 * Parse SQL result into TaskRow array.
 * Expected columns: id, task_text, status, priority, due_date, scheduled_date,
 * start_date, created_date, done_date, cancelled_date, recurrence, on_completion,
 * task_id, depends_on, tags, line_number, block_id, start_offset, end_offset,
 * anchor_hash, section_heading
 */
export function parseTaskRows(result: SqlResult): TaskRow[] {
  if (result.length === 0 || !result[0].values) return [];

  return result[0].values.map(row => ({
    id: row[0] as number,
    task_text: row[1] as string,
    status: row[2] as string,
    priority: row[3] as string | null,
    due_date: row[4] as string | null,
    scheduled_date: row[5] as string | null,
    start_date: row[6] as string | null,
    created_date: row[7] as string | null,
    done_date: row[8] as string | null,
    cancelled_date: row[9] as string | null,
    recurrence: row[10] as string | null,
    on_completion: row[11] as string | null,
    task_id: row[12] as string | null,
    depends_on: row[13] as string | null,
    tags: row[14] as string | null,
    line_number: row[15] as number,
    block_id: row[16] as string | null,
    start_offset: row[17] as number | null,
    end_offset: row[18] as number | null,
    anchor_hash: row[19] as string | null,
    section_heading: row[20] as string | null
  }));
}

/**
 * Parse SQL result into ListItemRow array.
 * Expected columns: id, list_index, item_index, parent_index, content,
 * list_type, indent_level, line_number, block_id, anchor_hash, start_offset, end_offset
 */
export function parseListItemRows(result: SqlResult): ListItemRow[] {
  if (result.length === 0 || !result[0].values) return [];

  return result[0].values.map(row => ({
    id: row[0] as number,
    list_index: row[1] as number,
    item_index: row[2] as number,
    parent_index: row[3] as number | null,
    content: row[4] as string,
    list_type: row[5] as 'bullet' | 'number',
    indent_level: row[6] as number,
    line_number: row[7] as number,
    block_id: row[8] as string | null,
    anchor_hash: row[9] as string | null,
    start_offset: row[10] as number | null,
    end_offset: row[11] as number | null
  }));
}

/** Convert input task to database record format */
export function toDbTask(t: InputTaskData): DbTaskData {
  return {
    task_text: t.task_text,
    status: t.status ?? DEFAULT_TASK_STATUS,
    priority: t.priority ?? null,
    due_date: t.due_date ?? null,
    scheduled_date: t.scheduled_date ?? null,
    start_date: t.start_date ?? null,
    created_date: t.created_date ?? null,
    done_date: t.done_date ?? null,
    cancelled_date: t.cancelled_date ?? null,
    recurrence: t.recurrence ?? null,
    on_completion: t.on_completion ?? null,
    task_id: t.task_id ?? null,
    depends_on: t.depends_on ?? null,
    tags: t.tags ?? null,
    line_number: t.line_number,
    block_id: t.block_id ?? null,
    anchor_hash: t.anchor_hash ?? null,
    start_offset: t.start_offset ?? null,
    end_offset: t.end_offset ?? null,
    section_heading: t.section_heading ?? null
  };
}

/** Convert input list item to database record format */
export function toDbListItem(item: InputListItemData): DbListItemData {
  return {
    list_index: item.list_index,
    item_index: item.item_index,
    parent_index: item.parent_index ?? null,
    content: item.content,
    list_type: item.list_type,
    indent_level: item.indent_level,
    line_number: item.line_number,
    block_id: item.block_id ?? null,
    anchor_hash: item.anchor_hash ?? null,
    start_offset: item.start_offset ?? null,
    end_offset: item.end_offset ?? null
  };
}

/** Convert input heading to database record format */
export function toDbHeading(h: InputHeadingData): HeadingData {
  return {
    level: h.level,
    heading_text: h.heading_text,
    line_number: h.line_number,
    block_id: h.block_id ?? null,
    anchor_hash: h.anchor_hash ?? null,
    start_offset: h.start_offset ?? null,
    end_offset: h.end_offset ?? null
  };
}

/** Convert input table cell to database record format */
export function toDbTableCell(c: InputTableCellData): DbTableCellData {
  return {
    table_index: c.tableIndex,
    table_name: c.tableName,
    row_index: c.rowIndex,
    column_name: c.columnName,
    cell_value: c.cellValue,
    line_number: c.lineNumber
  };
}

type KeyFn<T> = (item: T) => string;

/** Build a lookup map: key -> first matching item (for unique keys) */
function indexBy<T>(items: T[], keyFn: KeyFn<T>): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, item);
  }
  return map;
}

/** Build a multi-map: key -> all matching items (for non-unique keys) */
function groupBy<T>(items: T[], keyFn: KeyFn<T>): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** Find first unmatched item from a list */
function findUnmatched<T extends { id: number }>(
  items: T[] | undefined,
  matched: Set<number>
): T | undefined {
  return items?.find(item => !matched.has(item.id));
}

function groupByNaturalKey<T extends { id: number }>(
  items: T[],
  naturalKey: (item: T) => string | null
): Map<string, T[]> {
  const byNaturalKey = new Map<string, T[]>();

  for (const item of items) {
    const key = naturalKey(item);
    if (!key) continue;

    const list = byNaturalKey.get(key);
    if (list) list.push(item);
    else byNaturalKey.set(key, [item]);
  }

  return byNaturalKey;
}

function matchByNaturalTextAndLine<TFile, TExisting extends { id: number }>(
  file: TFile[],
  existing: TExisting[],
  getFileNaturalKey: (item: TFile) => string | null,
  getExistingNaturalKey: (item: TExisting) => string | null,
  getFileTextKey: (item: TFile) => string,
  getExistingTextKey: (item: TExisting) => string,
  getFileLineNumber: (item: TFile) => number,
  getExistingLineNumber: (item: TExisting) => number
): { matched: Set<number>; fileMatches: Map<number, TExisting> } {
  const fileNaturalKeys = file.map(getFileNaturalKey);
  const byNaturalKey = groupByNaturalKey(existing, getExistingNaturalKey);
  const byText = groupBy(existing, getExistingTextKey);
  const byLine = groupBy(existing, item => String(getExistingLineNumber(item)));
  const matched = new Set<number>();
  const fileMatches = new Map<number, TExisting>();

  for (let i = 0; i < file.length; i++) {
    const item = file[i];
    let match: TExisting | undefined;

    const naturalKey = fileNaturalKeys[i];
    if (naturalKey) {
      match = findUnmatched(byNaturalKey.get(naturalKey), matched);
    }

    if (!match) {
      match = findUnmatched(byText.get(getFileTextKey(item)), matched);
    }

    if (match) {
      matched.add(match.id);
      fileMatches.set(i, match);
    }
  }

  for (let i = 0; i < file.length; i++) {
    if (fileMatches.has(i)) continue;

    const match = findUnmatched(byLine.get(String(getFileLineNumber(file[i]))), matched);
    if (match) {
      matched.add(match.id);
      fileMatches.set(i, match);
    }
  }

  return { matched, fileMatches };
}

/** Convert row to data (strip id) */
function toData<T extends { id: number }>(row: T): Omit<T, 'id'> {
  const { id: _, ...data } = row;
  return data;
}

/**
 * Detect tag changes. Matches by tag_name to preserve identity when lines shift.
 * Tag moves should fire UPDATE, not DELETE+INSERT.
 */
export function detectTagChanges(file: TagData[], existing: TagRow[]): TagChanges {
  const byName = groupBy(existing, e => e.tag_name);
  const matched = new Set<number>();
  const result: TagChanges = { updated: [], inserted: [], deleted: [] };

  for (const tag of file) {
    const match = findUnmatched(byName.get(tag.tag_name), matched);

    if (match) {
      matched.add(match.id);
      if (match.line_number !== tag.line_number) {
        result.updated.push({ id: match.id, old: toData(match), new: tag });
      }
    } else {
      result.inserted.push(tag);
    }
  }

  for (const e of existing) {
    if (!matched.has(e.id)) result.deleted.push(e.id);
  }

  return result;
}

/**
 * Detect link changes. Matches by link_target to preserve identity when lines shift.
 */
export function detectLinkChanges(file: LinkData[], existing: LinkRow[]): LinkChanges {
  const byTarget = groupBy(existing, e => e.link_target);
  const matched = new Set<number>();
  const result: LinkChanges = { updated: [], inserted: [], deleted: [] };

  for (const link of file) {
    const match = findUnmatched(byTarget.get(link.link_target), matched);

    if (match) {
      matched.add(match.id);
      const changed =
        match.link_text !== link.link_text ||
        match.link_target_path !== link.link_target_path ||
        match.link_type !== link.link_type ||
        match.line_number !== link.line_number;

      if (changed) {
        result.updated.push({ id: match.id, old: toData(match), new: link });
      }
    } else {
      result.inserted.push(link);
    }
  }

  for (const e of existing) {
    if (!matched.has(e.id)) result.deleted.push(e.id);
  }

  return result;
}

/** Create content hash for heading identity */
function headingIdentity(level: number, text: string): string {
  return `${level}:${text}`;
}

/**
 * Detect heading changes. Matches by:
 * 1. Content (level+text) - preserves identity when heading moves
 * 2. Line number - preserves identity when heading text is edited
 */
export function detectHeadingChanges(file: HeadingData[], existing: HeadingRow[]): HeadingChanges {
  const byContent = groupBy(existing, e => headingIdentity(e.level, e.heading_text));
  const byLine = groupBy(existing, e => String(e.line_number));
  const matched = new Set<number>();
  const result: HeadingChanges = { updated: [], inserted: [], deleted: [] };

  for (const heading of file) {
    const identity = headingIdentity(heading.level, heading.heading_text);

    // Try content match first (heading moved but text unchanged)
    let match = findUnmatched(byContent.get(identity), matched);

    // Fall back to line match (heading text edited in place)
    if (!match) {
      match = findUnmatched(byLine.get(String(heading.line_number)), matched);
    }

    if (match) {
      matched.add(match.id);
      const changed =
        match.level !== heading.level ||
        match.heading_text !== heading.heading_text ||
        match.line_number !== heading.line_number ||
        match.block_id !== heading.block_id ||
        match.anchor_hash !== heading.anchor_hash ||
        match.start_offset !== heading.start_offset ||
        match.end_offset !== heading.end_offset;

      if (changed) {
        result.updated.push({ id: match.id, old: toData(match), new: heading });
      }
    } else {
      result.inserted.push(heading);
    }
  }

  for (const e of existing) {
    if (!matched.has(e.id)) result.deleted.push(e.id);
  }

  return result;
}

/** Create composite key for properties (no id column in table) */
function propertyKey(key: string, arrayIndex: number | null): string {
  return `${key}\0${arrayIndex ?? ''}`;
}

/**
 * Detect property changes. Uses composite key (key, array_index).
 * Handles scalar <-> array[0] transitions as updates.
 */
export function detectPropertyChanges(file: PropertyData[], existing: PropertyData[]): PropertyChanges {
  const byKey = indexBy(existing, e => propertyKey(e.key, e.array_index));

  // Index scalars and array[0] for transition detection
  const scalars = indexBy(
    existing.filter(e => e.array_index === null),
    e => e.key
  );
  const array0s = indexBy(
    existing.filter(e => e.array_index === 0),
    e => e.key
  );

  const arrayCounts = new Map<string, number>();
  for (const e of existing) {
    if (e.array_index !== null) {
      arrayCounts.set(e.key, (arrayCounts.get(e.key) ?? 0) + 1);
    }
  }

  const matched = new Set<string>();
  const result: PropertyChanges = { updated: [], inserted: [], deleted: [] };

  for (const prop of file) {
    const key = propertyKey(prop.key, prop.array_index);

    let match = byKey.get(key);
    let matchKey = key;

    // Try scalar <-> array[0] transition
    if (!match || matched.has(matchKey)) {
      if (prop.array_index === 0) {
        const scalar = scalars.get(prop.key);
        if (scalar && !matched.has(propertyKey(prop.key, null))) {
          match = scalar;
          matchKey = propertyKey(prop.key, null);
        }
      } else if (prop.array_index === null) {
        const arr0 = array0s.get(prop.key);
        if (arr0 && !matched.has(propertyKey(prop.key, 0)) && arrayCounts.get(prop.key) === 1) {
          match = arr0;
          matchKey = propertyKey(prop.key, 0);
        }
      }
    }

    if (match && !matched.has(matchKey)) {
      matched.add(matchKey);
      const changed = match.value !== prop.value || match.value_type !== prop.value_type;

      if (changed || match.array_index !== prop.array_index) {
        const id: PropertyKey = { key: match.key, array_index: match.array_index };
        result.updated.push({ id, old: match, new: prop });
      }
    } else {
      result.inserted.push(prop);
    }
  }

  for (const e of existing) {
    const key = propertyKey(e.key, e.array_index);
    if (!matched.has(key)) {
      result.deleted.push({ key: e.key, array_index: e.array_index });
    }
  }

  return result;
}

/** Create position key for table cells */
function cellKey(tableIndex: number, rowIndex: number, columnName: string): string {
  return `${tableIndex}:${rowIndex}:${columnName}`;
}

/**
 * Detect table cell changes. Matches by position (table_index, row_index, column_name).
 */
export function detectTableCellChanges(file: DbTableCellData[], existing: TableCellRow[]): TableCellChanges {
  const byPosition = indexBy(existing, e => cellKey(e.table_index, e.row_index, e.column_name));
  const matched = new Set<number>();
  const result: TableCellChanges = { updated: [], inserted: [], deleted: [] };

  for (const cell of file) {
    const key = cellKey(cell.table_index, cell.row_index, cell.column_name);
    const match = byPosition.get(key);

    if (match && !matched.has(match.id)) {
      matched.add(match.id);
      const changed =
        match.cell_value !== cell.cell_value ||
        match.table_name !== cell.table_name ||
        match.line_number !== cell.line_number;

      if (changed) {
        result.updated.push({ id: match.id, old: toData(match), new: cell });
      }
    } else {
      result.inserted.push(cell);
    }
  }

  for (const e of existing) {
    if (!matched.has(e.id)) result.deleted.push(e.id);
  }

  return result;
}

/** Get natural key for task (block_id or anchor_hash) */
function taskNaturalKey(task: { block_id: string | null; anchor_hash: string | null }): string | null {
  return task.block_id ?? task.anchor_hash;
}

/**
 * Detect task changes. Uses two-pass matching:
 * Pass 1: Match by natural key and task text (reliable identity matches)
 * Pass 2: Match remaining items by line number (for in-place edits)
 *
 * Avoids cascading "updates" to subsequent tasks after insertions.
 */
export function detectTaskChanges(file: DbTaskData[], existing: TaskRow[]): TaskChanges {
  const { matched, fileMatches } = matchByNaturalTextAndLine<DbTaskData, TaskRow>(
    file,
    existing,
    taskNaturalKey,
    taskNaturalKey,
    task => task.task_text,
    task => task.task_text,
    task => task.line_number,
    task => task.line_number
  );
  const result: TaskChanges = { updated: [], inserted: [], deleted: [] };

  for (let i = 0; i < file.length; i++) {
    const task = file[i];
    const match = fileMatches.get(i);

    if (match) {
      const changed =
        match.task_text !== task.task_text ||
        match.status !== task.status ||
        match.priority !== task.priority ||
        match.due_date !== task.due_date ||
        match.scheduled_date !== task.scheduled_date ||
        match.start_date !== task.start_date ||
        match.created_date !== task.created_date ||
        match.done_date !== task.done_date ||
        match.cancelled_date !== task.cancelled_date ||
        match.recurrence !== task.recurrence ||
        match.on_completion !== task.on_completion ||
        match.task_id !== task.task_id ||
        match.depends_on !== task.depends_on ||
        match.tags !== task.tags ||
        match.line_number !== task.line_number ||
        match.block_id !== task.block_id ||
        match.anchor_hash !== task.anchor_hash ||
        match.section_heading !== task.section_heading;

      if (changed) {
        result.updated.push({ id: match.id, old: toData(match), new: task });
      }
    } else {
      result.inserted.push(task);
    }
  }

  for (const e of existing) {
    if (!matched.has(e.id)) result.deleted.push(e.id);
  }

  return result;
}

/** Get natural key for list item (block_id or anchor_hash) */
function listItemNaturalKey(item: { block_id: string | null; anchor_hash: string | null }): string | null {
  return item.block_id ?? item.anchor_hash;
}

/**
 * Detect list item changes. Uses two-pass matching:
 * Pass 1: Match by natural key and content (reliable identity matches)
 * Pass 2: Match remaining items by line number (for in-place edits)
 *
 * Avoids cascading "updates" to subsequent items after insertions.
 */
export function detectListItemChanges(file: DbListItemData[], existing: ListItemRow[]): ListItemChanges {
  const { matched, fileMatches } = matchByNaturalTextAndLine<DbListItemData, ListItemRow>(
    file,
    existing,
    listItemNaturalKey,
    listItemNaturalKey,
    item => item.content,
    item => item.content,
    item => item.line_number,
    item => item.line_number
  );
  const result: ListItemChanges = { updated: [], inserted: [], deleted: [] };

  for (let i = 0; i < file.length; i++) {
    const item = file[i];
    const match = fileMatches.get(i);

    if (match) {
      const changed =
        match.content !== item.content ||
        match.list_index !== item.list_index ||
        match.item_index !== item.item_index ||
        match.parent_index !== item.parent_index ||
        match.list_type !== item.list_type ||
        match.indent_level !== item.indent_level ||
        match.line_number !== item.line_number ||
        match.block_id !== item.block_id ||
        match.anchor_hash !== item.anchor_hash ||
        match.start_offset !== item.start_offset ||
        match.end_offset !== item.end_offset;

      if (changed) {
        result.updated.push({ id: match.id, old: toData(match), new: item });
      }
    } else {
      result.inserted.push(item);
    }
  }

  for (const e of existing) {
    if (!matched.has(e.id)) result.deleted.push(e.id);
  }

  return result;
}

export const TASK_SELECT_COLUMNS = `id, task_text, status, priority, due_date, scheduled_date,
  start_date, created_date, done_date, cancelled_date, recurrence, on_completion,
  task_id, depends_on, tags, line_number, block_id, start_offset, end_offset,
  anchor_hash, section_heading`;

export const LIST_ITEM_SELECT_COLUMNS = `id, list_index, item_index, parent_index, content,
  list_type, indent_level, line_number, block_id, anchor_hash, start_offset, end_offset`;
