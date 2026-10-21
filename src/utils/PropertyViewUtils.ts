export interface PropertyColumn {
  columnName: string;
  keys: string[];
}

export function getPropertyColumns(propertyKeys: string[]): PropertyColumn[] {
  const columns = new Map<string, PropertyColumn>();

  for (const key of propertyKeys) {
    const columnName = key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() || 'property';
    const existing = columns.get(columnName);
    if (existing) existing.keys.push(key);
    else columns.set(columnName, { columnName, keys: [key] });
  }

  return Array.from(columns.values());
}

export function propertyViewKey(columns: PropertyColumn[], columnName: string): string {
  const keys = columns.find(column => column.columnName === columnName)?.keys;

  if (!keys || keys.length !== 1) {
    throw new Error(`Property column "${columnName}" has no unique frontmatter key. Write to properties using the exact key instead.`);
  }

  return keys[0];
}

export const LIST_PROPERTY_KEYS = new Set(['tags', 'aliases', 'cssclasses']);

export function parsePropertyViewValue(value: string, isList: boolean): string | unknown[] {
  const list = parseJsonList(value);
  if (list) return list;

  return isList ? value.split(',').map(part => part.trim()).filter(part => part.length > 0) : value;
}

function parseJsonList(value: string): unknown[] | null {
  if (!value.trimStart().startsWith('[')) return null;

  try {
    const parsed: unknown = JSON.parse(value);

    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface PropertyListShapeRow {
  path: string;
  key: string;
  is_list: number;
}

export function propertyListShapes(rows: PropertyListShapeRow[]): (path: string, key: string) => boolean {
  const byNote = new Map<string, boolean>();
  const seen = new Set<string>();
  const listKeys = new Set<string>();

  for (const row of rows) {
    byNote.set(`${row.path}\0${row.key}`, row.is_list === 1);
    seen.add(row.key);
    if (row.is_list === 1) listKeys.add(row.key);
  }

  return (path, key) => byNote.get(`${path}\0${key}`) ?? (listKeys.has(key) || (!seen.has(key) && LIST_PROPERTY_KEYS.has(key)));
}
