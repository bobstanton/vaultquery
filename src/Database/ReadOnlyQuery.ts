import type { Database } from 'sql.js';
import { isSelectOnly } from '../utils/SQLParsingUtils';

export function enterReadOnlyQuery(db: Database, sql: string): () => void {
  if (!isSelectOnly(sql)) throw new Error('Read-only queries require a single SELECT without trigger actions.');

  return enterReadOnlyScope(db);
}

export function enterReadOnlyScope(db: Database): () => void {
  const wasReadOnly = db.exec('PRAGMA query_only')[0]?.values[0]?.[0] === 1;
  if (!wasReadOnly) db.run('PRAGMA query_only = ON');
  let released = false;

  return () => {
    if (released) return;
    released = true;
    if (!wasReadOnly) db.run('PRAGMA query_only = OFF');
  };
}

export function withReadOnlyQuery<T>(db: Database, sql: string, read: () => T): T {
  const release = enterReadOnlyQuery(db, sql);

  try {
    return read();
  }
  finally {
    release();
  }
}
