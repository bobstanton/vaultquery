type SqlParam = string | number | null;

interface SqlRunner {
  run(sql: string, params?: SqlParam[]): Promise<number>;
}

interface SqlReader {
  all(sql: string, params?: SqlParam[]): Promise<Record<string, unknown>[]>;
}

export const PROVIDER_UPSERT_BATCH_SIZE = 100;

export async function insertRowsChunked(
  database: SqlRunner,
  buildInsertSql: (placeholders: string) => string,
  paramRows: SqlParam[][],
  columnCount: number
): Promise<void> {
  const rowPlaceholder = `(${Array.from({ length: columnCount }, () => '?').join(', ')})`;

  for (let offset = 0; offset < paramRows.length; offset += PROVIDER_UPSERT_BATCH_SIZE) {
    const batch = paramRows.slice(offset, offset + PROVIDER_UPSERT_BATCH_SIZE);
    const placeholders = batch.map(() => rowPlaceholder).join(', ');
    await database.run(buildInsertSql(placeholders), batch.flat());
  }
}

export interface RelationExistsOptions {
  matchViewsCaseInsensitive?: boolean;
}

export async function relationExists(
  database: SqlReader,
  name: string,
  options: RelationExistsOptions = {}
): Promise<boolean> {
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
