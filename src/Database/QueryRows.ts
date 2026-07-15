export function queryRows<T>(execValues: (sql: string) => unknown[][], sql: string, mapRow: (row: unknown[]) => T): T[] {
  return execValues(sql).map(mapRow);
}
