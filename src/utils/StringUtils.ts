export { fast1a32hex as hashString } from 'fnv-plus';

/**
 * Separator used for compound keys (e.g., path@@table_index)
 */
export const KEY_SEPARATOR = '@@';

/**
 * Create a table key from path and table_index
 */
export function createTableKey(path: string, tableIndex: number): string {
  return `${path}${KEY_SEPARATOR}${tableIndex}`;
}

/**
 * Parse a table key back to path and table_index
 */
export function parseTableKey(key: string): { path: string; tableIndex: number } {
  const [path, tableIndexStr] = key.split(KEY_SEPARATOR);
  return { path, tableIndex: parseInt(tableIndexStr, 10) };
}

/**
 * Create a cell key from path, table_index, row_index, and column_name
 */
export function createCellKey(path: string, tableIndex: number, rowIndex: number, columnName: string): string {
  return `${path}${KEY_SEPARATOR}${tableIndex}${KEY_SEPARATOR}${rowIndex}${KEY_SEPARATOR}${columnName}`;
}

/**
 * Create a row-column key from row_index and column_name
 */
export function createRowColumnKey(rowIndex: number, columnName: string): string {
  return `${rowIndex}${KEY_SEPARATOR}${columnName}`;
}

export function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function escapeRegex(text: string): string {
  return (text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function processEscapeSequences(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}

export function generateUniqueId(prefix = ''): string {
  const timestamp = Date.now();
  let random: string;

  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const array = new Uint32Array(2);
    crypto.getRandomValues(array);
    random = array[0].toString(36) + array[1].toString(36);
  }

  else {
    random = Math.random().toString(36).slice(2, 11);
  }

  return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
}
