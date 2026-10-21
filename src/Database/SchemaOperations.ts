import { ensureOtherFileSchema } from '../OtherFiles/OtherFileDatabaseOperations';
import { ensureImageSchema } from '../Images/ImageDatabaseOperations';
import { ensureExternalFolderSchema } from '../External/ExternalFolderSchema';
import type { Database } from 'sql.js';
import { getTablesOnlySQL, getIndexesForFeatures, generatePropertiesMatRefreshSql, PROPERTIES_MAT_TABLE } from './DatabaseSchema';
import type { EnabledFeatures } from './DatabaseSchema';
import { PRAGMA_STATEMENTS } from './SchemaQueries';

export const DEFAULT_ENABLED_FEATURES: EnabledFeatures = {
  indexContent: true,
  indexFrontmatter: true,
  indexTables: true,
  indexTasks: true,
  indexHeadings: true,
  indexLinks: true,
  indexUnresolvedLinks: true,
  indexEmbeds: true,
  indexTags: true,
  indexListItems: true,
  indexBlocks: true
};

export function execSchemaBundle(db: Database, sql: string): void {
  db.run('BEGIN');

  try {
    db.run('PRAGMA foreign_keys = ON;');
    db.exec(sql);
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

export function createSchema(db: Database): void {
  execSchemaBundle(db, getTablesOnlySQL());

  ensureOtherFileSchema(db);
  ensureImageSchema(db);
  ensureExternalFolderSchema(db);
}

export interface IndexCreationState {
  indexesCreated: boolean;
  enabledFeatures: EnabledFeatures | null;
}

export function createIndexes(db: Database, features: EnabledFeatures | undefined, state: IndexCreationState, logError: (message: string, error: unknown) => void): void {
  if (features) {
    state.enabledFeatures = features;
  }

  if (state.indexesCreated) return;

  try {
    execSchemaBundle(db, getIndexesForFeatures(state.enabledFeatures ?? DEFAULT_ENABLED_FEATURES));
    state.indexesCreated = true;
  } catch (error) {
    logError('Error creating indexes', error);
  }
}

export function runPragmaStatements(db: Database, onWarn: (error: unknown) => void): void {
  try {
    for (const pragma of PRAGMA_STATEMENTS) {
      db.run(pragma);
    }
  } catch (error) {
    onWarn(error);
  }
}

export class MatRefreshSqlCache {
  private cache: { deleteSql: string; insertSql: string } | null | undefined = undefined;

  public invalidate(): void {
    this.cache = undefined;
  }

  public get(db: Database, getAllPropertyKeys: () => string[]): { deleteSql: string; insertSql: string } | null {
    if (this.cache === undefined) {
      const pragma = db.exec(`PRAGMA table_info(${PROPERTIES_MAT_TABLE})`);
      const columns = (pragma[0]?.values ?? []).map(row => String(row[1]));
      this.cache = columns.length === 0 ? null : generatePropertiesMatRefreshSql(getAllPropertyKeys(), columns);
    }

    return this.cache;
  }
}
