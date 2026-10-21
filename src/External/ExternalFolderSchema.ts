import { withSavepoint } from '../Database/SqlScopes';
import { normalizeOwnedSchemaSql } from '../utils/SqlIdentifierUtils';
import type { Database } from 'sql.js';
import type { ExternalRootStatus } from './ExternalRootService';
import type { SqlParameter } from '../Database/QueryValues';

export const EXTERNAL_FOLDERS_VIEW = 'external_folders';
export const EXTERNAL_FOLDERS_TABLE = '_vq_external_folders';

const COLUMNS = ['path', 'file_types', 'refresh_mode', 'refresh_minutes', 'state', 'scanning',
  'files_found', 'files_indexed', 'files_skipped', 'failures', 'error', 'last_scan_started', 'last_scan_completed'] as const;

const TABLE_SQL = `CREATE TABLE ${EXTERNAL_FOLDERS_TABLE} (path TEXT PRIMARY KEY NOT NULL, file_types TEXT NOT NULL DEFAULT '', `
  + "refresh_mode TEXT NOT NULL DEFAULT 'watch', refresh_minutes INTEGER, "
  + "state TEXT NOT NULL DEFAULT 'ready', "
  + 'scanning INTEGER NOT NULL DEFAULT 0, files_found INTEGER NOT NULL DEFAULT 0, files_indexed INTEGER NOT NULL DEFAULT 0, '
  + 'files_skipped INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, '
  + 'error TEXT, last_scan_started REAL, last_scan_completed REAL)';

const VIEW_SQL = `CREATE VIEW ${EXTERNAL_FOLDERS_VIEW} AS SELECT ${COLUMNS.join(', ')} FROM ${EXTERNAL_FOLDERS_TABLE}`;

const INSERT_SQL = `INSERT INTO ${EXTERNAL_FOLDERS_TABLE} VALUES (${COLUMNS.map(() => '?').join(', ')})`;

export function externalFolderRow(status: ExternalRootStatus): SqlParameter[] {
  return [status.path, status.extensions.join(', '), status.refresh, status.refresh === 'interval' ? status.refreshMinutes : null,
    status.state, status.scanning ? 1 : 0, status.filesFound, status.filesIndexed, status.filesSkipped, status.failures.length,
    status.error, status.lastScanStarted, status.lastScanCompleted];
}

export function ensureExternalFolderSchema(db: Database): void {
  const definitions = new Map<string, string>([[EXTERNAL_FOLDERS_TABLE, TABLE_SQL], [EXTERNAL_FOLDERS_VIEW, VIEW_SQL]]);
  const names = [...definitions.keys()];

  const existing = new Map((db.exec(`SELECT name, type, sql FROM sqlite_schema WHERE name COLLATE NOCASE IN (${names.map(() => '?').join(', ')})`, names)[0]?.values ?? [])
    .map(([name, type, sql]) => [String(name).toLowerCase(), { type, sql }]));

  const owned = !existing.has(EXTERNAL_FOLDERS_VIEW) || existing.get(EXTERNAL_FOLDERS_VIEW)?.type === 'view';
  if (!owned) throw new Error(`The ${EXTERNAL_FOLDERS_VIEW} name is occupied by an unrelated object.`);

  if ([...definitions].every(([name, sql]) => normalizeOwnedSchemaSql(existing.get(name)?.sql) === normalizeOwnedSchemaSql(sql))) return;

  withSavepoint(db, 'vq_external_folder_schema', () => {
    db.run(`DROP VIEW IF EXISTS ${EXTERNAL_FOLDERS_VIEW}`);
    db.run(`DROP TABLE IF EXISTS ${EXTERNAL_FOLDERS_TABLE}`);
    db.run(TABLE_SQL);
    db.run(VIEW_SQL);
  });
}

export interface ExternalFolderTarget {
  run(sql: string, params?: SqlParameter[]): Promise<number>;
}

export async function publishExternalFolders(target: ExternalFolderTarget, statuses: readonly ExternalRootStatus[]): Promise<void> {
  await target.run(`DELETE FROM ${EXTERNAL_FOLDERS_TABLE}`);

  for (const status of statuses) {
    await target.run(INSERT_SQL, externalFolderRow(status));
  }
}
