import { insertRowsChunked } from '../Database/SqlHelpers';
import { DATA_FILE_REGISTRY_SQL, DATA_FILE_READY_SQL, DATA_FILE_UNAVAILABLE_SQL, dataFileReadyParams, dataFileWriteGuardSql } from './TabularDatabaseOperations';
import { CSV_TABLE_OWNERSHIP_SQL, csvDropOwnedTableSql, ensureRegistry, validateDataFilePath } from './TabularTableOwnership';
import { csvPublicationPath } from './TabularIndexingService';
import type { CsvPublication } from './TabularIndexingService';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';
import { tabularTableSql } from './TabularTableLoader';
import { columnNames } from './TabularTypes';

interface DataFileMirrorDatabase {
  all(sql: string, params?: (string | number | null)[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: (string | number | null)[]): Promise<number>;
  withTx<T>(work: () => T | Promise<T>): Promise<T>;
}

export async function publishCsvToMirror(database: DataFileMirrorDatabase, publication: CsvPublication): Promise<void> {
  await database.withTx(async () => {
    if (publication.kind === 'reset') {
      await ensureRegistry(database, '_vq_data_files', DATA_FILE_REGISTRY_SQL);
      const sources = await database.all('SELECT path FROM main._vq_data_files');

      for (const source of sources) {
        await dropOwnedTable(database, String(source.path));
      }

      await database.run('DELETE FROM main._vq_data_files');

      return;
    }

    const path = csvPublicationPath(publication);
    validateDataFilePath(path);
    await dropOwnedTable(database, path, publication.kind === 'ready');
    await database.run('DELETE FROM main._vq_data_files WHERE path = ?', [path]);
    if (publication.kind === 'remove') return;

    if (publication.kind === 'unavailable') {
      const source = publication.source;

      await database.run(DATA_FILE_UNAVAILABLE_SQL, [path, JSON.stringify(source.columns), source.revision, source.mtime, source.sourceBytes,
        source.format ? JSON.stringify(source.format) : null, source.error]);

      return;
    }

    const { document, revision, mtime } = publication;
    await database.run(tabularTableSql(document));
    const prefix = `INSERT INTO main.${quoteIdentifier(path)} (${columnNames(document.columns).map(quoteIdentifier).join(', ')}) VALUES `;
    await insertRowsChunked(database, placeholders => prefix + placeholders, document.rows, document.columns.length);

    for (const sql of dataFileWriteGuardSql(path)) {
      await database.run(sql);
    }

    await database.run(DATA_FILE_READY_SQL, dataFileReadyParams(document, revision, mtime));
  });
}

async function dropOwnedTable(database: DataFileMirrorDatabase, path: string, replacing = false): Promise<void> {
  const row = (await database.all(CSV_TABLE_OWNERSHIP_SQL, [path]))[0];
  const sql = csvDropOwnedTableSql(path, [row.relation_name, row.owner, row.type], replacing);
  if (sql) await database.run(sql);
}
