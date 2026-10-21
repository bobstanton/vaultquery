import type { Database, Statement } from 'sql.js';
import type { SqlParameter } from './QueryValues';
import { queryRowBytes } from './QueryValues';
import { rowFromStatementValues } from './StatementRows';
import { enterReadOnlyQuery, enterReadOnlyScope } from './ReadOnlyQuery';
import { isSelectOnly } from '../utils/SQLParsingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';

export function queryChangesDatabase(sql: string): boolean {
  return !isSelectOnly(sql) && !/^\s*PRAGMA\s+(?:(?:main|temp)\s*\.\s*)?(?:(?:schema_version|query_only|function_list|database_list)|(?:table_info|table_xinfo|index_list|index_info|index_xinfo)\s*\([^;]*\))\s*;?\s*$/i.test(sql);
}

export interface QueryIterationOptions {
  signal?: AbortSignal;
  snapshot?: boolean;
}

export class QueryIterationInvalidatedError extends Error {
  constructor() {
    super('Query iteration was interrupted by a database change. Discard partial results and retry the query.');
    this.name = 'QueryIterationInvalidatedError';
  }
}

export interface QueryBatch {
  rows: Record<string, unknown>[];
  done: boolean;
}

const BATCH_ROWS = 256;
const BATCH_BYTES = 256 * 1024;

export function* consumeQuerySnapshot<T extends Record<string, unknown>>(rows: T[], signal?: AbortSignal): Generator<T[]> {
  const buffered: Array<T | undefined> = rows;
  let batch: T[] = [];
  let bytes = 0;

  try {
    for (let index = 0; index < buffered.length; index++) {
      throwIfQueryAborted(signal);
      const row = buffered[index]!;

      const size = queryRowBytes(Object.values(row));

      if (batch.length && (batch.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) {
        yield batch;
        throwIfQueryAborted(signal);
        batch = [];
        bytes = 0;
      }

      batch.push(row);
      bytes += size;
      buffered[index] = undefined;
    }

    if (batch.length) yield batch;
    throwIfQueryAborted(signal);
  } finally {
    buffered.length = 0;
  }
}

interface Cursor {
  statement: Statement;
  columns: string[];
  version: string;
  lastActivity: number;
  pending?: ReturnType<Statement['get']>;
  reading?: boolean;
  closed?: boolean;
}

export interface SettleOptions {
  idleMs?: number;
  maxMs?: number;
}

const SETTLE_POLL_MS = 25;

export class QueryBatchCursors {
  private cursors = new Map<number, Cursor>();
  private nextId = 1;
  private releaseReadOnly?: () => void;
  private activeReads = 0;

  constructor(private database: () => Database) {}

  get size(): number { return this.cursors.size; }

  private version(db: Database): string {
    const scalar = (sql: string): string => String(db.exec(sql)[0].values[0][0]);

    return `${scalar('SELECT total_changes()')}:${scalar('PRAGMA schema_version')}:${scalar('PRAGMA temp.schema_version')}`;
  }

  open(sql: string, params: SqlParameter[]): number {
    const db = this.database();
    const release = enterReadOnlyQuery(db, sql);
    this.releaseReadOnly ??= release;

    try {
      const statement = db.prepare(sql);

      try {
        statement.bind(params);
        const id = this.nextId++;
        this.cursors.set(id, { statement, columns: statement.getColumnNames(), version: this.version(db), lastActivity: Date.now() });

        return id;
      } catch (error) {
        statement.free();
        throw error;
      }
    } catch (error) {
      this.releaseIfIdle();
      throw error;
    }
  }

  next(id: number): QueryBatch {
    const cursor = this.cursors.get(id);
    if (!cursor) throw new QueryIterationInvalidatedError();
    cursor.reading = true;
    cursor.lastActivity = Date.now();
    this.activeReads++;

    try {
      const db = this.database();
      if (!this.releaseReadOnly) this.releaseReadOnly = enterReadOnlyScope(db);
      if (cursor.version !== this.version(db)) throw new QueryIterationInvalidatedError();
      const rows: Record<string, unknown>[] = [];
      let bytes = 0;

      while (rows.length < BATCH_ROWS) {
        if (!cursor.pending && !cursor.statement.step()) {
          this.close(id);

          return { rows, done: true };
        }

        if (cursor.closed) throw new QueryIterationInvalidatedError();
        const values = cursor.pending ?? cursor.statement.get();

        const size = queryRowBytes(values);

        if (rows.length && bytes + size > BATCH_BYTES) {
          cursor.pending = values;
          break;
        }

        cursor.pending = undefined;
        rows.push(rowFromStatementValues(cursor.columns, values));
        bytes += size;
        if (bytes >= BATCH_BYTES) break;
      }

      return { rows, done: false };
    } catch (error) {
      this.close(id);
      if (/abort due to ROLLBACK/i.test(getErrorMessage(error))) throw new QueryIterationInvalidatedError();
      throw error;
    } finally {
      cursor.reading = false;
      this.activeReads--;
      if (cursor.closed) cursor.statement.free();
      this.releaseIfIdle();
    }
  }

  close(id: number): void {
    const cursor = this.cursors.get(id);
    if (!cursor) return;
    this.cursors.delete(id);
    cursor.closed = true;
    if (!cursor.reading) cursor.statement.free();
    this.releaseIfIdle();
  }

  invalidate(): void {
    for (const id of [...this.cursors.keys()]) {
      this.close(id);
    }
  }

  async settle(options: SettleOptions = {}): Promise<void> {
    // The database worker has self but no window.
    const timers = typeof window === 'undefined' ? self : window;
    const idleMs = options.idleMs ?? 250;
    const maxMs = options.maxMs ?? 1500;
    const deadline = Date.now() + maxMs;

    while (Date.now() < deadline) {
      const active = [...this.cursors.values()];
      if (!active.length) return;
      const idleFor = Date.now() - Math.max(...active.map(cursor => cursor.lastActivity));
      if (idleFor >= idleMs) return;
      await new Promise<void>(resolve => timers.setTimeout(resolve, SETTLE_POLL_MS));
    }
  }

  private releaseIfIdle(): void {
    if (this.cursors.size || this.activeReads) return;
    const release = this.releaseReadOnly;
    this.releaseReadOnly = undefined;
    release?.();
  }
}

export function throwIfQueryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Query iteration canceled.', 'AbortError');
}

export async function awaitQueryOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let onAbort: () => void = () => {};

  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException('Query iteration canceled.', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function* iterateQueryCursor(
  source: { open(): Promise<number>; next(id: number): Promise<QueryBatch>; close(id: number): Promise<void> },
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>[]> {
  let id: number | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closed = true;
    if (id !== undefined) closing ??= source.close(id);

    return closing ?? Promise.resolve();
  };

  const onAbort = () => { void close().catch(() => {}); };

  try {
    throwIfQueryAborted(signal);
    signal?.addEventListener('abort', onAbort, { once: true });

    const opening = source.open().then(async opened => {
      id = opened;
      if (closed) await close();

      return opened;
    });

    await awaitQueryOperation(opening, signal);

    while (true) {
      throwIfQueryAborted(signal);
      const batch = await awaitQueryOperation(source.next(id!), signal);
      throwIfQueryAborted(signal);
      if (batch.done) await close();
      if (batch.rows.length) yield batch.rows;
      if (batch.done) return;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await close();
  }
}
