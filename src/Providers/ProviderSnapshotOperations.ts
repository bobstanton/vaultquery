import { withSavepoint, readRows } from '../Database/SqlScopes';
import type { Database, SqlValue } from 'sql.js';
import { loadTabularTable, nullableColumn, tabularTableSql } from '../Tabular/TabularTableLoader';
import { ensureRegistry } from '../Tabular/TabularTableOwnership';
import { validateCsvHeaders } from '../Tabular/CsvCodec';
import { columnNames, DataFileError } from '../Tabular/TabularTypes';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';
import type { ProviderColumnType, ProviderTableSnapshot, ProviderSnapshotMetadata, ProviderTableDefinition } from './TableProviderTypes';
import type { TabularColumn, TabularFormat } from '../Tabular/TabularTypes';

const providerColumnType = (column: TabularColumn): ProviderColumnType => column.type === 'REAL' ? 'REAL' : column.type === 'INTEGER' || column.type === 'BOOLEAN' ? 'INTEGER' : 'TEXT';

export const PROVIDER_SNAPSHOT_REGISTRY = '_vq_provider_snapshots';
export const PROVIDER_SNAPSHOT_REGISTRY_SQL = `CREATE TABLE "_vq_provider_snapshots" (
  table_name TEXT PRIMARY KEY COLLATE NOCASE NOT NULL,
  provider_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
)`;

export interface ProviderSnapshotOwner {
  table: string;
  providerId: string;
  definitionId: string;
  sourcePath: string;
  fingerprint: string;
}

export interface StoredProviderSnapshot extends ProviderSnapshotOwner, ProviderSnapshotMetadata {
  columns: TabularColumn[];
  sourceBytes: number;
  rowCount: number;
  format: TabularFormat;
}

export interface ProviderSnapshotRelocation {
  previous: ProviderSnapshotOwner;
  current: ProviderSnapshotOwner;
}

export function validateSnapshotTableName(table: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table) || /^sqlite_/i.test(table)) {
    throw new Error(`Invalid snapshot table name: ${table}. Use letters, digits, and underscores, starting with a letter.`);
  }
}

export function providerSnapshotGuards(table: string): string[] {
  return ['INSERT', 'UPDATE', 'DELETE'].map(operation => `CREATE TRIGGER ${quoteIdentifier(`_vq_provider_${operation.toLowerCase()}:${table}`)} BEFORE ${operation} ON main.${quoteIdentifier(table)}`
      + " BEGIN SELECT RAISE(ABORT, 'Provider tables are read-only'); END");
}

export function snapshotTableDefinition(snapshot: StoredProviderSnapshot): ProviderTableDefinition {
  return { name: snapshot.table, description: 'Read-only provider snapshot', primaryKey: ['_vq_row_id'],
    columns: [{ name: '_vq_row_id', type: 'INTEGER', nullable: false },
      ...snapshot.columns.map(column => ({ name: column.name, type: providerColumnType(column), nullable: nullableColumn(column, snapshot.format) }))] };
}

export function sameSnapshotOwner(a: ProviderSnapshotOwner, b: ProviderSnapshotOwner): boolean {
  return a.table === b.table && a.providerId === b.providerId && a.definitionId === b.definitionId && a.sourcePath === b.sourcePath;
}

export class ProviderSnapshotOperations {
  public constructor(private readonly database: Database, private readonly invalidate: () => void = () => {}) {
    if (ensureRegistry(this.database, PROVIDER_SNAPSHOT_REGISTRY, PROVIDER_SNAPSHOT_REGISTRY_SQL)) this.invalidate();
  }

  private decode(row: SqlValue[]): StoredProviderSnapshot {
    const record = JSON.parse(String(row[5])) as StoredProviderSnapshot;

    const ownerMatches = record.table === row[0] && record.providerId === row[1] && record.definitionId === row[2]
      && record.sourcePath === row[3] && record.fingerprint === row[4];

    if (!ownerMatches) throw new Error('Provider snapshot metadata does not match its registry owner.');
    validateSnapshotTableName(record.table);
    validateCsvHeaders(columnNames(record.columns), record.table);
    const validSize = Number.isSafeInteger(record.sourceBytes) && record.sourceBytes >= 0;
    const validCount = Number.isSafeInteger(record.rowCount) && record.rowCount >= 0;

    if (!record.revision || !validSize || !validCount || !Number.isFinite(record.asOf) || !Number.isFinite(record.expiresAt)) {
      throw new Error('Provider snapshot metadata is invalid.');
    }

    return record;
  }

  private selectRecords(where = '', params: SqlValue[] = []): StoredProviderSnapshot[] {
    return readRows(this.database, `SELECT table_name, provider_id, definition_id, source_path, fingerprint, metadata_json
      FROM main._vq_provider_snapshots ${where}`, params).map(row => this.decode(row));
  }

  public list(): StoredProviderSnapshot[] { return this.selectRecords(); }

  public find(table: string): StoredProviderSnapshot | undefined {
    return this.selectRecords('WHERE table_name = ?', [table])[0];
  }

  public assertAvailable(owner: ProviderSnapshotOwner): void {
    validateSnapshotTableName(owner.table);

    if (readRows(this.database, 'SELECT name FROM sqlite_temp_schema WHERE name = ? COLLATE NOCASE', [owner.table]).length) {
      throw new DataFileError(owner.table, 'ownership', 'A temporary relation already uses this provider table name.');
    }

    const existing = this.find(owner.table);
    if (existing && !sameSnapshotOwner(existing, owner)) throw new DataFileError(owner.table, 'ownership', 'This table name belongs to another provider definition.');
    const relations = readRows(this.database, 'SELECT type FROM sqlite_schema WHERE name = ? COLLATE NOCASE', [owner.table]);
    if (relations.length && (!existing || relations[0][0] !== 'table')) throw new DataFileError(owner.table, 'ownership', 'This table name is already owned by another database object.');
    if (existing) this.validateStored(existing);
  }

  public validateStored(record: StoredProviderSnapshot): void {
    const sql = readRows(this.database, "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? COLLATE BINARY", [record.table])[0]?.[0];
    const expected = tabularTableSql({ path: record.table, columns: record.columns, format: record.format }).replace('CREATE TABLE main.', 'CREATE TABLE ');
    if (sql !== expected) throw new DataFileError(record.table, 'ownership', 'The stored provider table schema does not match its snapshot.');
    const actualGuards = readRows(this.database, "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?", [record.table]).map(row => String(row[0]));
    const expectedGuards = providerSnapshotGuards(record.table);

    if (actualGuards.length !== expectedGuards.length || expectedGuards.some(guard => !actualGuards.includes(guard))) {
      throw new DataFileError(record.table, 'ownership', 'The stored provider table write guards are missing or changed.');
    }

    const count = Number(readRows(this.database, `SELECT count(*) FROM main.${quoteIdentifier(record.table)}`)[0][0]);
    if (count !== record.rowCount) throw new DataFileError(record.table, 'ownership', 'The stored provider row count does not match its snapshot.');
  }

  public replace(owner: ProviderSnapshotOwner, snapshot: ProviderTableSnapshot): StoredProviderSnapshot {
    if (snapshot.table !== owner.table || snapshot.document.path !== owner.table) throw new Error('Snapshot destination does not match its reserved table.');
    this.assertAvailable(owner);

    const record: StoredProviderSnapshot = { ...owner, revision: snapshot.revision, asOf: snapshot.asOf, validatedAt: snapshot.validatedAt, expiresAt: snapshot.expiresAt,
      etag: snapshot.etag, lastModified: snapshot.lastModified, columns: [...snapshot.document.columns],
      sourceBytes: snapshot.document.sourceBytes, rowCount: snapshot.document.rows.length, format: snapshot.document.format };

    this.transaction(() => {
      this.database.run(`DROP TABLE IF EXISTS main.${quoteIdentifier(owner.table)}`);
      loadTabularTable(this.database, snapshot.document);

      for (const guard of providerSnapshotGuards(owner.table)) {
        this.database.run(guard);
      }

      this.writeMetadata(record);
    });

    return record;
  }

  public touch(owner: ProviderSnapshotOwner, metadata: ProviderSnapshotMetadata): StoredProviderSnapshot {
    const existing = this.find(owner.table);
    const matches = existing && sameSnapshotOwner(existing, owner) && existing.fingerprint === owner.fingerprint;

    if (!matches || existing.revision !== metadata.revision) {
      throw new Error('An unchanged provider result requires a matching validated snapshot.');
    }

    this.validateStored(existing);
    const record = { ...existing, asOf: existing.asOf, validatedAt: metadata.validatedAt ?? Date.now(), expiresAt: metadata.expiresAt, etag: metadata.etag, lastModified: metadata.lastModified };
    this.transaction(() => this.writeMetadata(record));

    return record;
  }

  public relocate(previous: ProviderSnapshotOwner, current: ProviderSnapshotOwner): StoredProviderSnapshot {
    if (!sameSnapshotOwner({ ...previous, sourcePath: current.sourcePath }, current) || previous.fingerprint !== current.fingerprint) {
      throw new DataFileError(previous.table, 'ownership', 'A source move cannot change the provider snapshot identity.');
    }

    const existing = this.find(previous.table);

    if (!existing || !sameSnapshotOwner(existing, previous) || existing.fingerprint !== previous.fingerprint) {
      throw new DataFileError(previous.table, 'ownership', 'The snapshot no longer belongs to the moved definition.');
    }

    this.validateStored(existing);
    const record = { ...existing, sourcePath: current.sourcePath };
    this.transaction(() => this.writeMetadata(record));

    return record;
  }

  private writeMetadata(record: StoredProviderSnapshot): void {
    this.database.run('INSERT OR REPLACE INTO main._vq_provider_snapshots VALUES (?, ?, ?, ?, ?, ?, 1)',
      [record.table, record.providerId, record.definitionId, record.sourcePath, record.fingerprint, JSON.stringify(record)]);
  }

  public remove(owner: ProviderSnapshotOwner): boolean {
    const existing = this.find(owner.table);
    if (!existing) return false;
    if (!sameSnapshotOwner(existing, owner)) throw new DataFileError(owner.table, 'ownership', 'Cannot remove a snapshot owned by another definition.');
    this.validateStored(existing);

    this.transaction(() => {
      this.database.run(`DROP TABLE main.${quoteIdentifier(existing.table)}`);
      this.database.run('DELETE FROM main._vq_provider_snapshots WHERE table_name = ?', [existing.table]);
    });

    return true;
  }

  private transaction<T>(work: () => T): T {
    this.invalidate();

    try {
      return withSavepoint(this.database, '_vq_provider_snapshot', work);
    }
    finally {
      this.invalidate();
    }
  }

  public batch<T>(work: () => T): T { return this.transaction(work); }
}
