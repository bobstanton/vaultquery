import type { Statement, QueryExecResult } from 'sql.js';

type StatementRow = Record<string, unknown>;
type StatementParam = string | number | null | Uint8Array;
type MultiRowInsertRunner = (sql: string, params: StatementParam[]) => void;

export function queryStatementValues(stmt: Statement, params: StatementParam[] = []): QueryExecResult[] {
  try {
    stmt.bind(params);
    const values: QueryExecResult['values'] = [];
    while (stmt.step()) values.push(stmt.get());

    return values.length ? [{ columns: stmt.getColumnNames(), values }] : [];
  } finally {
    stmt.reset();
  }
}

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
  withPreparedStatement(stmt, params, () => { stmt.step(); }, onResetError);
}

export function queryStatementRows(stmt: Statement, params: StatementParam[] = [], onResetError?: (error: unknown) => void): StatementRow[] {
  return withPreparedStatement(stmt, params, () => collectStatementRows(stmt), onResetError);
}

function withPreparedStatement<T>(stmt: Statement, params: StatementParam[], work: () => T, onResetError?: (error: unknown) => void): T {
  try {
    if (params.length > 0) {
      stmt.bind(params);
    }

    const results = work();
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

export function runMultiRowInsertBatches(cache: Map<string, string>, baseSQL: string, columnsCount: number, rows: StatementParam[][], maxRowsPerBatch: number, run: MultiRowInsertRunner): void {
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

export function rowFromStatementValues(columnNames: string[], values: unknown[]): StatementRow {
  const row: StatementRow = {};

  for (let i = 0; i < columnNames.length; i++) {
    const colName = columnNames[i];

    if (!Object.prototype.hasOwnProperty.call(row, colName)) {
      if (colName === '__proto__') {
        Object.defineProperty(row, colName, { value: values[i], enumerable: true, writable: true, configurable: true });
      }
      else row[colName] = values[i];
    }
  }

  return row;
}
