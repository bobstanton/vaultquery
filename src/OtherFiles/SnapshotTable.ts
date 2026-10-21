import { insertRowsChunked } from '../Database/SqlHelpers';
import type { SqlStatement } from '../Database/SqlHelpers';
import { withSavepoint } from '../Database/SqlScopes';
import { collectStatementRows } from '../Database/StatementRows';
import { normalizeOwnedSchemaSql } from '../utils/SqlIdentifierUtils';
import type { Database } from 'sql.js';
import type { SqlParameter } from '../Database/QueryValues';

export interface TableGuard {
  name: string;
  sql: string;
}

export interface SnapshotPublication<Row> {
  rows: Row[];
  removed: string[];
}

export interface SnapshotTableSpec<Row> {
  name: string;
  tableSql: string;
  stateColumns: readonly string[];
  width: number;
  values(row: Row): SqlParameter[];
  readOnlyMessage: string;
  views?: ReadonlyArray<readonly [string, string]>;
}

export interface SnapshotMirror {
  run(sql: string, params?: SqlParameter[]): Promise<number>;
  withTx<T>(work: () => Promise<T>): Promise<T>;
  runBatch?(statements: SqlStatement[]): Promise<void>;
}

export class SnapshotTable<State, Row> {
  public readonly guards: readonly TableGuard[];

  public constructor(private readonly spec: SnapshotTableSpec<Row>) {
    this.guards = ['insert', 'update', 'delete'].map(action => ({
      name: `_vq_${spec.name}_${action}`,
      sql: `CREATE TRIGGER _vq_${spec.name}_${action} BEFORE ${action.toUpperCase()} ON ${spec.name} BEGIN SELECT RAISE(ABORT, '${spec.readOnlyMessage}'); END`,
    }));
  }

  public ensure(db: Database): void {
    const table = this.spec.name;
    const views = this.spec.views ?? [];
    const definitions = new Map<string, string>([[table, this.spec.tableSql], ...views, ...this.guards.map(guard => [guard.name, guard.sql] as [string, string])]);
    const names = [...definitions.keys()];

    const existing = new Map((db.exec(`SELECT name, type, tbl_name, sql FROM sqlite_schema WHERE name COLLATE NOCASE IN (${names.map(() => '?').join(', ')})`, names)[0]?.values ?? [])
      .map(([name, type, owner, sql]) => [String(name).toLowerCase(), { type, table: String(owner).toLowerCase(), sql }]));

    const owned = existing.get(table)?.type === 'table' && this.guards.every(({ name }) => existing.get(name)?.type === 'trigger' && existing.get(name)?.table === table);

    for (const name of names) {
      if (!owned && existing.has(name)) throw new Error(`The ${name} name is occupied by an unrelated object.`);
    }

    if ([...definitions].every(([name, sql]) => normalizeOwnedSchemaSql(existing.get(name)?.sql) === normalizeOwnedSchemaSql(sql))) return;

    withSavepoint(db, `vq_${table}_schema`, () => {
      const rebuildTable = owned && normalizeOwnedSchemaSql(existing.get(table)?.sql) !== normalizeOwnedSchemaSql(this.spec.tableSql);

      for (const [view] of views) {
        if (existing.has(view)) db.run(`DROP VIEW IF EXISTS ${view}`);
      }

      if (rebuildTable) db.run(`DROP TABLE ${table}`);
      else if (owned) this.dropGuards(db);

      if (!owned || rebuildTable) db.run(this.spec.tableSql);
      this.createGuards(db);

      for (const [, sql] of views) {
        db.run(sql);
      }
    });
  }

  public list(db: Database): State[] {
    const statement = db.prepare(`SELECT ${this.spec.stateColumns.join(', ')} FROM ${this.spec.name} ORDER BY path`);

    try {
      return collectStatementRows(statement) as unknown as State[];
    }
    finally {
      statement.free();
    }
  }

  public apply(db: Database, publication: SnapshotPublication<Row>): void {
    withSavepoint(db, `vq_${this.spec.name}`, () => {
      this.dropGuards(db);
      const remove = db.prepare(`DELETE FROM ${this.spec.name} WHERE path = ?`);

      try {
        for (const path of publication.removed) {
          remove.run([path]);
          remove.reset();
        }
      } finally {
        remove.free();
      }

      const insert = db.prepare(`INSERT OR REPLACE INTO ${this.spec.name} VALUES (${new Array(this.spec.width).fill('?').join(', ')})`);

      try {
        for (const row of publication.rows) {
          insert.run(this.spec.values(row));
          insert.reset();
        }
      } finally {
        insert.free();
      }

      this.createGuards(db);
    });
  }

  public async publish(mirror: SnapshotMirror, publication: SnapshotPublication<Row>): Promise<void> {
    const statements: SqlStatement[] = this.guards.map(guard => ({ sql: `DROP TRIGGER ${guard.name}`, params: [] }));

    for (let offset = 0; offset < publication.removed.length; offset += 100) {
      const paths = publication.removed.slice(offset, offset + 100);
      statements.push({ sql: `DELETE FROM ${this.spec.name} WHERE path IN (${paths.map(() => '?').join(', ')})`, params: paths });
    }

    await insertRowsChunked({ run: async (sql, params = []) => { statements.push({ sql, params });

 return 0; } },
      placeholders => `INSERT OR REPLACE INTO ${this.spec.name} VALUES ${placeholders}`,
      publication.rows.map(row => this.spec.values(row)), this.spec.width, { maxRows: 64 });

    statements.push(...this.guards.map(guard => ({ sql: guard.sql, params: [] })));

    if (mirror.runBatch) return mirror.runBatch(statements);

    await mirror.withTx(async () => {
      for (const { sql, params } of statements) {
        await mirror.run(sql, params);
      }
    });
  }

  private dropGuards(db: Database): void {
    for (const guard of this.guards) {
      db.run(`DROP TRIGGER ${guard.name}`);
    }
  }

  private createGuards(db: Database): void {
    for (const guard of this.guards) {
      db.run(guard.sql);
    }
  }
}

export class SnapshotTableOperations<State, Row> {
  public constructor(protected readonly table: SnapshotTable<State, Row>, protected readonly db: Database, protected readonly invalidateStatements: () => void = () => {}) {}

  public list(): State[] { return this.table.list(this.db); }

  public apply(publication: SnapshotPublication<Row>): void {
    this.invalidateStatements();

    try {
      this.table.apply(this.db, publication);
    }
    finally {
      this.invalidateStatements();
    }
  }
}
