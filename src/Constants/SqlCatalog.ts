export const SQL_KEYWORD_TOKENS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
  'like', 'between', 'exists', 'case', 'when', 'then', 'else', 'end',
  'as', 'on', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full',
  'union', 'all', 'distinct', 'group', 'by', 'having', 'order', 'asc', 'desc',
  'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'create', 'table', 'drop', 'alter', 'index', 'primary', 'key', 'foreign',
  'references', 'constraint', 'default', 'check', 'unique', 'cascade',
  'with', 'recursive', 'over', 'partition', 'row', 'rows', 'range',
  'preceding', 'following', 'unbounded', 'current', 'first', 'last',
  'nulls', 'filter', 'window', 'lateral', 'natural', 'using',
  'view', 'trigger',
]);

export const SQL_FUNCTION_TOKENS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'cast',
  'substr', 'substring', 'length', 'upper', 'lower', 'trim', 'ltrim', 'rtrim',
  'replace', 'instr', 'printf', 'typeof', 'abs', 'round', 'random',
  'date', 'time', 'datetime', 'julianday', 'strftime',
  'ifnull', 'iif', 'glob', 'hex', 'quote', 'zeroblob',
  'total', 'group_concat', 'json', 'json_extract', 'json_array', 'json_object',
]);

export const SQL_TYPE_TOKENS = new Set([
  'integer', 'int', 'real', 'text', 'blob', 'numeric', 'boolean', 'varchar',
  'char', 'float', 'double', 'decimal', 'date', 'datetime', 'timestamp',
]);

export const SQL_COMPLETION_KEYWORD_PHRASES = [
  'SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'INNER JOIN', 'CROSS JOIN', 'ON', 'AS', 'DISTINCT',
  'UNION', 'UNION ALL', 'INSERT INTO', 'UPDATE', 'DELETE FROM',
  'CREATE VIEW', 'CREATE TRIGGER', 'WITH',
];

export const SQL_PHRASE_LEAD_WORDS: ReadonlySet<string> = new Set(
  SQL_COMPLETION_KEYWORD_PHRASES
    .filter((phrase) => phrase.includes(' '))
    .map((phrase) => phrase.split(' ')[0].toLowerCase())
);

export type SqlFunctionScope = 'query' | 'trigger';

export interface SqlFunctionSignature {
  name: string;
  args: string[];
  detail: string;
  scope: SqlFunctionScope;
}

export const VAULTQUERY_FUNCTION_SIGNATURES: readonly SqlFunctionSignature[] = [
  { name: 'parse_number', args: ['value'], detail: 'Extract one number without converting units; NULL for invalid values', scope: 'query' },
  { name: 'convert_distance', args: ['value', 'target_unit'], detail: 'Convert a distance with an explicit unit to mm, cm, m, km, in, ft, yd or mi; NULL for bare numbers or unknown units', scope: 'query' },
  { name: 'convert_distance', args: ['value', 'target_unit', 'bare_unit'], detail: 'Convert a distance; use bare_unit when the input has no unit suffix', scope: 'query' },
  { name: 'regexp', args: ['pattern', 'text'], detail: 'Returns 1 for a match; uses JavaScript regular expressions', scope: 'query' },
  { name: 'regexp_replace', args: ['text', 'pattern', 'replacement'], detail: 'Replace all matches; accepts \\n, \\t, \\r and \\\\ in replacement', scope: 'query' },

  { name: 'link', args: ['path'], detail: 'Internal link to a note', scope: 'query' },
  { name: 'link', args: ['path', 'display'], detail: 'Internal link to a note with display text', scope: 'query' },
  { name: 'link_heading', args: ['path', 'heading'], detail: 'Internal link to a heading within a note', scope: 'query' },
  { name: 'link_heading', args: ['path', 'heading', 'display'], detail: 'Internal link to a heading, with display text', scope: 'query' },
  { name: 'link_block', args: ['path', 'block_id'], detail: 'Internal link to a block reference', scope: 'query' },
  { name: 'link_block', args: ['path', 'block_id', 'display'], detail: 'Internal link to a block reference, with display text', scope: 'query' },
  { name: 'resolve_link', args: ['wikilink'], detail: 'Resolve a wiki link to a vault path using vault-wide search', scope: 'query' },
  { name: 'resolve_link', args: ['wikilink', 'source_path'], detail: 'Resolve a wiki link relative to a source note path', scope: 'query' },

  { name: 'filename', args: ['path'], detail: 'Same as path_name; includes the extension', scope: 'query' },
  { name: 'path_name', args: ['path'], detail: 'Filename with extension', scope: 'query' },
  { name: 'path_basename', args: ['path'], detail: 'Filename without extension', scope: 'query' },
  { name: 'path_extension', args: ['path'], detail: 'Extension without the dot', scope: 'query' },
  { name: 'path_parent', args: ['path'], detail: 'Parent folder path; empty when no / is present', scope: 'query' },

  { name: 'parse_date', args: ['text'], detail: 'Extract a date as YYYY-MM-DD; NULL when no date is found', scope: 'query' },
  { name: 'format_date', args: ['date', 'format'], detail: 'Format a YYYY-MM-DD or YYYYMMDD date; e.g. %B %e, %Y', scope: 'query' },

  { name: 'geo_lat', args: ['text'], detail: 'Latitude from lat,lng or lat lng text; NULL for invalid coordinates', scope: 'query' },
  { name: 'geo_lng', args: ['text'], detail: 'Longitude from lat,lng or lat lng text; NULL for invalid coordinates', scope: 'query' },
  { name: 'geo_distance_mi', args: ['lat1', 'lng1', 'lat2', 'lng2'], detail: 'Great-circle distance in miles', scope: 'query' },
  { name: 'geo_distance_km', args: ['lat1', 'lng1', 'lat2', 'lng2'], detail: 'Great-circle distance in kilometers', scope: 'query' },

  { name: 'vq_set_property', args: ['path', 'key', 'value'], detail: 'Set a frontmatter property', scope: 'trigger' },
  { name: 'vq_remove_property', args: ['path', 'key'], detail: 'Remove a frontmatter property', scope: 'trigger' },
  { name: 'vq_rename_note', args: ['path', 'new_name'], detail: 'Rename a note, keeping it in the same folder', scope: 'trigger' },
  { name: 'vq_set_content', args: ['path', 'content'], detail: 'Replace the note body, preserving frontmatter', scope: 'trigger' },
  { name: 'vq_replace_content', args: ['path', 'search', 'replacement'], detail: 'Replace all literal matches, including in frontmatter', scope: 'trigger' },
  { name: 'vq_sync_content', args: ['path'], detail: 'Write notes.content to the note body', scope: 'trigger' },
  { name: 'vq_create_note', args: ['path', 'content'], detail: 'Create a note and parent folders; keep an existing note unchanged', scope: 'trigger' },
  { name: 'vq_notify', args: ['message'], detail: 'Show an Obsidian notification', scope: 'trigger' },
  { name: 'vq_log', args: ['message'], detail: 'Write a message to the VaultQuery debug log', scope: 'trigger' },
  { name: 'vq_debounce', args: ['key', 'ms'], detail: 'Return 1 on the first call, then after ms milliseconds since the last accepted call for that key', scope: 'trigger' },
  { name: 'vq_defer', args: ['key', 'ms'], detail: 'Call first to delay queued actions until ms milliseconds after the last call for this key', scope: 'trigger' },

  { name: 'vq_complete_task', args: ['path', 'line_number'], detail: 'Set status to DONE; preserve task text and metadata', scope: 'trigger' },
  { name: 'vq_uncomplete_task', args: ['path', 'line_number'], detail: 'Set status to TODO; preserve task text and metadata', scope: 'trigger' },
  { name: 'vq_set_task_status', args: ['path', 'line_number', 'status'], detail: 'Accepts TODO, DONE, IN_PROGRESS or CANCELLED', scope: 'trigger' },
  { name: 'vq_set_task_text', args: ['path', 'line_number', 'text'], detail: 'Update task text, preserving the checkbox', scope: 'trigger' },
  { name: 'vq_add_task', args: ['path', 'text', 'after_line'], detail: 'Add a task after a line; 0 inserts at the start of the file', scope: 'trigger' },
  { name: 'vq_delete_task', args: ['path', 'line_number'], detail: 'Delete only the task line', scope: 'trigger' },

  { name: 'vq_set_heading_text', args: ['path', 'line_number', 'text'], detail: 'Update heading text, preserving its level', scope: 'trigger' },
  { name: 'vq_set_heading_level', args: ['path', 'line_number', 'level'], detail: 'Change heading level (1-6)', scope: 'trigger' },
  { name: 'vq_add_heading', args: ['path', 'level', 'text', 'after_line'], detail: 'Add after a line; 0 inserts at the start; level is limited to 1-6', scope: 'trigger' },
  { name: 'vq_delete_heading', args: ['path', 'line_number'], detail: 'Delete the heading line; keep its section content', scope: 'trigger' },

  { name: 'vq_set_list_item_text', args: ['path', 'line_number', 'text'], detail: 'Update list item text, preserving the marker', scope: 'trigger' },
  { name: 'vq_add_list_item', args: ['path', 'text', 'after_line'], detail: 'Add a bullet item after a line; 0 inserts at the start', scope: 'trigger' },
  { name: 'vq_delete_list_item', args: ['path', 'line_number'], detail: 'Delete only the item line; keep nested items', scope: 'trigger' },

  { name: 'vq_add_table_row', args: ['path', 'table_index', 'values_json'], detail: 'Append a row; values_json maps column names to strings; table_index starts at 0', scope: 'trigger' },
  { name: 'vq_set_table_cell', args: ['path', 'table_index', 'row_index', 'column_name', 'value'], detail: 'Update a cell; table_index and data-row row_index start at 0', scope: 'trigger' },
  { name: 'vq_delete_table_row', args: ['path', 'table_index', 'row_index'], detail: 'Delete a row; table_index and data-row row_index start at 0', scope: 'trigger' },
];
