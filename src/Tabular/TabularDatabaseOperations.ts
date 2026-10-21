import { withSavepoint, readRows } from '../Database/SqlScopes';
import { quoteIdentifier, sqliteIdentifierKey } from '../utils/SqlIdentifierUtils';
import type { Database, SqlValue } from 'sql.js';
import { columnNames, DataFileError } from './TabularTypes';
import { CSV_TABLE_OWNERSHIP_SQL, csvDropOwnedTableSql, ensureRegistry, validateDataFilePath } from './TabularTableOwnership';
import type { RowOrigins, TabularColumn, TabularDocument, TabularFormat, TabularValue } from './TabularTypes';
import { loadTabularTable, nullableColumn } from './TabularTableLoader';
import type { PreviewResult } from '../Services/PreviewService';
import { splitSqlStatements, extractDmlTargetTable, detectDmlOperation, stripLeadingCte } from '../utils/SQLParsingUtils';

export const DATA_FILE_REGISTRY_SQL = `CREATE TABLE "_vq_data_files" (
  path TEXT PRIMARY KEY NOT NULL,
  relation_name TEXT COLLATE NOCASE UNIQUE,
  columns_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  mtime REAL NOT NULL,
  source_bytes INTEGER NOT NULL,
  format_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready', 'unvalidated', 'unavailable')),
  error TEXT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  CHECK (relation_name IS NULL OR relation_name = path COLLATE BINARY)
)`;

export interface IndexedDataFile {
  readonly path: string;
  readonly relationName: string | null;
  readonly columns: readonly TabularColumn[];
  readonly revision: string;
  readonly mtime: number;
  readonly sourceBytes: number;
  readonly format: TabularFormat | null;
  readonly status: 'ready' | 'unvalidated' | 'unavailable';
  readonly error: string | null;
}

export function dataFileWriteGuardSql(path: string): string[] {
  return ['INSERT', 'UPDATE', 'DELETE'].map(operation => {
    const trigger = quoteIdentifier(`_vq_csv_${operation.toLowerCase()}:${path}`);

    return `CREATE TRIGGER ${trigger} BEFORE ${operation} ON main.${quoteIdentifier(path)} BEGIN SELECT RAISE(ABORT, 'Data file writes require a prepared write plan'); END`;
  });
}

export const DATA_FILE_READY_SQL = `INSERT OR REPLACE INTO main._vq_data_files
  (path, relation_name, columns_json, revision, mtime, source_bytes, format_json, status, error, schema_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', NULL, 1)`;

export function dataFileReadyParams(document: TabularDocument, revision: string, mtime: number): (string | number)[] {
  return [document.path, document.path, JSON.stringify(document.columns), revision, mtime, document.sourceBytes, JSON.stringify(document.format)];
}

export const DATA_FILE_UNAVAILABLE_SQL = `INSERT INTO main._vq_data_files
  (path, relation_name, columns_json, revision, mtime, source_bytes, format_json, status, error, schema_version)
  VALUES (?, NULL, ?, ?, ?, ?, ?, 'unavailable', ?, 1)
  ON CONFLICT(path) DO UPDATE SET relation_name = NULL, status = 'unavailable', error = excluded.error`;

const sourceColumns = 'path, relation_name, columns_json, revision, mtime, source_bytes, format_json, status, error';

function indexedSource(row: SqlValue[]): IndexedDataFile {
  return {
    path: String(row[0]), relationName: row[1] === null ? null : String(row[1]),
    columns: JSON.parse(String(row[2])) as TabularColumn[], revision: String(row[3]),
    mtime: Number(row[4]), sourceBytes: Number(row[5]),
    format: row[6] === null ? null : JSON.parse(String(row[6])) as TabularFormat,
    status: row[7] as IndexedDataFile['status'], error: row[8] === null ? null : String(row[8]),
  };
}

function assertStagedValue(path: string, column: TabularColumn, value: unknown, format: TabularFormat | null): TabularValue {
  if (value === null || value === undefined) {
    if (!format || !nullableColumn(column, format)) throw new DataFileError(path, 'format', `The ${column.name} column cannot hold NULL.`);

    return null;
  }

  if (typeof value === 'string') {
    if (column.type !== 'TEXT' && column.type !== 'JSON') throw new DataFileError(path, 'format', `The ${column.name} column holds numbers.`);

    return value;
  }

  if (typeof value === 'number' && column.type !== 'TEXT' && column.type !== 'JSON') return value;

  throw new DataFileError(path, 'format', `The ${column.name} column cannot hold this value; binary values are not supported.`);
}

export class DataFileDatabaseOperations {
  public constructor(private readonly db: Database, private readonly invalidateStatements: () => void = () => {}) {
    this.invalidateStatements();
    if (!ensureRegistry(this.db, '_vq_data_files', DATA_FILE_REGISTRY_SQL)) this.db.run("UPDATE main._vq_data_files SET status = 'unvalidated' WHERE status = 'ready'");
  }

  public listSources(): IndexedDataFile[] {
    return readRows(this.db, `SELECT ${sourceColumns} FROM main._vq_data_files ORDER BY path`).map(indexedSource);
  }

  public getSource(path: string): IndexedDataFile | undefined {
    const row = readRows(this.db, `SELECT ${sourceColumns} FROM main._vq_data_files WHERE path = ?`, [path])[0];

    return row && indexedSource(row);
  }

  public replaceSnapshot(document: TabularDocument, revision: string, mtime: number): void {
    const { path } = document;
    validateDataFilePath(path);
    if (/^sqlite_/i.test(path)) throw new DataFileError(path, 'ownership', 'SQLite reserves relation names starting with sqlite_.');
    if (!revision || !Number.isFinite(mtime)) throw new DataFileError(path, 'format', 'A revision and valid modification time are required.');

    this.transaction(() => {
      this.dropOwnedTable(path, true);
      loadTabularTable(this.db, document);

      for (const sql of dataFileWriteGuardSql(path)) {
        this.db.run(sql);
      }

      this.db.run(DATA_FILE_READY_SQL, dataFileReadyParams(document, revision, mtime));
    });
  }

  public readRecords(path: string): TabularValue[][] {
    validateDataFilePath(path);
    const source = this.getSource(path);

    if (!source || source.status !== 'ready' || source.relationName !== path) {
      throw new DataFileError(path, 'source-changed', 'The snapshot has not been validated against the current file.');
    }

    return readRows(this.db, `SELECT ${columnNames(source.columns).map(quoteIdentifier).join(', ')} FROM main.${quoteIdentifier(source.relationName)} ORDER BY "_vq_row_id"`) as TabularValue[][];
  }

  public stageWrites(path: string, sql: string, preview: (statement: string) => PreviewResult): { preview: PreviewResult; rows: TabularValue[][] } {
    if (readRows(this.db, 'SELECT name FROM sqlite_temp_schema WHERE name = ? COLLATE NOCASE', [path]).length) {
      throw new DataFileError(path, 'ownership', 'A temporary relation shadows this table. Remove it before generating a preview.');
    }

    if (readRows(this.db, "SELECT name FROM sqlite_temp_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE", [path]).length) {
      throw new DataFileError(path, 'ownership', 'Writes with user-defined temporary triggers are not supported.');
    }

    const source = this.getSource(path);

    if (!source || source.status !== 'ready' || source.relationName !== path) {
      throw new DataFileError(path, 'source-changed', 'The source is unavailable.');
    }

    const expectedGuards = new Set(dataFileWriteGuardSql(path));
    const triggers = readRows(this.db, "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE", [path]);

    if (triggers.some(trigger => !expectedGuards.has(String(trigger[1])))) {
      throw new DataFileError(path, 'ownership', 'Writes with user-defined triggers are not supported.');
    }

    const statements = splitSqlStatements(sql);

    for (const statement of statements) {
      const target = extractDmlTargetTable(statement);

      if (!target || sqliteIdentifierKey(target) !== sqliteIdentifierKey(path) || !detectDmlOperation(stripLeadingCte(statement))) {
        throw new DataFileError(path, 'ownership', 'A write batch must target exactly one data file.');
      }
    }

    this.invalidateStatements();
    const results: PreviewResult[] = [];
    const table = quoteIdentifier(path);
    const headers = columnNames(source.columns);

    try {
      return withSavepoint(this.db, '_vq_csv_write_stage', () => {
        for (const trigger of triggers) {
          this.db.run(`DROP TRIGGER ${quoteIdentifier(String(trigger[0]))}`);
        }

        this.db.run(`CREATE TRIGGER "_vq_csv_stage_identity" BEFORE UPDATE OF "_vq_row_id", rowid, _rowid_, oid ON ${table}
        BEGIN SELECT RAISE(ABORT, 'Row identities cannot be edited'); END`);

        for (const statement of statements) {
          this.db.run(`CREATE TRIGGER "_vq_csv_stage_insert_identity" BEFORE INSERT ON ${table} WHEN NEW."_vq_row_id" != -1
          BEGIN SELECT RAISE(ABORT, 'Row identities cannot be inserted explicitly'); END`);

          const result = preview(statement);

          for (const rows of [result.before, result.after]) {
            for (const row of rows) {
              for (const column of source.columns) {
                assertStagedValue(path, column, row[column.name], source.format);
              }
            }
          }

          this.db.run('DROP TRIGGER "_vq_csv_stage_insert_identity"');
          const remove = this.db.prepare(`DELETE FROM ${table} WHERE "_vq_row_id" = ?`);
          const insert = this.db.prepare(`INSERT INTO ${table} (${['_vq_row_id', ...headers].map(quoteIdentifier).join(', ')}) VALUES (${Array(headers.length + 1).fill('?').join(', ')})`);
          const update = this.db.prepare(`UPDATE ${table} SET ${headers.map(header => `${quoteIdentifier(header)} = ?`).join(', ')} WHERE "_vq_row_id" = ?`);

          try {
            if (result.op === 'delete') {
              for (const row of result.before) {
                remove.run([row._vq_row_id as number]);
              }
            }
            else {
              for (const row of result.after) {
                const id = row._vq_row_id;
                if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new DataFileError(path, 'format', 'Row identities must be generated by SQLite.');

                const values = source.columns.map(column => assertStagedValue(path, column, row[column.name], source.format));

                if (result.op === 'insert') insert.run([id as number, ...values]);
                else update.run([...values, id as number]);
              }
            }
          }
          finally {
            remove.free(); insert.free(); update.free();
          }

          result.table = path;
          result.before.sort((a, b) => Number(a._vq_row_id) - Number(b._vq_row_id));
          result.after.sort((a, b) => Number(a._vq_row_id) - Number(b._vq_row_id));
          results.push(result);
        }

        const rows = this.readRecords(path);

        return {
          preview: results.length === 1 ? results[0] : {
            op: 'multi', table: path, pkCols: ['_vq_row_id'], ids: [], before: [], after: [],
            sqlToApply: results.flatMap(result => result.sqlToApply), multiResults: results,
          },
          rows,
        };
      }, true);
    }
    finally {
      this.invalidateStatements();
    }
  }

  public markUnavailable(path: string, error: string): void {
    validateDataFilePath(path);

    this.transaction(() => {
      this.dropOwnedTable(path);

      this.db.run(DATA_FILE_UNAVAILABLE_SQL, [path, '[]', '', 0, 0, null, error]);
    });
  }

  public remove(path: string): void {
    this.transaction(() => {
      this.dropOwnedTable(path);
      this.db.run('DELETE FROM main._vq_data_files WHERE path = ?', [path]);
    });
  }

  public clear(): void {
    this.transaction(() => {
      for (const source of this.listSources()) {
        this.dropOwnedTable(source.path);
      }

      this.db.run('DELETE FROM main._vq_data_files');
    });
  }

  private dropOwnedTable(path: string, replacing = false): void {
    const sql = csvDropOwnedTableSql(path, readRows(this.db, CSV_TABLE_OWNERSHIP_SQL, [path])[0], replacing);
    if (sql) this.db.run(sql);
  }

  private transaction(work: () => void): void {
    this.invalidateStatements();

    try {
      withSavepoint(this.db, '_vq_csv_snapshot', work);
    }
    finally {
      this.invalidateStatements();
    }
  }
}

export function stagedRowOrigins(preview: PreviewResult, sourceRows: number, stagedRows: number): RowOrigins {
  const deleted = new Set<number>();

  for (const result of preview.multiResults ?? [preview]) {
    if (result.op !== 'delete') continue;

    for (const row of result.before) {
      deleted.add(Number(row._vq_row_id));
    }
  }

  const origins: (number | null)[] = [];

  for (let index = 0; index < sourceRows; index++) {
    if (!deleted.has(index + 1)) origins.push(index);
  }

  if (origins.length > stagedRows) return [];

  return origins.concat(Array<null>(stagedRows - origins.length).fill(null));
}
