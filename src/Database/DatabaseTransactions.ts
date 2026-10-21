interface TransactionOperations {
  acquireLock: () => Promise<() => void>;
  beforeBegin?: () => void;
  execute: (sql: string) => void | Promise<unknown>;
  onRollbackError: (error: unknown) => void;
}

export async function runDatabaseTransaction<T>(operations: TransactionOperations, work: () => T | Promise<T>, deferFK = false): Promise<T> {
  const release = await operations.acquireLock();

  try {
    operations.beforeBegin?.();
    const begin = operations.execute('BEGIN TRANSACTION');
    if (begin) await begin;

    if (deferFK) {
      const pendingEnable = operations.execute('PRAGMA defer_foreign_keys = ON');
      if (pendingEnable) await pendingEnable;
    }

    try {
      const result = await work();

      if (deferFK) {
        const disable = operations.execute('PRAGMA defer_foreign_keys = OFF');
        if (disable) await disable;
      }

      const commit = operations.execute('COMMIT');
      if (commit) await commit;

      return result;
    }
    catch (error) {
      try {
        const rollback = operations.execute('ROLLBACK');
        if (rollback) await rollback;
      }
      catch (rollbackError) {
        operations.onRollbackError(rollbackError);
      }

      throw error;
    }
  }
  finally {
    release();
  }
}
