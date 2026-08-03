import type { Statement } from 'sql.js';

type StatementRow = Record<string, unknown>;
type StatementParam = string | number | null | Uint8Array;
type MultiRowInsertRunner = (sql: string, params: StatementParam[]) => void;

export function collectStatementRows(stmt: Statement): StatementRow[] {
  const results: StatementRow[] = [];
  const columnNames = stmt.getColumnNames();

  while (stmt.step()) {
    const values = stmt.get();
    results.push(rowFromStatementValues(columnNames, values));
  }

  return results;
}

export function runPreparedStatement(stmt: Statement, params: StatementParam[] = [], onResetError?: (error: unknown) => void): void {
  try {
    if (params.length > 0) {
      stmt.bind(params);
    }
    stmt.step();
    stmt.reset();
  }
  catch (error) {
    resetStatement(stmt, onResetError);
    throw error;
  }
}

export function queryStatementRows(stmt: Statement, params: StatementParam[] = [], onResetError?: (error: unknown) => void): StatementRow[] {
  try {
    if (params.length > 0) {
      stmt.bind(params);
    }
    const results = collectStatementRows(stmt);
    stmt.reset();
    return results;
  }
  catch (error) {
    resetStatement(stmt, onResetError);
    throw error;
  }
}

function getCachedMultiRowInsertSql(cache: Map<string, string>, baseSQL: string, columnsCount: number, rowCount: number): string {
  const cacheKey = `${baseSQL}\0${columnsCount}\0${rowCount}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const placeholder = `(${Array(columnsCount).fill('?').join(', ')})`;
  const sql = baseSQL + Array(rowCount).fill(placeholder).join(', ');
  cache.set(cacheKey, sql);
  return sql;
}

export function runMultiRowInsertBatches(
  cache: Map<string, string>,
  baseSQL: string,
  columnsCount: number,
  rows: StatementParam[][],
  maxRowsPerBatch: number,
  run: MultiRowInsertRunner
): void {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += maxRowsPerBatch) {
    const batch = rows.slice(i, i + maxRowsPerBatch);
    const sql = getCachedMultiRowInsertSql(cache, baseSQL, columnsCount, batch.length);
    const params = batch.flat();
    run(sql, params);
  }
}

function resetStatement(stmt: Statement, onResetError?: (error: unknown) => void): void {
  try {
    stmt.reset();
  }
  catch (error) {
    onResetError?.(error);
  }
}

function rowFromStatementValues(columnNames: string[], values: unknown[]): StatementRow {
  const row: StatementRow = {};

  for (let i = 0; i < columnNames.length; i++) {
    const colName = columnNames[i];
    if (!(colName in row)) {
      row[colName] = values[i];
    }
  }

  return row;
}
