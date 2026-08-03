import type { Database } from 'sql.js';
import type { DatabaseHealth } from '../VaultQueryAPI';
import { getErrorMessage } from '../utils/ErrorMessages';

export function checkSqlJsDatabaseHealth(db: Database | null, baseDiagnostics: Record<string, unknown>): DatabaseHealth {
  const diagnostics: Record<string, unknown> = { ...baseDiagnostics, hasDb: !!db };

  try {
    if (!db) {
      return {
        healthy: false,
        error: 'Database not initialized',
        diagnostics,
      };
    }

    const tableResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'");
    const notesTableExists = tableResult.length > 0 && tableResult[0].values.length > 0;
    diagnostics.notesTableExists = notesTableExists;

    if (!notesTableExists) {
      const allTables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
      diagnostics.existingTables = allTables.length > 0
        ? allTables[0].values.map(row => row[0])
        : [];

      return {
        healthy: false,
        error: 'notes table does not exist',
        diagnostics,
      };
    }

    const countResult = db.exec('SELECT COUNT(*) FROM notes');
    diagnostics.noteCount = countResult.length > 0 ? countResult[0].values[0][0] : 0;

    return { healthy: true, diagnostics };
  }
  catch (error) {
    const message = getErrorMessage(error);
    diagnostics.exceptionType = error instanceof Error ? error.constructor.name : typeof error;
    diagnostics.exceptionMessage = message;

    return {
      healthy: false,
      error: `Database query failed: ${message}`,
      diagnostics,
    };
  }
}
