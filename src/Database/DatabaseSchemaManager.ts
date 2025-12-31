import { Database } from 'sql.js';
import { generateDynamicPropertiesView, generateNotePropertiesView, generateDynamicTableViews } from './DatabaseSchema';
import { CONSOLE_ERRORS } from '../utils/ErrorMessages';
import type { TableStructure } from './DatabaseSchema';

export class DatabaseSchemaManager {
  public constructor(private db: Database) {}

  getAllPropertyKeys(): string[] {
    try {
      const result = this.db.exec('SELECT DISTINCT key FROM properties WHERE array_index IS NULL ORDER BY key');
      if (result.length === 0 || result[0].values.length === 0) {
        return [];
      }
      return result[0].values.map(row => row[0] as string);
    }

    catch (error) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.PROPERTY_KEYS_GET_ERROR}:`, error);
      return [];
    }
  }

  getViewNames(): string[] {
    try {
      const result = this.db.exec("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name");
      if (result.length === 0 || result[0].values.length === 0) {
        return [];
      }
      return result[0].values.map(row => row[0] as string);
    }

    catch (e) {
      console.warn('[VaultQuery] DatabaseSchemaManager.getViewNames: Query failed (view names are optional)', e);
      return [];
    }
  }

  getViewColumns(viewName: string): string[] {
    try {
      const result = this.db.exec(`PRAGMA table_info('${viewName.replace(/'/g, "''")}')`);
      if (result.length === 0 || result[0].values.length === 0) {
        return [];
      }
      // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
      // Column name is at index 1
      return result[0].values.map(row => row[1] as string);
    }

    catch (e) {
      console.warn('[VaultQuery] DatabaseSchemaManager.getViewColumns: PRAGMA query failed', viewName, e);
      return [];
    }
  }

  rebuildPropertiesView(): void {
    try {
      const propertyKeys = this.getAllPropertyKeys();
      const viewSQL = generateDynamicPropertiesView(propertyKeys);
      this.db.exec(viewSQL);
      const notePropertiesSQL = generateNotePropertiesView(propertyKeys);
      this.db.exec(notePropertiesSQL);
    }

    catch (error) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.PROPERTIES_VIEW_REBUILD_ERROR}:`, error);
      throw error;
    }
  }

  discoverTableStructures(): TableStructure[] {
    try {
      const result = this.db.exec(`
        SELECT
          json_group_array(DISTINCT column_name) as columns,
          json_group_array(DISTINCT table_name) as table_names,
          COUNT(DISTINCT path || ':' || table_index) as table_count
        FROM table_cells
        GROUP BY path, table_index
        ORDER BY table_count DESC
      `);

      if (result.length === 0 || result[0].values.length === 0) {
        return [];
      }

      const structureMap = new Map<string, { columns: string[], tableNames: string[] }>();

      for (const row of result[0].values) {
        const columns = JSON.parse(row[0] as string) as string[];
        const tableNames = JSON.parse(row[1] as string) as string[];

        const columnSignature = columns.slice().sort().join('|');

        if (!structureMap.has(columnSignature)) {
          structureMap.set(columnSignature, {
            columns: columns,
            tableNames: []
          });
        }

        const structure = structureMap.get(columnSignature)!;
        for (const tableName of tableNames) {
          if (tableName && tableName !== 'null' && !structure.tableNames.includes(tableName)) {
            structure.tableNames.push(tableName);
          }
        }
      }

      const structures: TableStructure[] = [];
      const usedViewNames = new Set<string>();
      let index = 0;

      for (const [, data] of structureMap) {
        let viewName: string;
        let baseName: string;

        if (data.tableNames.length > 0) {
          const commonName = this.findCommonTableName(data.tableNames);
          baseName = this.sanitizeIdentifier(commonName || data.tableNames[0]);

          if (!baseName) {
            baseName = 'unnamed';
          }
          viewName = baseName + '_table';

          let suffix = 1;
          while (usedViewNames.has(viewName)) {
            suffix++;
            viewName = `${baseName}_${suffix}_table`;
          }
          usedViewNames.add(viewName);
        }

        else {
          viewName = `table_view_${index}`;
        }

        structures.push({
          viewName: viewName,
          columns: data.columns,
          tableNames: data.tableNames
        });

        index++;
      }

      return structures;
    }

    catch (error) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.TABLE_STRUCTURES_DISCOVER_ERROR}:`, error);
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

      const viewSQL = generateDynamicTableViews(structures);

      if (viewSQL) {
        this.db.exec(viewSQL);
      }
    }

    catch (error) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.TABLE_VIEWS_REBUILD_ERROR}:`, error);
    }
  }

  private sanitizeIdentifier(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '')
      .replace(/^([0-9])/, 'n$1'); // Prefix with 'n' if starts with number
  }

  private findCommonTableName(tableNames: string[]): string | null {
    if (tableNames.length === 0) return null;
    if (tableNames.length === 1) return tableNames[0];

    // Find longest common prefix
    const sorted = tableNames.slice().sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let commonPrefix = '';

    for (let i = 0; i < first.length; i++) {
      if (first[i] === last[i]) {
        commonPrefix += first[i];
      }

      else {
        break;
      }
    }

    commonPrefix = commonPrefix.replace(/_per_?$/, '').replace(/_+$/, '');

    if (commonPrefix.length >= 3) {
      return commonPrefix;
    }

    const reversedNames = tableNames.map(name => name.split('').reverse().join(''));
    const reversedFirst = reversedNames.sort()[0];
    const reversedLast = reversedNames[reversedNames.length - 1];
    let commonSuffix = '';

    for (let i = 0; i < reversedFirst.length; i++) {
      if (reversedFirst[i] === reversedLast[i]) {
        commonSuffix += reversedFirst[i];
      }

      else {
        break;
      }
    }

    commonSuffix = commonSuffix.split('').reverse().join('');
    commonSuffix = commonSuffix.replace(/^_?per_/, '').replace(/^_+/, '');

    if (commonSuffix.length >= 3) {
      return commonSuffix;
    }

    return null;
  }
}
