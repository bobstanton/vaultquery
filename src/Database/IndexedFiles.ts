import { CONSOLE_ERRORS } from '../utils/ErrorMessages';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('IndexedFiles');

interface IndexedFilesDatabase {
  all(sql: string, params?: (string | number | null)[]): Promise<Record<string, unknown>[]>;
}

interface IndexedFileRecord {
  path: string;
  modified: number;
}

export async function getIndexedFilesFromDatabase(database: IndexedFilesDatabase): Promise<IndexedFileRecord[]> {
  try {
    const results = await database.all('SELECT path, modified FROM notes');
    return results.map(row => ({
      path: row.path as string,
      modified: row.modified as number
    }));
  }
  catch (error) {
    logger.error(CONSOLE_ERRORS.INDEXED_FILES_ERROR, error);
    return [];
  }
}
