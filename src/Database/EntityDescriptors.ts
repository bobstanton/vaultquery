import type { IndexNoteData, TaskData, ListItemData, TableCellData } from '../types';

export type SqlValue = string | number | null | Uint8Array;
export type SqlResult = Array<{ columns: string[]; values: SqlValue[][] }>;
export type SqlParam = string | number | null;

export const DEFAULT_TASK_STATUS = 'TODO';
const TABLE_CELL_VALUE_TYPE = 'string';

type ColumnType = 'text' | 'integer';

export interface ColumnDef {
  readonly type: ColumnType;
  readonly nullable: boolean;
}

const TEXT = { type: 'text', nullable: false } as const;
const TEXT_NULL = { type: 'text', nullable: true } as const;
const INT = { type: 'integer', nullable: false } as const;
const INT_NULL = { type: 'integer', nullable: true } as const;

type ColumnValue<C extends ColumnDef> =
  | (C['type'] extends 'text' ? string : number)
  | (C['nullable'] extends true ? null : never);

export type RowOf<TColumns extends Record<string, ColumnDef>> = {
  [K in keyof TColumns]: ColumnValue<TColumns[K]>;
};

export type EntityRow<TRow> = TRow & { id: number };

export interface Changes<TData, TId = number> {
  updated: Array<{ id: TId; old: TData; new: TData }>;
  inserted: TData[];
  deleted: TId[];
}

interface EntityMatch<TRow> {
  matched: Set<number>;
  fileMatches: Map<number, EntityRow<TRow>>;
}

type MatchFn<TRow> = (file: TRow[], existing: EntityRow<TRow>[]) => EntityMatch<TRow>;

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function indexBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, item);
  }
  return map;
}

function findUnmatched<T extends { id: number }>(items: T[] | undefined, matched: Set<number>): T | undefined {
  return items?.find(item => !matched.has(item.id));
}

function matchInOrderByKey<TRow>(key: (row: TRow) => string): MatchFn<TRow> {
  return (file, existing) => {
    const byKey = groupBy(existing, e => key(e));
    const matched = new Set<number>();
    const fileMatches = new Map<number, EntityRow<TRow>>();

    for (let i = 0; i < file.length; i++) {
      const match = findUnmatched(byKey.get(key(file[i])), matched);
      if (match) {
        matched.add(match.id);
        fileMatches.set(i, match);
      }
    }

    return { matched, fileMatches };
  };
}

function matchByUniqueKey<TRow>(key: (row: TRow) => string): MatchFn<TRow> {
  return (file, existing) => {
    const byKey = indexBy(existing, e => key(e));
    const matched = new Set<number>();
    const fileMatches = new Map<number, EntityRow<TRow>>();

    for (let i = 0; i < file.length; i++) {
      const match = byKey.get(key(file[i]));
      if (match && !matched.has(match.id)) {
        matched.add(match.id);
        fileMatches.set(i, match);
      }
    }

    return { matched, fileMatches };
  };
}

function matchByKeyThenLine<TRow>(contentKey: (row: TRow) => string, lineNumber: (row: TRow) => number): MatchFn<TRow> {
  return (file, existing) => {
    const byContent = groupBy(existing, e => contentKey(e));
    const byLine = groupBy(existing, e => String(lineNumber(e)));
    const matched = new Set<number>();
    const fileMatches = new Map<number, EntityRow<TRow>>();

    for (let i = 0; i < file.length; i++) {
      const match =
        findUnmatched(byContent.get(contentKey(file[i])), matched) ??
        findUnmatched(byLine.get(String(lineNumber(file[i]))), matched);

      if (match) {
        matched.add(match.id);
        fileMatches.set(i, match);
      }
    }

    return { matched, fileMatches };
  };
}

function matchByNaturalTextThenLine<TRow>(
  naturalKey: (row: TRow) => string | null,
  textKey: (row: TRow) => string,
  lineNumber: (row: TRow) => number
): MatchFn<TRow> {
  return (file, existing) => {
    const byNaturalKey = new Map<string, EntityRow<TRow>[]>();
    for (const row of existing) {
      const key = naturalKey(row);
      if (!key) continue;
      const list = byNaturalKey.get(key);
      if (list) list.push(row);
      else byNaturalKey.set(key, [row]);
    }
    const byText = groupBy(existing, e => textKey(e));
    const byLine = groupBy(existing, e => String(lineNumber(e)));
    const matched = new Set<number>();
    const fileMatches = new Map<number, EntityRow<TRow>>();

    for (let i = 0; i < file.length; i++) {
      const row = file[i];
      const key = naturalKey(row);
      let match = key ? findUnmatched(byNaturalKey.get(key), matched) : undefined;

      if (!match) {
        match = findUnmatched(byText.get(textKey(row)), matched);
      }

      if (match) {
        matched.add(match.id);
        fileMatches.set(i, match);
      }
    }

    for (let i = 0; i < file.length; i++) {
      if (fileMatches.has(i)) continue;

      const match = findUnmatched(byLine.get(String(lineNumber(file[i]))), matched);
      if (match) {
        matched.add(match.id);
        fileMatches.set(i, match);
      }
    }

    return { matched, fileMatches };
  };
}

type SqlRecord = Record<string, SqlParam>;

interface UpdatePlan {
  sql: string;
  params: SqlParam[];
}

interface InsertExtra<TRow> {
  column: string;
  value: (row: TRow) => SqlParam;
}

export interface InsertEntityDescriptor<TInput, TRow extends SqlRecord> {
  table: string;
  columns: Record<string, ColumnDef>;
  columnNames: readonly string[];
  normalize: (input: TInput) => TRow;
  insertExtras?: ReadonlyArray<InsertExtra<TRow>>;
  insertBaseSql: string;
  insertColumnCount: number;
  deleteByPathSql: string;
}

export interface EntityDescriptor<TInput, TRow extends SqlRecord> extends InsertEntityDescriptor<TInput, TRow> {
  match: MatchFn<TRow>;
  selectSql: string;
  updateColumns: readonly string[];
  updateSql: string;
  updatePlan?: (oldRow: TRow, newRow: TRow) => UpdatePlan;
}

export function buildSelectSql(table: string, columnNames: readonly string[]): string {
  return `SELECT id, ${columnNames.join(', ')} FROM ${table} WHERE path = ?`;
}

export function buildInsertBaseSql(table: string, columnNames: readonly string[]): string {
  return `INSERT INTO ${table} (path, ${columnNames.join(', ')}) VALUES `;
}

export function buildUpdateSql(table: string, columnNames: readonly string[]): string {
  return `UPDATE ${table} SET ${columnNames.map(name => `${name} = ?`).join(', ')} WHERE id = ?`;
}

export function buildDeleteByPathSql(table: string): string {
  return `DELETE FROM ${table} WHERE path = ?`;
}

interface InsertEntitySpec<TInput, TColumns extends Record<string, ColumnDef>> {
  table: string;
  columns: TColumns;
  normalize: (input: TInput) => RowOf<TColumns>;
  insertExtras?: ReadonlyArray<InsertExtra<RowOf<TColumns>>>;
}

function defineInsertEntity<TInput, TColumns extends Record<string, ColumnDef>>(
  spec: InsertEntitySpec<TInput, TColumns>
): InsertEntityDescriptor<TInput, RowOf<TColumns>> {
  const columnNames = Object.keys(spec.columns);
  const extraNames = (spec.insertExtras ?? []).map(extra => extra.column);
  return {
    table: spec.table,
    columns: spec.columns,
    columnNames,
    normalize: spec.normalize,
    insertExtras: spec.insertExtras,
    insertBaseSql: buildInsertBaseSql(spec.table, [...columnNames, ...extraNames]),
    insertColumnCount: 1 + columnNames.length + extraNames.length,
    deleteByPathSql: buildDeleteByPathSql(spec.table),
  };
}

interface EntitySpec<TInput, TColumns extends Record<string, ColumnDef>> extends InsertEntitySpec<TInput, TColumns> {
  match: MatchFn<RowOf<TColumns>>;
  updateColumns?: readonly (keyof TColumns & string)[];
  updatePlan?: (oldRow: RowOf<TColumns>, newRow: RowOf<TColumns>) => UpdatePlan;
}

function defineEntity<TInput, TColumns extends Record<string, ColumnDef>>(
  spec: EntitySpec<TInput, TColumns>
): EntityDescriptor<TInput, RowOf<TColumns>> {
  const base = defineInsertEntity(spec);
  const updateColumns = spec.updateColumns ?? base.columnNames;
  return {
    ...base,
    match: spec.match,
    selectSql: buildSelectSql(spec.table, base.columnNames),
    updateColumns,
    updateSql: buildUpdateSql(spec.table, updateColumns),
    updatePlan: spec.updatePlan,
  };
}

export function mapEntityRow<TInput, TRow extends SqlRecord>(entity: EntityDescriptor<TInput, TRow>, row: SqlValue[]): EntityRow<TRow> {
  const mapped: Record<string, SqlValue> = { id: row[0] };
  for (let i = 0; i < entity.columnNames.length; i++) {
    mapped[entity.columnNames[i]] = row[i + 1];
  }
  return mapped as EntityRow<TRow>;
}

export function entityInsertRow<TInput, TRow extends SqlRecord>(entity: InsertEntityDescriptor<TInput, TRow>, path: string, row: TRow): SqlParam[] {
  const values: SqlParam[] = [path];
  for (const name of entity.columnNames) {
    values.push(row[name]);
  }
  for (const extra of entity.insertExtras ?? []) {
    values.push(extra.value(row));
  }
  return values;
}

export function entityRowChanged<TInput, TRow extends SqlRecord>(entity: EntityDescriptor<TInput, TRow>, a: TRow, b: TRow): boolean {
  return entity.columnNames.some(name => a[name] !== b[name]);
}

export function entityUpdatePlan<TInput, TRow extends SqlRecord>(entity: EntityDescriptor<TInput, TRow>, oldRow: TRow, newRow: TRow): UpdatePlan {
  if (entity.updatePlan) {
    return entity.updatePlan(oldRow, newRow);
  }
  return { sql: entity.updateSql, params: entity.updateColumns.map(name => newRow[name]) };
}

export function detectEntityChanges<TInput, TRow extends SqlRecord>(
  entity: EntityDescriptor<TInput, TRow>,
  file: TRow[],
  existing: EntityRow<TRow>[]
): Changes<TRow> {
  const { matched, fileMatches } = entity.match(file, existing);
  const result: Changes<TRow> = { updated: [], inserted: [], deleted: [] };

  for (let i = 0; i < file.length; i++) {
    const row = file[i];
    const match = fileMatches.get(i);

    if (match) {
      if (entityRowChanged(entity, match, row)) {
        result.updated.push({ id: match.id, old: match, new: row });
      }
    } else {
      result.inserted.push(row);
    }
  }

  for (const e of existing) {
    if (!matched.has(e.id)) result.deleted.push(e.id);
  }

  return result;
}

const TASK_COLUMNS = {
  task_text: TEXT,
  status: TEXT,
  priority: TEXT_NULL,
  due_date: TEXT_NULL,
  scheduled_date: TEXT_NULL,
  start_date: TEXT_NULL,
  created_date: TEXT_NULL,
  done_date: TEXT_NULL,
  cancelled_date: TEXT_NULL,
  recurrence: TEXT_NULL,
  on_completion: TEXT_NULL,
  task_id: TEXT_NULL,
  depends_on: TEXT_NULL,
  tags: TEXT_NULL,
  line_number: INT,
  block_id: TEXT_NULL,
  start_offset: INT_NULL,
  end_offset: INT_NULL,
  anchor_hash: TEXT_NULL,
  section_heading: TEXT_NULL,
} satisfies Record<string, ColumnDef>;

export type DbTaskData = RowOf<typeof TASK_COLUMNS>;

function blockOrAnchorKey(row: { block_id: string | null; anchor_hash: string | null }): string | null {
  return row.block_id ?? row.anchor_hash;
}

export const TASKS_ENTITY = defineEntity<TaskData, typeof TASK_COLUMNS>({
  table: 'tasks',
  columns: TASK_COLUMNS,
  normalize: t => ({
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
    start_offset: t.start_offset ?? null,
    end_offset: t.end_offset ?? null,
    anchor_hash: t.anchor_hash ?? null,
    section_heading: t.section_heading ?? null,
  }),
  match: matchByNaturalTextThenLine<DbTaskData>(blockOrAnchorKey, row => row.task_text, row => row.line_number),
});

const HEADING_COLUMNS = {
  level: INT,
  heading_text: TEXT,
  line_number: INT,
  block_id: TEXT_NULL,
  start_offset: INT_NULL,
  end_offset: INT_NULL,
  anchor_hash: TEXT_NULL,
} satisfies Record<string, ColumnDef>;


export type InputHeadingData = NonNullable<IndexNoteData['headings']>[number];

export const HEADINGS_ENTITY = defineEntity<InputHeadingData, typeof HEADING_COLUMNS>({
  table: 'headings',
  columns: HEADING_COLUMNS,
  normalize: h => ({
    level: h.level,
    heading_text: h.heading_text,
    line_number: h.line_number,
    block_id: h.block_id ?? null,
    start_offset: h.start_offset ?? null,
    end_offset: h.end_offset ?? null,
    anchor_hash: h.anchor_hash ?? null,
  }),
  match: matchByKeyThenLine(row => `${row.level}:${row.heading_text}`, row => row.line_number),
});

const LIST_ITEM_COLUMNS = {
  list_index: INT,
  item_index: INT,
  parent_index: INT_NULL,
  content: TEXT,
  list_type: TEXT,
  indent_level: INT,
  line_number: INT,
  block_id: TEXT_NULL,
  start_offset: INT_NULL,
  end_offset: INT_NULL,
  anchor_hash: TEXT_NULL,
} satisfies Record<string, ColumnDef>;

export type DbListItemData = RowOf<typeof LIST_ITEM_COLUMNS>;

export const LIST_ITEMS_ENTITY = defineEntity<ListItemData, typeof LIST_ITEM_COLUMNS>({
  table: 'list_items',
  columns: LIST_ITEM_COLUMNS,
  normalize: item => ({
    list_index: item.list_index,
    item_index: item.item_index,
    parent_index: item.parent_index ?? null,
    content: item.content,
    list_type: item.list_type,
    indent_level: item.indent_level,
    line_number: item.line_number,
    block_id: item.block_id ?? null,
    start_offset: item.start_offset ?? null,
    end_offset: item.end_offset ?? null,
    anchor_hash: item.anchor_hash ?? null,
  }),
  match: matchByNaturalTextThenLine<DbListItemData>(blockOrAnchorKey, row => row.content, row => row.line_number),
});

const LINK_COLUMNS = {
  link_text: TEXT,
  link_target: TEXT,
  link_target_path: TEXT_NULL,
  link_type: TEXT,
  line_number: INT_NULL,
  original: TEXT_NULL,
  start_offset: INT_NULL,
  end_offset: INT_NULL,
  frontmatter_key: TEXT_NULL,
} satisfies Record<string, ColumnDef>;

export type InputLinkData = NonNullable<IndexNoteData['links']>[number];

export const LINKS_ENTITY = defineEntity<InputLinkData, typeof LINK_COLUMNS>({
  table: 'links',
  columns: LINK_COLUMNS,
  normalize: link => link,
  match: matchInOrderByKey(row => row.link_target),
});

const TAG_COLUMNS = {
  tag_name: TEXT,
  line_number: INT,
} satisfies Record<string, ColumnDef>;

export type InputTagData = NonNullable<IndexNoteData['tags']>[number];

export const TAGS_ENTITY = defineEntity<InputTagData, typeof TAG_COLUMNS>({
  table: 'tags',
  columns: TAG_COLUMNS,
  normalize: tag => tag,
  match: matchInOrderByKey(row => row.tag_name),
  updateColumns: ['line_number'],
});

const TABLE_CELL_COLUMNS = {
  table_index: INT,
  table_name: TEXT_NULL,
  row_index: INT,
  column_name: TEXT,
  cell_value: TEXT,
  line_number: INT_NULL,
} satisfies Record<string, ColumnDef>;


const TABLE_CELL_UPDATE_CONTENT_SQL = buildUpdateSql('table_cells', ['table_name', 'cell_value', 'line_number']);
const TABLE_CELL_UPDATE_LINE_SQL = buildUpdateSql('table_cells', ['line_number']);

export const TABLE_CELLS_ENTITY = defineEntity<TableCellData, typeof TABLE_CELL_COLUMNS>({
  table: 'table_cells',
  columns: TABLE_CELL_COLUMNS,
  normalize: c => ({
    table_index: c.tableIndex,
    table_name: c.tableName,
    row_index: c.rowIndex,
    column_name: c.columnName,
    cell_value: c.cellValue,
    line_number: c.lineNumber,
  }),
  match: matchByUniqueKey(row => `${row.table_index}:${row.row_index}:${row.column_name}`),
  insertExtras: [{ column: 'value_type', value: () => TABLE_CELL_VALUE_TYPE }],
  updatePlan: (oldRow, newRow) => {
    const contentChanged = oldRow.table_name !== newRow.table_name || oldRow.cell_value !== newRow.cell_value;
    if (contentChanged) {
      return { sql: TABLE_CELL_UPDATE_CONTENT_SQL, params: [newRow.table_name, newRow.cell_value, newRow.line_number] };
    }
    return { sql: TABLE_CELL_UPDATE_LINE_SQL, params: [newRow.line_number] };
  },
});

const EMBED_COLUMNS = {
  embed_text: TEXT,
  embed_target: TEXT,
  embed_target_path: TEXT_NULL,
  line_number: INT,
} satisfies Record<string, ColumnDef>;

type InputEmbedData = NonNullable<IndexNoteData['embeds']>[number];

export const EMBEDS_ENTITY = defineInsertEntity<InputEmbedData, typeof EMBED_COLUMNS>({
  table: 'embeds',
  columns: EMBED_COLUMNS,
  normalize: embed => embed,
});

const UNRESOLVED_LINK_COLUMNS = {
  link_target: TEXT,
  link_count: INT,
} satisfies Record<string, ColumnDef>;

type InputUnresolvedLinkData = NonNullable<IndexNoteData['unresolvedLinks']>[number];

export const UNRESOLVED_LINKS_ENTITY = defineInsertEntity<InputUnresolvedLinkData, typeof UNRESOLVED_LINK_COLUMNS>({
  table: 'unresolved_links',
  columns: UNRESOLVED_LINK_COLUMNS,
  normalize: link => link,
});

const BLOCK_COLUMNS = {
  block_id: TEXT,
  line_number: INT,
  start_offset: INT,
  end_offset: INT,
  section_type: TEXT_NULL,
} satisfies Record<string, ColumnDef>;

type InputBlockData = NonNullable<IndexNoteData['blocks']>[number];

export const BLOCKS_ENTITY = defineInsertEntity<InputBlockData, typeof BLOCK_COLUMNS>({
  table: 'blocks',
  columns: BLOCK_COLUMNS,
  normalize: block => block,
});

export const TABLES_SQL = {
  SELECT: 'SELECT table_index, table_name, block_id, start_offset, end_offset, line_number FROM tables WHERE path = ? ORDER BY table_index',
  UPDATE: 'UPDATE tables SET table_index = ?, table_name = ?, block_id = ?, start_offset = ?, end_offset = ?, line_number = ? WHERE path = ? AND table_index = ?',
  INSERT_BASE: buildInsertBaseSql('tables', ['table_index', 'table_name', 'block_id', 'start_offset', 'end_offset', 'line_number']),
  INSERT_COLUMNS: 7,
  DELETE_BY_PATH: buildDeleteByPathSql('tables'),
  DELETE_BY_INDEX_IN: 'DELETE FROM tables WHERE path = ? AND table_index IN ',
} as const;
