import { Database } from 'sql.js';
import { generateDynamicPropertiesView, generateNotePropertiesView, generateDynamicTableViews } from './DatabaseSchema';
import { SQL_QUERIES, getViewColumnsPragma, processTableStructureResults } from './SchemaQueries';
import { CONSOLE_ERRORS } from '../utils/ErrorMessages';
import { hashString } from '../utils/StringUtils';
import type { TableStructure } from './DatabaseSchema';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('DatabaseSchema');

export class DatabaseSchemaManager {
  private lastTableStructuresHash: string | null = null;

  public onPropertiesViewRebuilt: (() => void) | null = null;

  public constructor(private db: Database) {}

  private queryStrings(sql: string, columnIndex: number = 0): string[] {
    try {
      const result = this.db.exec(sql);
      if (result.length === 0 || result[0].values.length === 0) {
        return [];
      }
      return result[0].values.map(row => row[columnIndex] as string);
    } catch (error) {
      logger.error('Database schema query failed', { sql, columnIndex }, error);
      throw error;
    }
  }

  getAllPropertyKeys(): string[] {
    return this.queryStrings(SQL_QUERIES.GET_ALL_PROPERTY_KEYS);
  }

  getViewNames(): string[] {
    return this.queryStrings(SQL_QUERIES.GET_VIEW_NAMES);
  }

  getViewColumns(viewName: string): string[] {
    return this.queryStrings(getViewColumnsPragma(viewName), 1);
  }

  rebuildPropertiesView(): void {
    try {
      const propertyKeys = this.getAllPropertyKeys();
      const viewSQL = generateDynamicPropertiesView(propertyKeys);
      this.db.exec(viewSQL);
      const notePropertiesSQL = generateNotePropertiesView(propertyKeys);
      this.db.exec(notePropertiesSQL);
      this.onPropertiesViewRebuilt?.();
    }

    catch (error) {
      logger.error(CONSOLE_ERRORS.PROPERTIES_VIEW_REBUILD_ERROR, error);
      throw error;
    }
  }

  discoverTableStructures(): TableStructure[] {
    try {
      const result = this.db.exec(SQL_QUERIES.DISCOVER_TABLE_STRUCTURES);

      if (result.length === 0 || result[0].values.length === 0) {
        return [];
      }

      return processTableStructureResults(result[0].values);
    }

    catch (error) {
      logger.error(CONSOLE_ERRORS.TABLE_STRUCTURES_DISCOVER_ERROR, error);
      return [];
    }
  }

  rebuildTableViews(enableDynamicTableViews: boolean): void {
    if (!enableDynamicTableViews) {
      return;
    }

    try {
      const structures = this.discoverTableStructures();

      if (structures.length === 0) {
        return;
      }

      // Skip the DROP/CREATE churn when nothing changed. This runs after every
      // realtime indexing drain, and most saves don't alter table structures.
      const structuresHash = hashString(JSON.stringify(structures));
      if (structuresHash === this.lastTableStructuresHash) {
        return;
      }

      const viewSQL = generateDynamicTableViews(structures);

      if (viewSQL) {
        this.db.exec(viewSQL);
      }
      this.lastTableStructuresHash = structuresHash;
    }

    catch (error) {
      logger.error(CONSOLE_ERRORS.TABLE_VIEWS_REBUILD_ERROR, error);
    }
  }
}
