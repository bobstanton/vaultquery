import type { Database } from 'sql.js';
import { generateDynamicPropertiesView, generateNotePropertiesView, generateDynamicTableViews } from './DatabaseSchema';
import { SQL_QUERIES, getViewColumnsPragma, processTableStructureResults } from './SchemaQueries';
import { hashString } from '../utils/StringUtils';
import type { TableStructure } from './DatabaseSchema';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('DatabaseSchema');

export class DatabaseSchemaManager {
  private lastTableStructuresHash: string | null = null;

  public onPropertiesViewRebuilt: (() => void) | null = null;

  public constructor(private db: Database, private beforeSchemaChange: () => void = () => {}) {}

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
      this.beforeSchemaChange();
      this.db.exec(viewSQL);
      const notePropertiesSQL = generateNotePropertiesView(propertyKeys);
      this.db.exec(notePropertiesSQL);
      this.onPropertiesViewRebuilt?.();
    }

    catch (error) {
      logger.error('Error rebuilding properties view', error);
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
      logger.error('Error discovering table structures', error);

      return [];
    }
  }

  rebuildTableViews(enableDynamicTableViews: boolean): boolean {
    if (!enableDynamicTableViews) {
      return false;
    }

    try {
      const structures = this.discoverTableStructures();

      if (structures.length === 0) {
        return false;
      }

      // Skip the DROP/CREATE churn when nothing changed. This runs after every
      // realtime indexing drain, and most saves don't alter table structures.
      const structuresHash = hashString(JSON.stringify(structures));

      if (structuresHash === this.lastTableStructuresHash) {
        return false;
      }

      const viewSQL = generateDynamicTableViews(structures);

      if (viewSQL) {
        this.beforeSchemaChange();
        this.db.exec(viewSQL);
      }

      this.lastTableStructuresHash = structuresHash;

      return Boolean(viewSQL);
    }

    catch (error) {
      logger.error('Error rebuilding table views', error);

      return false;
    }
  }
}
