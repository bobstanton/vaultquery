import { BATCH_DELETE_CHUNK_SIZE } from './IndexingQueries';

type DeleteChunkRunner = (sql: string, params: number[]) => void;

export function batchDeleteRowsByIds(tableName: string, ids: number[], run: DeleteChunkRunner): void {
  if (ids.length === 0) return;

  for (let i = 0; i < ids.length; i += BATCH_DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + BATCH_DELETE_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    run(`DELETE FROM ${tableName} WHERE id IN (${placeholders})`, chunk);
  }
}
