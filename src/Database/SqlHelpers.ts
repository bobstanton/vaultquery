import type { SqlParameter as SqlParam } from './QueryValues';
import { queryRowBytes } from './QueryValues';

export interface SqlStatement {
  sql: string;
  params: SqlParam[];
}

interface SqlRunner {
  run(sql: string, params?: SqlParam[]): Promise<number>;
}

interface SqlReader {
  all(sql: string, params?: SqlParam[]): Promise<Record<string, unknown>[]>;
}

export const PROVIDER_UPSERT_BATCH_SIZE = 100;

export function sqlInsertBatchSize(columnCount: number, maxRows = PROVIDER_UPSERT_BATCH_SIZE): number {
  return Math.max(1, Math.min(maxRows, Math.floor(30_000 / columnCount)));
}

export async function insertRowsChunked(
  database: SqlRunner,
  buildInsertSql: (placeholders: string) => string,
  paramRows: Iterable<readonly SqlParam[]>,
  columnCount: number,
  options: { maxRows?: number; maxBytes?: number } = {},
): Promise<void> {
  const rowPlaceholder = `(${Array.from({ length: columnCount }, () => '?').join(', ')})`;
  const maxRows = sqlInsertBatchSize(columnCount, options.maxRows), maxBytes = options.maxBytes ?? 1024 * 1024;
  let params: SqlParam[] = [], rows = 0, bytes = 0;

  const flush = async () => {
    if (!rows) return;
    await database.run(buildInsertSql(Array(rows).fill(rowPlaceholder).join(', ')), params);
    params = []; rows = 0; bytes = 0;
  };

  for (const row of paramRows) {
    const rowBytes = queryRowBytes(row) + 64 + row.length * 16;

    if (rows && (rows >= maxRows || bytes + rowBytes > maxBytes)) await flush();
    params.push(...row); rows++; bytes += rowBytes;
  }

  await flush();
}

export interface RelationExistsOptions {
  matchViewsCaseInsensitive?: boolean;
}

export async function relationExists(database: SqlReader, name: string, options: RelationExistsOptions = { }): Promise<boolean> {
  const rows = options.matchViewsCaseInsensitive
    ? await database.all(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = ? LIMIT 1",
        [name.toLowerCase()]
      )
    : await database.all(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [name]
      );

  return rows.length > 0;
}
