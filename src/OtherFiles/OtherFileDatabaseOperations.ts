import { SnapshotTable, SnapshotTableOperations } from './SnapshotTable';
import type { SnapshotMirror } from './SnapshotTable';
import { stageOtherFileWrites } from './OtherFileWriteStaging';
import type { Database } from 'sql.js';
import type { IndexedOtherFile, OtherFilePublication, OtherFileState } from './OtherFileTypes';
import type { OtherFileStageLimits, StagedOtherFile } from './OtherFileWriteStaging';

const COLUMNS = ['path', 'name', 'basename', 'extension', 'folder', 'size', 'created', 'modified', 'revision', 'indexed', 'source', 'content_status', 'content_error', 'content_bytes'] as const;
const TABLE_SQL = "CREATE TABLE other_files (path TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT '', basename TEXT NOT NULL DEFAULT '', extension TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', size INTEGER, created REAL, modified REAL, revision TEXT, indexed REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'vault', content_status TEXT NOT NULL DEFAULT 'ready', content_error TEXT, content_bytes INTEGER NOT NULL DEFAULT 0, content BLOB)";

const TABLE = new SnapshotTable<OtherFileState, IndexedOtherFile>({ name: 'other_files', tableSql: TABLE_SQL, stateColumns: COLUMNS, width: COLUMNS.length + 1,
  values: row => [...COLUMNS.map(column => row[column]), row.content], readOnlyMessage: 'Indexed file contents are read-only' });

export function ensureOtherFileSchema(db: Database): void {
  TABLE.ensure(db);
}

export class OtherFileDatabaseOperations extends SnapshotTableOperations<OtherFileState, IndexedOtherFile> {
  public constructor(db: Database, invalidateStatements: () => void = () => {}) {
    super(TABLE, db, invalidateStatements);
  }

  public stageWrites(sql: string, params: unknown[], limits: OtherFileStageLimits): StagedOtherFile[] {
    this.invalidateStatements();

    try {
      return stageOtherFileWrites(this.db, sql, params, TABLE.guards, limits);
    }
    finally {
      this.invalidateStatements();
    }
  }
}

export async function publishOtherFiles(mirror: SnapshotMirror, publication: OtherFilePublication): Promise<void> {
  await TABLE.publish(mirror, publication);
}
