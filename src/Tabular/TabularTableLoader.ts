import type { Database } from 'sql.js';
import type { TabularColumn, TabularDocument, TabularFormat, TabularValue } from './TabularTypes';
import { DataFileError } from './TabularTypes';
import { validateCsvHeaders } from './CsvCodec';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';

function columnSql(column: TabularColumn, csv: boolean): string {
  const name = quoteIdentifier(column.name);
  const noNul = `instr(${name}, CAST(x'00' AS TEXT)) = 0`;

  if (column.type === 'TEXT' && csv) {
    return `${name} TEXT NOT NULL DEFAULT '' CHECK (typeof(${name}) = 'text') CONSTRAINT "_vq_csv_no_nul" CHECK (${noNul})`;
  }

  const storage = column.type === 'BOOLEAN' ? 'INTEGER' : column.type === 'JSON' ? 'TEXT' : column.type;
  const value = `typeof(${name})`;

  const check = column.type === 'TEXT' ? `${value} = 'text' AND ${noNul}`
    : column.type === 'BOOLEAN' ? `${name} IN (0, 1)`
    : column.type === 'JSON' ? `json_valid(${name})`
    : column.type === 'REAL' ? `${value} IN ('real', 'integer')`
    : `${value} = 'integer'`;

  return `${name} ${storage} CHECK (${name} IS NULL OR (${check}))`;
}

export function tabularTableSql(document: Pick<TabularDocument, 'path' | 'columns' | 'format'>): string {
  const definitions = document.columns.map(column => columnSql(column, document.format.kind === 'csv'));

  return `CREATE TABLE main.${quoteIdentifier(document.path)} ("_vq_row_id" INTEGER PRIMARY KEY AUTOINCREMENT, ${definitions.join(', ')})`;
}

export const nullableColumn = (column: TabularColumn, format: Pick<TabularFormat, 'kind'>): boolean => column.type !== 'TEXT' || format.kind !== 'csv';

function validateValue(path: string, column: TabularColumn, value: TabularValue, nullable: boolean): void {
  if (value === null) {
    if (!nullable) throw new DataFileError(path, 'format', 'CSV fields cannot be NULL.');

    return;
  }

  if (column.type === 'TEXT' || column.type === 'JSON') {
    if (typeof value !== 'string') throw new DataFileError(path, 'format', `The ${column.name} column holds text.`);
    if (value.includes('\0')) throw new DataFileError(path, 'format', 'NUL characters are not supported in indexed data files.');

    return;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DataFileError(path, 'format', `The ${column.name} column holds numbers.`);
  if (column.type === 'INTEGER' && !Number.isSafeInteger(value)) throw new DataFileError(path, 'format', `The ${column.name} column holds whole numbers.`);
  if (column.type === 'BOOLEAN' && value !== 0 && value !== 1) throw new DataFileError(path, 'format', `The ${column.name} column holds true or false.`);
}

function validateDocument(document: TabularDocument): void {
  const { path, columns, rows } = document;
  if (document.format.kind === 'csv') validateCsvHeaders(columns.map(column => column.name), path);

  for (const row of rows) {
    if (row.length !== columns.length) throw new DataFileError(path, 'format', 'Each indexed record must match the columns.');

    row.forEach((value, index) => validateValue(path, columns[index], value, nullableColumn(columns[index], document.format)));
  }
}

/** Caller owns the lock, transaction, relation ownership and write guards. */
export function loadTabularTable(database: Database, document: TabularDocument): void {
  validateDocument(document);
  database.run(tabularTableSql(document));
  const names = document.columns.map(column => quoteIdentifier(column.name));
  const insert = database.prepare(`INSERT INTO main.${quoteIdentifier(document.path)} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);

  try {
    for (const row of document.rows) {
      insert.run(row as TabularValue[]);
    }
  }
  finally {
    insert.free();
  }
}
