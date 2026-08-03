import type { Database } from 'sql.js';
import type { StatementCache } from './StatementCache';
import type { MatRefreshSqlCache } from './SchemaOperations';

// Logic shared between the main-thread VaultDatabase and the database worker.
// Must stay free of Obsidian imports (directly or transitively): the worker
// bundle cannot load the 'obsidian' module.

export interface UserViewRow {
  view_name: string;
  path: string;
  sql: string;
}

export interface UserFunctionRow {
  function_name: string;
  path: string;
  source: string;
}

export interface UserTriggerRow {
  trigger_name: string;
  path: string;
  trigger_sql: string;
  enabled: number;
}

export function mapUserViewRow(row: unknown[]): UserViewRow {
  return {
    view_name: row[0] as string,
    path: row[1] as string,
    sql: row[2] as string
  };
}

export function mapUserFunctionRow(row: unknown[]): UserFunctionRow {
  return {
    function_name: row[0] as string,
    path: row[1] as string,
    source: row[2] as string
  };
}

export function mapUserTriggerRow(row: unknown[]): UserTriggerRow {
  return {
    trigger_name: row[0] as string,
    path: row[1] as string,
    trigger_sql: row[2] as string,
    enabled: row[3] as number
  };
}

export class DbLock {
  private tail: Promise<void> = Promise.resolve();

  public async acquire(): Promise<() => void> {
    let releaseLock: () => void;
    const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
    const previousLock = this.tail;
    this.tail = lockPromise;
    await previousLock;
    return releaseLock!;
  }
}

export interface ExportRuntimeState {
  statementCache: StatementCache;
  matRefreshSqlCache: MatRefreshSqlCache;
  registeredFunctionSources: ReadonlyMap<string, string>;
  runPragmaStatements: () => void;
  registerBuiltinFunctions: () => void;
  registerCustomFunction: (name: string, source: string) => void;
}

export function exportWithRuntimeStateRestore(db: Database, state: ExportRuntimeState): Uint8Array {
  state.statementCache.freeAll();
  const data = db.export();
  state.matRefreshSqlCache.invalidate();
  state.runPragmaStatements();
  state.registerBuiltinFunctions();
  for (const [name, source] of Array.from(state.registeredFunctionSources.entries())) {
    state.registerCustomFunction(name, source);
  }
  return data;
}

export async function runBatchIndexing(
  db: Database,
  isInitialIndexing: boolean,
  runInTx: () => void | Promise<void>,
  onAnalyzeError: (error: unknown) => void
): Promise<void> {
  if (isInitialIndexing) {
    db.run('PRAGMA foreign_keys = OFF');
  }

  try {
    await runInTx();
  } finally {
    if (isInitialIndexing) {
      db.run('PRAGMA foreign_keys = ON');
    }
  }

  if (isInitialIndexing) {
    try {
      db.run('ANALYZE');
    }
    catch (error) {
      onAnalyzeError(error);
    }
  }
}
