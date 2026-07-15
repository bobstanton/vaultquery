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
