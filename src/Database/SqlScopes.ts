import type { Database, SqlValue } from 'sql.js';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';

export function readRows(db: Database, sql: string, params: SqlValue[] = []): SqlValue[][] {
  return db.exec(sql, params)[0]?.values ?? [];
}

export function withSavepoint<T>(db: Database, name: string, work: () => T, rollback = false): T {
  const identifier = quoteIdentifier(name);
  db.run(`SAVEPOINT ${identifier}`);
  let result: T;

  try {
    result = work();
  } catch (error) {
    try {
      db.run(`ROLLBACK TO ${identifier}`);
      db.run(`RELEASE ${identifier}`);
    } catch {
      // Preserve the original work error if rollback or savepoint release also fails.
    }

    throw error;
  }

  if (rollback) db.run(`ROLLBACK TO ${identifier}`);
  db.run(`RELEASE ${identifier}`);

  return result;
}
