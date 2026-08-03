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
  'date', 'time', 'datetime', 'julianday', 'strftime', 'now',
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
  { name: 'regexp', args: ['pattern', 'text'], detail: 'True when text matches the regular expression; backs the REGEXP operator', scope: 'query' },
  { name: 'regexp_replace', args: ['text', 'pattern', 'replacement'], detail: 'Replace every regular-expression match; the replacement honours \\n, \\t, \\r, \\\\', scope: 'query' },

  { name: 'link', args: ['path'], detail: 'Wiki link to a note', scope: 'query' },
  { name: 'link', args: ['path', 'display'], detail: 'Wiki link to a note with display text', scope: 'query' },
  { name: 'link_heading', args: ['path', 'heading'], detail: 'Wiki link to a heading within a note', scope: 'query' },
  { name: 'link_heading', args: ['path', 'heading', 'display'], detail: 'Wiki link to a heading, with display text', scope: 'query' },
  { name: 'link_block', args: ['path', 'block_id'], detail: 'Wiki link to a block reference', scope: 'query' },
  { name: 'link_block', args: ['path', 'block_id', 'display'], detail: 'Wiki link to a block reference, with display text', scope: 'query' },
  { name: 'resolve_link', args: ['wikilink'], detail: 'Resolve a wiki link to a vault path using vault-wide search', scope: 'query' },
  { name: 'resolve_link', args: ['wikilink', 'source_path'], detail: 'Resolve a wiki link relative to a source note path', scope: 'query' },

  { name: 'filename', args: ['path'], detail: 'Filename with extension', scope: 'query' },
  { name: 'path_name', args: ['path'], detail: 'Filename with extension', scope: 'query' },
  { name: 'path_basename', args: ['path'], detail: 'Filename without extension', scope: 'query' },
  { name: 'path_extension', args: ['path'], detail: 'Extension without the dot', scope: 'query' },
  { name: 'path_parent', args: ['path'], detail: 'Parent folder path', scope: 'query' },

  { name: 'parse_date', args: ['text'], detail: 'Parse a date out of free text; NULL when nothing parses', scope: 'query' },
  { name: 'format_date', args: ['date', 'format'], detail: 'Format a date with strftime-style specifiers, e.g. \'%B %e, %Y\'', scope: 'query' },

  { name: 'geo_lat', args: ['text'], detail: 'Latitude from a coordinate string', scope: 'query' },
  { name: 'geo_lng', args: ['text'], detail: 'Longitude from a coordinate string', scope: 'query' },
  { name: 'geo_distance_mi', args: ['lat1', 'lng1', 'lat2', 'lng2'], detail: 'Distance between two coordinates, in miles', scope: 'query' },
  { name: 'geo_distance_km', args: ['lat1', 'lng1', 'lat2', 'lng2'], detail: 'Distance between two coordinates, in kilometers', scope: 'query' },

  { name: 'vq_set_property', args: ['path', 'key', 'value'], detail: 'Set a frontmatter property', scope: 'trigger' },
  { name: 'vq_remove_property', args: ['path', 'key'], detail: 'Remove a frontmatter property', scope: 'trigger' },
  { name: 'vq_rename_note', args: ['path', 'new_name'], detail: 'Rename a note, keeping it in the same folder', scope: 'trigger' },
  { name: 'vq_set_content', args: ['path', 'content'], detail: 'Replace entire file content, preserving frontmatter', scope: 'trigger' },
  { name: 'vq_replace_content', args: ['path', 'search', 'replacement'], detail: 'Replace text in file content', scope: 'trigger' },
  { name: 'vq_sync_content', args: ['path'], detail: 'Flush pending content changes for a note', scope: 'trigger' },
  { name: 'vq_create_note', args: ['path', 'content'], detail: 'Create a note, including parent folders; no-op when it exists', scope: 'trigger' },
  { name: 'vq_notify', args: ['message'], detail: 'Show an Obsidian notification', scope: 'trigger' },
  { name: 'vq_log', args: ['message'], detail: 'Log to the developer console', scope: 'trigger' },
  { name: 'vq_debounce', args: ['key', 'ms'], detail: 'Leading-edge debounce for a WHEN clause; 1 once ms has passed since the last call', scope: 'trigger' },
  { name: 'vq_defer', args: ['key', 'ms'], detail: 'Trailing-edge debounce; call first in the body to defer the rest until idle', scope: 'trigger' },

  { name: 'vq_complete_task', args: ['path', 'line_number'], detail: 'Mark a task done', scope: 'trigger' },
  { name: 'vq_uncomplete_task', args: ['path', 'line_number'], detail: 'Mark a task todo', scope: 'trigger' },
  { name: 'vq_set_task_status', args: ['path', 'line_number', 'status'], detail: 'Set task status (DONE, TODO, IN_PROGRESS, …)', scope: 'trigger' },
  { name: 'vq_set_task_text', args: ['path', 'line_number', 'text'], detail: 'Update task text, preserving the checkbox', scope: 'trigger' },
  { name: 'vq_add_task', args: ['path', 'text', 'after_line'], detail: 'Add a task after a line; 0 inserts at the start of the file', scope: 'trigger' },
  { name: 'vq_delete_task', args: ['path', 'line_number'], detail: 'Delete a task', scope: 'trigger' },

  { name: 'vq_set_heading_text', args: ['path', 'line_number', 'text'], detail: 'Update heading text, preserving its level', scope: 'trigger' },
  { name: 'vq_set_heading_level', args: ['path', 'line_number', 'level'], detail: 'Change heading level (1-6)', scope: 'trigger' },
  { name: 'vq_add_heading', args: ['path', 'level', 'text', 'after_line'], detail: 'Add a heading after a line', scope: 'trigger' },
  { name: 'vq_delete_heading', args: ['path', 'line_number'], detail: 'Delete a heading', scope: 'trigger' },

  { name: 'vq_set_list_item_text', args: ['path', 'line_number', 'text'], detail: 'Update list item text, preserving the marker', scope: 'trigger' },
  { name: 'vq_add_list_item', args: ['path', 'text', 'after_line'], detail: 'Add a list item after a line', scope: 'trigger' },
  { name: 'vq_delete_list_item', args: ['path', 'line_number'], detail: 'Delete a list item', scope: 'trigger' },

  { name: 'vq_add_table_row', args: ['path', 'table_index', 'values_json'], detail: 'Add a table row; values_json maps column names to values', scope: 'trigger' },
  { name: 'vq_set_table_cell', args: ['path', 'table_index', 'row_index', 'column_name', 'value'], detail: 'Update a table cell; row_index is 0-based over data rows', scope: 'trigger' },
  { name: 'vq_delete_table_row', args: ['path', 'table_index', 'row_index'], detail: 'Delete a table row; row_index is 0-based over data rows', scope: 'trigger' },
];
