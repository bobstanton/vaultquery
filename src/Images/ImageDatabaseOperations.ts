import { SnapshotTable, SnapshotTableOperations } from '../OtherFiles/SnapshotTable';
import type { SnapshotMirror } from '../OtherFiles/SnapshotTable';
import type { Database } from 'sql.js';
import { IMAGE_FACT_FIELDS, type ImageIndexState, type ImagePublication, type IndexedImage } from './ImageTypes';

const STATE_COLUMNS = ['path', 'name', 'basename', 'extension', 'folder', 'size', 'created', 'modified', 'revision', 'indexed', 'source',
  'metadata_status', 'metadata_error', 'tag_count', 'bytes_read'] as const;

const COLUMNS = [...STATE_COLUMNS, ...IMAGE_FACT_FIELDS.map(field => field.name)] as const;

const TABLE_SQL = "CREATE TABLE image_files (path TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT '', basename TEXT NOT NULL DEFAULT '', "
  + "extension TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '', size INTEGER, created REAL, modified REAL, revision TEXT, "
  + "indexed REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'vault', metadata_status TEXT NOT NULL DEFAULT 'ready', metadata_error TEXT, tag_count INTEGER NOT NULL DEFAULT 0, "
  + "bytes_read INTEGER NOT NULL DEFAULT 0, "
  + IMAGE_FACT_FIELDS.map(field => `${field.name} ${field.type}`).join(', ')
  + ", metadata TEXT)";

const VIEW_SQL = "CREATE VIEW image_metadata AS SELECT f.path AS path, section.key AS section, tag.key AS tag, tag.value AS value, "
  + "CASE WHEN typeof(tag.value) IN ('integer', 'real') THEN tag.value ELSE NULL END AS value_num "
  + "FROM image_files f, json_each(f.metadata) section, json_each(section.value) tag";

const TABLE = new SnapshotTable<ImageIndexState, IndexedImage>({ name: 'image_files', tableSql: TABLE_SQL, stateColumns: STATE_COLUMNS, width: COLUMNS.length + 1,
  values: row => [...COLUMNS.map(column => row[column]), row.metadata], readOnlyMessage: 'Indexed image metadata is read-only', views: [['image_metadata', VIEW_SQL]] });

export function ensureImageSchema(db: Database): void {
  TABLE.ensure(db);
}

export class ImageDatabaseOperations extends SnapshotTableOperations<ImageIndexState, IndexedImage> {
  public constructor(db: Database, invalidateStatements: () => void = () => {}) {
    super(TABLE, db, invalidateStatements);
  }
}

export async function publishImages(mirror: SnapshotMirror, publication: ImagePublication): Promise<void> {
  await TABLE.publish(mirror, publication);
}
