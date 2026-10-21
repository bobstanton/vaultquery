import type { SchemaTable } from '../Database/SchemaDocumentation';
import type { IndexedDataFile } from './TabularDatabaseOperations';
import { dataFileLabel } from './TabularTypes';
import type { TabularColumn } from './TabularTypes';

export function snapshotSchemaTables(snapshots: readonly { table: string; columns: readonly TabularColumn[] }[]): SchemaTable[] {
  return snapshots.map(snapshot => ({ name: snapshot.table, isView: false,
    columns: dataFileColumns(snapshot.columns, 'snapshot is replaced'), notes: [
      'Read-only provider snapshot. Reference the table name in FROM or JOIN. Cached reads may start a background refresh.',
      'Snapshot-only results display original fields, including underscore-prefixed names, and hide internal row identities. Mixed results keep existing renderer defaults.',
    ] }));
}

export function dataFileSchemaTables(sources: readonly IndexedDataFile[]): SchemaTable[] {
  return sources.filter(source => source.status === 'ready').map(source => ({ name: source.path, isView: false,
    columns: dataFileColumns(source.columns, 'file is reindexed'), notes: [
      `Quote the complete vault-relative ${dataFileLabel(source.path)} path as one SQLite identifier in FROM/JOIN and INSERT/UPDATE/DELETE. Writes use preview/apply and may target one file per batch. INSERT requires a field list or DEFAULT VALUES.`,
      `${dataFileLabel(source.path)}-only table results display original fields, including underscore-prefixed names, and hide internal row identities. Mixed results keep existing renderer defaults; use a visible SQL alias for hidden fields.`,
    ] }));
}

const COLUMN_NOTES: Record<TabularColumn['type'], string> = {
  TEXT: 'Original field; values remain text.',
  INTEGER: 'Whole number from the source file.',
  REAL: 'Number from the source file.',
  BOOLEAN: 'Stored as 1 or 0; written back as true or false.',
  JSON: 'Nested value kept as JSON text; read it with json_extract.',
};

function dataFileColumns(columns: readonly TabularColumn[], replacement: string) {
  return [{ name: '_vq_row_id', type: 'INTEGER', description: `Internal row identity; changes when the ${replacement}.` },
    ...columns.map(column => ({ name: column.name, type: column.type === 'BOOLEAN' ? 'INTEGER' : column.type === 'JSON' ? 'TEXT' : column.type,
      description: COLUMN_NOTES[column.type] }))];
}
