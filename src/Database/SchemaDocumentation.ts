export interface SchemaColumnDoc {
  name: string;
  type: string;
  description: string;
  defaultVal?: string;
}

export function renderSchemaTableDoc(tableName: string, columns: SchemaColumnDoc[], isView = false): string {
  const header = `### ${tableName}${isView ? ' (VIEW)' : ''}\n\n`;
  const hasDefaults = columns.some(c => c.defaultVal);
  const tableHeader = hasDefaults
    ? '| Column | Type | Default | Description |\n|--------|------|---------|-------------|\n'
    : '| Column | Type | Description |\n|--------|------|-------------|\n';
  const rows = columns.map(c => hasDefaults
    ? `| \`${c.name}\` | ${c.type} | ${c.defaultVal || ''} | ${c.description} |`
    : `| \`${c.name}\` | ${c.type} | ${c.description} |`
  ).join('\n');
  return header + tableHeader + rows + '\n';
}

export function taskColumnDocs(overrides: Record<string, Partial<SchemaColumnDoc>> = {}): SchemaColumnDoc[] {
  return [
    { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
    { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
    { name: 'task_text', type: 'TEXT', description: 'Task content' },
    { name: 'status', type: 'TEXT', description: 'TODO, DONE, IN_PROGRESS, CANCELLED' },
    { name: 'priority', type: 'TEXT', description: 'highest, high, medium, low, lowest' },
    { name: 'due_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
    { name: 'scheduled_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
    { name: 'start_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
    { name: 'created_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
    { name: 'done_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
    { name: 'cancelled_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
    { name: 'recurrence', type: 'TEXT', description: 'Recurrence rule' },
    { name: 'on_completion', type: 'TEXT', description: 'Action on completion' },
    { name: 'task_id', type: 'TEXT', description: 'Unique task identifier' },
    { name: 'depends_on', type: 'TEXT', description: 'Task dependencies' },
    { name: 'tags', type: 'TEXT', description: 'Space-separated tags' },
    { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
    { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
    { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
    { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
    { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
    { name: 'section_heading', type: 'TEXT', description: 'Parent heading text' },
  ].map(column => ({ ...column, ...overrides[column.name] }));
}

export const NOTES_COLUMNS: SchemaColumnDoc[] = [
  { name: 'path', type: 'TEXT', description: 'File path (primary key)' },
  { name: 'title', type: 'TEXT', description: 'Note name (filename without extension)' },
  { name: 'content', type: 'TEXT', description: 'Full text content' },
  { name: 'created', type: 'INTEGER', description: 'Creation timestamp (ms)' },
  { name: 'modified', type: 'INTEGER', description: 'Last modified timestamp (ms)' },
  { name: 'size', type: 'INTEGER', description: 'File size in bytes' },
];

export const PROPERTIES_COLUMNS: SchemaColumnDoc[] = [
  { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
  { name: 'key', type: 'TEXT', description: 'Property name' },
  { name: 'value', type: 'TEXT', description: 'Property value as string' },
  { name: 'value_type', type: 'TEXT', description: 'Type: string, number, boolean, array, object' },
  { name: 'array_index', type: 'INTEGER', description: 'Array index (NULL for scalar values)' },
];

export const TASKS_VIEW_COLUMNS: SchemaColumnDoc[] = [
  ...taskColumnDocs({
    path: { description: 'File path' },
    status: { defaultVal: 'TODO' },
    created_date: { defaultVal: 'today' },
    line_number: { defaultVal: 'auto', description: 'After last task line, or line 1 if no tasks' },
  }).filter(column => !['start_offset', 'end_offset', 'anchor_hash'].includes(column.name)),
  { name: 'status_order', type: 'INTEGER', description: 'Sort order for status (computed)' },
  { name: 'priority_order', type: 'INTEGER', description: 'Sort order for priority (computed)' },
  { name: 'is_complete', type: 'INTEGER', description: '1 if DONE/CANCELLED (computed)' },
  { name: 'is_overdue', type: 'INTEGER', description: '1 if past due (computed)' },
  { name: 'days_until_due', type: 'INTEGER', description: 'Days until due date (computed)' },
];

export const HEADINGS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
  { name: 'level', type: 'INTEGER', description: 'Heading level (1-6)' },
  { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
  { name: 'heading_text', type: 'TEXT', description: 'Heading content' },
  { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
  { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
  { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
  { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
];

export const HEADINGS_VIEW_COLUMNS: SchemaColumnDoc[] = [
  { name: 'path', type: 'TEXT', description: 'File path' },
  { name: 'level', type: 'INTEGER', defaultVal: '1', description: 'Heading level (1-6)' },
  { name: 'line_number', type: 'INTEGER', defaultVal: 'auto', description: 'After last heading line, or line 1 if no headings' },
  { name: 'heading_text', type: 'TEXT', description: 'Heading content' },
  { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
  { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
  { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
  { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
];

export const TAGS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
  { name: 'tag_name', type: 'TEXT', description: 'Tag name (with # prefix)' },
  { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
  { name: 'insert_position', type: 'TEXT', description: 'Position hint for INSERT: new_line, line_start, or line_end' },
];

export const LINKS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
  { name: 'link_text', type: 'TEXT', description: 'Display text' },
  { name: 'link_target', type: 'TEXT', description: 'Target path or URL' },
  { name: 'link_target_path', type: 'TEXT', description: 'Resolved target file path (NULL when unresolved)' },
  { name: 'link_type', type: 'TEXT', description: 'internal, external, or frontmatter' },
  { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based; NULL for frontmatter links)' },
  { name: 'insert_position', type: 'TEXT', description: 'Position hint for INSERT: new_line, line_start, or line_end' },
  { name: 'original', type: 'TEXT', description: 'Raw link markup as written (e.g. [[Target|alias]])' },
  { name: 'start_offset', type: 'INTEGER', description: 'Character offset where link starts (NULL for frontmatter links)' },
  { name: 'end_offset', type: 'INTEGER', description: 'Character offset where link ends (NULL for frontmatter links)' },
  { name: 'frontmatter_key', type: 'TEXT', description: 'Frontmatter property holding the link (NULL for body links)' },
];

export const UNRESOLVED_LINKS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'Source file path' },
  { name: 'link_target', type: 'TEXT', description: 'Unresolved target text' },
  { name: 'link_count', type: 'INTEGER', description: 'Number of unresolved links to target in path' },
];

export const EMBEDS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'Source file path' },
  { name: 'embed_text', type: 'TEXT', description: 'Display text' },
  { name: 'embed_target', type: 'TEXT', description: 'Embed target' },
  { name: 'embed_target_path', type: 'TEXT', description: 'Resolved target file path' },
  { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
];

export const BLOCKS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'File path' },
  { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
  { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
  { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
  { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
  { name: 'section_type', type: 'TEXT', description: 'Containing Obsidian section type' },
];

export const LIST_ITEMS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
  { name: 'list_index', type: 'INTEGER', description: 'List group index (0-based)' },
  { name: 'item_index', type: 'INTEGER', description: 'Item index within file' },
  { name: 'parent_index', type: 'INTEGER', description: 'Parent item index' },
  { name: 'content', type: 'TEXT', description: 'List item text' },
  { name: 'list_type', type: 'TEXT', description: 'bullet or number' },
  { name: 'indent_level', type: 'INTEGER', description: 'Nesting depth (0 = top)' },
  { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
  { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
  { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
  { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
  { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
];

export const LIST_ITEMS_VIEW_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'File path' },
  { name: 'list_index', type: 'INTEGER', defaultVal: '0', description: 'List group index' },
  { name: 'item_index', type: 'INTEGER', defaultVal: 'auto', description: 'MAX(item_index)+1 or 0 if none exist' },
  { name: 'parent_index', type: 'INTEGER', description: 'Parent item index' },
  { name: 'content', type: 'TEXT', description: 'List item text' },
  { name: 'list_type', type: 'TEXT', defaultVal: 'bullet', description: 'bullet or number' },
  { name: 'indent_level', type: 'INTEGER', defaultVal: '0', description: 'Nesting depth' },
  { name: 'line_number', type: 'INTEGER', defaultVal: 'auto', description: 'After last item line, or line 1 if no items' },
  { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
  { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
  { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
  { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
  { name: 'parent_content', type: 'TEXT', description: 'Parent item text (computed)' },
];

export const TABLE_CELLS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
  { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
  { name: 'table_index', type: 'INTEGER', description: 'Table index (0-based)' },
  { name: 'table_name', type: 'TEXT', description: 'Table name from heading or block ID' },
  { name: 'row_index', type: 'INTEGER', description: 'Row index (0-based)' },
  { name: 'column_name', type: 'TEXT', description: 'Column header' },
  { name: 'cell_value', type: 'TEXT', description: 'Cell content' },
  { name: 'value_type', type: 'TEXT', description: 'Value type (default: text)' },
  { name: 'line_number', type: 'INTEGER', description: 'Line number' },
];

export const TABLE_ROWS_COLUMNS: SchemaColumnDoc[] = [
  { name: 'path', type: 'TEXT', description: 'File path' },
  { name: 'table_index', type: 'INTEGER', description: 'Table index' },
  { name: 'row_index', type: 'INTEGER', defaultVal: 'auto', description: 'MAX(row_index)+1 or 0 if none exist' },
  { name: 'row_json', type: 'TEXT', description: 'Row data as JSON object' },
];
