import { insertRowsChunked, sqlInsertBatchSize } from '../Database/SqlHelpers';
import { tabularTableSql } from '../Tabular/TabularTableLoader';
import { columnNames } from '../Tabular/TabularTypes';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';
import { ensureRegistry } from '../Tabular/TabularTableOwnership';
import { PROVIDER_SNAPSHOT_REGISTRY, PROVIDER_SNAPSHOT_REGISTRY_SQL, providerSnapshotGuards, sameSnapshotOwner } from './ProviderSnapshotOperations';
import type { ProviderSnapshotRelocation, StoredProviderSnapshot } from './ProviderSnapshotOperations';

interface SnapshotReader {
  all(sql: string, params?: (string | number | null)[]): Promise<Record<string, unknown>[]>;
}

interface SnapshotMirror extends SnapshotReader {
  run(sql: string, params?: (string | number | null)[]): Promise<number>;
  withTx<T>(work: () => T | Promise<T>): Promise<T>;
}

function sameMirroredSnapshot(previous: StoredProviderSnapshot, current: StoredProviderSnapshot): boolean {
  return previous.revision === current.revision && previous.rowCount === current.rowCount
    && JSON.stringify(previous.columns) === JSON.stringify(current.columns);
}

export async function publishProviderSnapshots(main: SnapshotReader, mirror: SnapshotMirror, tables: readonly string[], relocations: readonly ProviderSnapshotRelocation[] = []): Promise<void> {
  await mirror.withTx(async () => {
    await ensureRegistry(mirror, PROVIDER_SNAPSHOT_REGISTRY, PROVIDER_SNAPSHOT_REGISTRY_SQL);
    const copies = new Set(tables);

    for (const relocation of relocations) {
      const table = relocation.current.table;
      if (!sameSnapshotOwner({ ...relocation.previous, sourcePath: relocation.current.sourcePath }, relocation.current)
        || relocation.previous.fingerprint !== relocation.current.fingerprint) throw new Error('Provider mirror relocation changes source identity.');
      const row = (await main.all('SELECT metadata_json FROM main._vq_provider_snapshots WHERE table_name = ?', [table]))[0];
      const current = row ? JSON.parse(String(row.metadata_json)) as StoredProviderSnapshot : undefined;

      if (!current || !sameSnapshotOwner(current, relocation.current) || current.fingerprint !== relocation.current.fingerprint) {
        throw new Error('Provider mirror relocation does not match the main owner.');
      }

      const previousRow = (await mirror.all('SELECT metadata_json FROM main._vq_provider_snapshots WHERE table_name = ?', [table]))[0];
      if (!previousRow) { copies.add(table); continue; }
      const previous = JSON.parse(String(previousRow.metadata_json)) as StoredProviderSnapshot;

      if (!sameSnapshotOwner(previous, relocation.previous) || previous.fingerprint !== relocation.previous.fingerprint
        || !sameMirroredSnapshot(previous, current)) {
        throw new Error('Provider mirror relocation has a different owner or snapshot.');
      }

      await mirror.run('UPDATE main._vq_provider_snapshots SET source_path = ?, metadata_json = ? WHERE table_name = ?',
        [current.sourcePath, JSON.stringify(current), table]);
    }

    for (const table of copies) {
      const recordRow = (await main.all('SELECT metadata_json FROM main._vq_provider_snapshots WHERE table_name = ?', [table]))[0];
      const record = recordRow ? JSON.parse(String(recordRow.metadata_json)) as StoredProviderSnapshot : undefined;
      const previousRow = (await mirror.all('SELECT metadata_json FROM main._vq_provider_snapshots WHERE table_name = ?', [table]))[0];
      const previous = previousRow ? JSON.parse(String(previousRow.metadata_json)) as StoredProviderSnapshot : undefined;
      if (previous && (previous.table !== table || (record && !sameSnapshotOwner(previous, record)))) throw new Error('Provider mirror ownership differs from the main snapshot.');
      const relation = (await mirror.all('SELECT type FROM sqlite_schema WHERE name = ? COLLATE NOCASE', [table]))[0];
      if (relation && (!previous || relation.type !== 'table')) throw new Error(`Provider mirror table name is occupied: ${table}.`);
      if (previous) await mirror.run(`DROP TABLE IF EXISTS main.${quoteIdentifier(table)}`);
      await mirror.run('DELETE FROM main._vq_provider_snapshots WHERE table_name = ?', [table]);
      if (!record) continue;
      if (record.table !== table) throw new Error('Provider snapshot publication destination is invalid.');
      await mirror.run(tabularTableSql({ path: table, columns: record.columns, format: record.format }));
      const columns = ['_vq_row_id', ...columnNames(record.columns)];
      const quotedColumns = columns.map(quoteIdentifier).join(', ');
      const batchSize = sqlInsertBatchSize(columns.length);
      let lastId = 0;
      let count = 0;

      while (true) {
        const rows = await main.all(`SELECT ${quotedColumns} FROM main.${quoteIdentifier(table)} WHERE "_vq_row_id" > ? ORDER BY "_vq_row_id" LIMIT ?`, [lastId, batchSize]);
        if (!rows.length) break;

        const values = rows.map(row => columns.map(column => {
          const value = row[column];
          const valid = typeof value === 'number' || (column !== '_vq_row_id' && (value === null || typeof value === 'string'));
          if (!valid) throw new Error('Provider mirror values must be text, numbers, or NULL, with numeric row identities.');

          return value;
        }));

        await insertRowsChunked(mirror, placeholders => `INSERT INTO main.${quoteIdentifier(table)} (${quotedColumns}) VALUES ${placeholders}`, values, columns.length);
        lastId = Number(rows[rows.length - 1]._vq_row_id);
        count += rows.length;
      }

      if (count !== record.rowCount) throw new Error('Provider snapshot changed during mirror publication.');

      for (const guard of providerSnapshotGuards(table)) {
        await mirror.run(guard);
      }

      await mirror.run('INSERT INTO main._vq_provider_snapshots VALUES (?, ?, ?, ?, ?, ?, 1)',
        [table, record.providerId, record.definitionId, record.sourcePath, record.fingerprint, JSON.stringify(record)]);
    }
  });
}
