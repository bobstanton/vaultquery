import { readRows } from '../Database/SqlScopes';
import { DataFileError, dataFileFormat } from './TabularTypes';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';
import type { Database } from 'sql.js';

interface RegistryMirror {
  all(sql: string, params?: (string | number | null)[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: (string | number | null)[]): Promise<number>;
}

export const isDataFilePath = (path: string): boolean => dataFileFormat(path) !== undefined;

export function validateDataFilePath(path: string): void {
  if (!isDataFilePath(path) || path.includes('\\') || path.includes('\0')) {
    throw new DataFileError(path, 'ownership', 'Expected a CSV or JSON path with forward slashes and no empty, dot, or parent segments.');
  }

  const segments = path.split('/');
  const body = path.startsWith('/') ? segments.slice(1) : /^[A-Za-z]:$/.test(segments[0]) ? segments.slice(1) : segments;

  if (!body.length || body.some(part => part === '' || part === '.' || part === '..')) {
    throw new DataFileError(path, 'ownership', 'Expected a CSV or JSON path with forward slashes and no empty, dot, or parent segments.');
  }
}

export const CSV_TABLE_OWNERSHIP_SQL = `SELECT
  (SELECT relation_name FROM main._vq_data_files WHERE path = ?1) AS relation_name,
  (SELECT path FROM main._vq_data_files WHERE relation_name = ?1 COLLATE NOCASE) AS owner,
  (SELECT type FROM main.sqlite_schema WHERE name = ?1 COLLATE NOCASE) AS type`;

export function csvDropOwnedTableSql(path: string, [relation, owner, type]: readonly unknown[], replacing = false): string | undefined {
  if (relation == null && !replacing) return;
  validateDataFilePath(path);
  if (relation != null && relation !== path) throw new DataFileError(path, 'ownership', 'The registry relation does not match its source path.');

  if ((owner != null && owner !== path) || (type != null && (owner == null || type !== 'table'))) {
    throw new DataFileError(path, 'ownership', 'The SQLite relation name is already owned by another source or object.');
  }

  return relation == null ? undefined : `DROP TABLE IF EXISTS main.${quoteIdentifier(path)}`;
}

const REGISTRY_SCHEMA_SQL = 'SELECT sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE';

function registryMissing(name: string, sql: string, existing: unknown): boolean {
  if (existing !== undefined && existing !== sql) throw new Error(`The ${name} registry has an incompatible schema.`);

  return existing === undefined;
}

export function ensureRegistry(db: Database, name: string, sql: string): boolean;
export function ensureRegistry(db: RegistryMirror, name: string, sql: string): Promise<boolean>;

export function ensureRegistry(db: Database | RegistryMirror, name: string, sql: string): boolean | Promise<boolean> {
  if ('all' in db) {
    return db.all(REGISTRY_SCHEMA_SQL, [name]).then(async rows => {
      const missing = registryMissing(name, sql, rows[0]?.sql);
      if (missing) await db.run(sql);

      return missing;
    });
  }

  const missing = registryMissing(name, sql, readRows(db, REGISTRY_SCHEMA_SQL, [name])[0]?.[0]);
  if (missing) db.run(sql);

  return missing;
}
