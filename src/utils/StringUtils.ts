export { fast1a32hex as hashString } from 'fnv-plus';

/** Separator used for compound keys (e.g., path@@table_index) */
const KEY_SEPARATOR = '@@';

export function createTableKey(path: string, tableIndex: number): string {
  return `${path}${KEY_SEPARATOR}${tableIndex}`;
}

export function parseTableKey(key: string): { path: string; tableIndex: number } {
  const [path, tableIndexStr] = key.split(KEY_SEPARATOR);
  return { path, tableIndex: parseInt(tableIndexStr, 10) };
}

export function createRowColumnKey(rowIndex: number, columnName: string): string {
  return `${rowIndex}${KEY_SEPARATOR}${columnName}`;
}

export function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index++;
  }
  return index;
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
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const array = new Uint32Array(2);
  crypto.getRandomValues(array);
  const random = array[0].toString(36) + array[1].toString(36);

  return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
}
