import type { TableStructure } from './DatabaseSchema';

/**
 * PRAGMA statements to run when initializing a database connection.
 * These optimize performance and enable required features like foreign keys.
 * Used by both DatabaseService (main thread) and database.worker.ts (worker thread).
 */
export const PRAGMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON',
  'PRAGMA recursive_triggers = ON',  // Enable triggers to fire from within triggers (needed for cascading)
  'PRAGMA journal_mode = MEMORY',
  'PRAGMA synchronous = OFF',
  'PRAGMA cache_size = -64000',   // 64MB cache (negative = KB)
  'PRAGMA temp_store = MEMORY',
  'PRAGMA locking_mode = EXCLUSIVE',
  'PRAGMA page_size = 4096',
  'PRAGMA mmap_size = 268435456', // 256MB memory-mapped I/O
] as const;

export const SQL_QUERIES = {
  GET_ALL_PROPERTY_KEYS: 'SELECT DISTINCT key FROM properties WHERE array_index IS NULL ORDER BY key',
  GET_VIEW_NAMES: "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name",
  DISCOVER_TABLE_STRUCTURES: `
    SELECT
      json_group_array(DISTINCT column_name) as columns,
      json_group_array(DISTINCT table_name) as table_names,
      COUNT(DISTINCT path || ':' || table_index) as table_count
    FROM table_cells
    GROUP BY path, table_index
    ORDER BY table_count DESC
  `,
} as const;

export function getViewColumnsPragma(viewName: string): string {
  return `PRAGMA table_info('${viewName.replace(/'/g, "''")}')`;
}

function sanitizeIdentifier(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/^([0-9])/, 'n$1');
}

function findCommonTableName(tableNames: string[]): string | null {
  if (tableNames.length === 0) return null;
  if (tableNames.length === 1) return tableNames[0];

  const sorted = tableNames.slice().sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let commonPrefix = '';

  for (let i = 0; i < first.length; i++) {
    if (first[i] === last[i]) {
      commonPrefix += first[i];
    } else {
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
    } else {
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

export function processTableStructureResults(rows: unknown[][]): TableStructure[] {
  if (rows.length === 0) {
    return [];
  }

  const structureMap = new Map<string, { columns: string[], tableNames: string[] }>();

  for (const row of rows) {
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
      const commonName = findCommonTableName(data.tableNames);
      baseName = sanitizeIdentifier(commonName || data.tableNames[0]);

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
    } else {
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
