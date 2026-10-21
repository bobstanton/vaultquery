import { validateCsvHeaders } from './CsvCodec';
import { checkDataFileSize, dataFileParseLimits, dataFileUtf8ByteLength } from './TabularLimits';
import { DataFileError } from './TabularTypes';
import type { JsonFormat, RowOrigins, TabularColumn, TabularColumnType, TabularDocument, TabularParseLimits, TabularRows, TabularValue } from './TabularTypes';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function widen(current: TabularColumnType | undefined, next: TabularColumnType): TabularColumnType {
  if (current === undefined || current === next) return next;
  if ((current === 'INTEGER' && next === 'REAL') || (current === 'REAL' && next === 'INTEGER')) return 'REAL';

  return 'JSON';
}

function valueType(value: JsonValue): TabularColumnType {
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'string') return 'TEXT';

  return 'JSON';
}

function storedValue(value: JsonValue | undefined, type: TabularColumnType, path: string): TabularValue {
  if (value === undefined || value === null) return null;

  if (type === 'JSON') return JSON.stringify(value);
  if (type === 'TEXT') return typeof value === 'string' ? value : JSON.stringify(value);
  if (type === 'BOOLEAN') return value === true ? 1 : 0;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DataFileError(path, 'format', 'Numbers must be finite; NaN and Infinity are not valid JSON.');
  }

  return value;
}

function parseSource(source: string, path: string): JsonValue {
  try {
    return JSON.parse(source) as JsonValue;
  }
  catch (error) {
    throw new DataFileError(path, 'format', error instanceof Error ? error.message : String(error));
  }
}

const isRecord = (value: JsonValue): value is { [key: string]: JsonValue } => typeof value === 'object' && value !== null && !Array.isArray(value);

function selectRows(root: JsonValue, path: string): { rows: JsonValue[]; property: string | null } {
  if (Array.isArray(root)) return { rows: root, property: null };

  if (isRecord(root)) {
    const arrays = Object.entries(root).filter((entry): entry is [string, JsonValue[]] => Array.isArray(entry[1]));
    if (arrays.length === 1) return { rows: arrays[0][1], property: arrays[0][0] };

    if (arrays.length > 1) {
      throw new DataFileError(path, 'format', `Several properties hold arrays (${arrays.map(entry => entry[0]).join(', ')}); a table needs one.`);
    }
  }

  throw new DataFileError(path, 'format', 'A JSON table needs an array of rows, either at the root or as the single array property of an object.');
}

function detectIndent(source: string): string {
  const match = /[[{]\s*?\r?\n([ \t]+)/.exec(source);

  return match ? match[1] : '';
}

/** Whether a whole-number literal is past 2^53, where JSON.parse rounds it. Any such literal has at least 16 digits. */
function hasUnsafeIntegers(source: string): boolean {
  if (!/\d{16}/.test(source)) return false;
  const numbers = source.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];

  return numbers.some(literal => /^-?\d+$/.test(literal) && !Number.isSafeInteger(Number(literal)));
}

export function parseJson(source: string, path: string, limits: TabularParseLimits = dataFileParseLimits()): TabularDocument {
  const sourceBytes = dataFileUtf8ByteLength(source, path);
  checkDataFileSize(path, sourceBytes, limits);
  const bom = source.startsWith('\ufeff');
  const input = bom ? source.slice(1) : source;
  const { rows: entries, property } = selectRows(parseSource(input, path), path);
  const scalarRows = entries.every(entry => !isRecord(entry));
  const types = new Map<string, TabularColumnType>();
  const names = new Set<string>();

  const observe = (key: string, value: JsonValue): void => {
    names.add(key);
    if (value !== null) types.set(key, widen(types.get(key), valueType(value)));
  };

  for (const entry of entries) {
    if (scalarRows) { observe('value', entry); continue; }
    if (!isRecord(entry)) throw new DataFileError(path, 'format', 'Rows must either all be objects or all be scalars.');

    for (const [key, value] of Object.entries(entry)) {
      observe(key, value);
    }

    if (names.size > limits.maxColumns) throw new DataFileError(path, 'format', `A table is limited to ${limits.maxColumns} columns.`);
  }

  const order = [...names];
  if (!order.length) throw new DataFileError(path, 'format', 'The JSON array contains no columns.');
  validateCsvHeaders(order, path);
  const columns: TabularColumn[] = order.map(name => ({ name, type: types.get(name) ?? 'TEXT' }));

  const rows = entries.map(entry => columns.map(column => storedValue(scalarRows ? entry : (entry as { [key: string]: JsonValue })[column.name], column.type, path)));

  const format: JsonFormat = { kind: 'json', bom, indent: detectIndent(input), newline: input.includes('\r\n') ? '\r\n' : '\n', terminalNewline: input.endsWith('\n'),
    root: property, scalarRows, unsafeIntegers: hasUnsafeIntegers(input) };

  return { path, columns, rows, format, source, sourceBytes };
}

export function serializeJson(document: TabularDocument, rows: TabularRows, limits: TabularParseLimits = dataFileParseLimits(), origins: RowOrigins = []): string {
  const { path, columns, format } = document;
  if (format.kind !== 'json') throw new DataFileError(path, 'format', 'This document was not read from a JSON file.');
  if (format.unsafeIntegers) throw new DataFileError(path, 'format', 'This file is read-only because writing whole numbers past 2^53 would lose precision.');
  const root = parseSource(format.bom ? document.source.slice(1) : document.source, path);
  const originals = rowsAt(root, format.root, path);

  const entries = rows.map((row, index): JsonValue => {
    if (row.length !== columns.length) throw new DataFileError(path, 'format', 'A prepared record does not match the column count.');
    const origin = origins[index] ?? null;
    const stored = origin === null ? undefined : document.rows[origin];
    const original = stored === undefined ? undefined : originals[origin!];
    const unchanged = (column: number): boolean => stored !== undefined && original !== undefined && stored[column] === row[column];
    if (format.scalarRows) return unchanged(0) ? original! : jsonValue(path, columns[0], row[0]);
    const entry = Object.assign(Object.create(null) as Record<string, JsonValue>, original !== undefined && isRecord(original) ? original : {});

    columns.forEach((column, position) => {
      if (unchanged(position)) return;
      const value = row[position];
      if (value !== null) entry[column.name] = jsonValue(path, column, value);
      else if (Object.prototype.hasOwnProperty.call(entry, column.name)) entry[column.name] = null;
    });

    return entry;
  });

  const output = format.root === null ? entries : { ...root as Record<string, JsonValue>, [format.root]: entries };
  const text = JSON.stringify(output, null, format.indent) + (format.terminalNewline ? '\n' : '');
  const framed = (format.bom ? '\ufeff' : '') + (format.newline === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
  checkDataFileSize(path, dataFileUtf8ByteLength(framed, path), limits);

  return framed;
}

function jsonValue(path: string, column: TabularColumn, value: TabularValue): JsonValue {
  if (value === null) return null;

  if (column.type === 'JSON') {
    if (typeof value !== 'string') throw new DataFileError(path, 'format', `The ${column.name} column holds JSON text.`);

    try {
      return JSON.parse(value) as JsonValue;
    }
    catch {
      throw new DataFileError(path, 'format', `The ${column.name} column holds JSON text; this value is not valid JSON.`);
    }
  }

  if (column.type === 'BOOLEAN') {
    if (value !== 0 && value !== 1) throw new DataFileError(path, 'format', `The ${column.name} column holds true or false.`);

    return value === 1;
  }

  if (column.type === 'TEXT') {
    if (typeof value !== 'string') throw new DataFileError(path, 'format', `The ${column.name} column holds text.`);

    return value;
  }

  if (typeof value !== 'number') throw new DataFileError(path, 'format', `The ${column.name} column holds numbers.`);

  return value;
}

function rowsAt(root: JsonValue, property: string | null, path: string): JsonValue[] {
  const rows = property === null ? root : isRecord(root) ? root[property] : undefined;
  if (!Array.isArray(rows)) throw new DataFileError(path, 'source-changed', property === null ? 'The file no longer holds an array of rows.' : `The ${property} property no longer holds the rows.`);

  return rows;
}
