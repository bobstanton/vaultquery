export const ERROR_MESSAGES = {
  QUERY_UNSAFE_OPERATIONS: 'This query includes operations VaultQuery will not run.',
  PREVIEW_UNSAFE_OPERATIONS: 'This preview includes operations VaultQuery will not run.',
  WRITE_OPERATIONS_DISABLED: 'Write operations are off. Enable them in VaultQuery settings to preview changes.',
  WRITE_OPERATIONS_DISABLED_APPLY: 'Write operations are off. Enable them in VaultQuery settings to apply changes.',

  FILE_NOT_FOUND: (path: string) => `File not found: ${path}`,
  FILE_NOT_MARKDOWN: (path: string) => `File not found or not a markdown file: ${path}`,
  FILE_NOT_READABLE: (path: string) => `File not found or unreadable: ${path}`,

  DATABASE_READ_FAILED: (path: string, error: string) => `Could not read the database at '${path}': ${error}`,
  SQL_QUERY_FAILED: (error: string) => `Query failed: ${error}`,
  SQL_RUN_FAILED: (error: string) => `SQL statement failed: ${error}`,
  SQL_PREPARE_FAILED: 'Could not prepare SQL statement',
  SQL_STATEMENT_NOT_FOUND: 'Prepared statement was not available',

  PREVIEW_FAILED: (error: string) => `Preview failed: ${error}`,
  APPLY_FAILED: (error: string) => `Could not apply changes: ${error}`,

  DML_UNSUPPORTED_OPERATION: 'Only INSERT, UPDATE, and DELETE can be previewed.',
  DML_TABLE_NOT_FOUND: 'Could not identify the table being changed.',
  DML_INVALID_STATEMENT: (stmt: string) => `Unsupported statement: "${stmt}". Use INSERT, UPDATE, or DELETE.`,
  DML_TABLE_NOT_DETERMINED: (stmt: string) => `Could not identify the table in statement: "${stmt}"`,

  CONFIG_SEMICOLON_REQUIRED: 'End the SQL query with a semicolon before the config section.',
  TEMPLATE_SEMICOLON_REQUIRED: 'End the SQL query with a semicolon before the template section.',

  API_NOT_INITIALIZED: 'VaultQuery is not ready. The plugin may have been unloaded.',
  CHARTJS_INIT_FAILED: 'Could not start Chart.js',

  WRITE_SYNC_FAILED: (message: string) => `Could not sync changes back to the vault: ${message}`,
  INVALID_EDIT_RANGE: (start: number, end: number, length: number) =>
    `Invalid range [${start}, ${end}) for content length ${length}`,

  REFRESH_CONTAINER_NOT_FOUND: 'Could not find the block to refresh',
} as const;

export const WARNING_MESSAGES = {
  PRAGMA_OPTIMIZE_UNAVAILABLE: 'PRAGMA optimize not available',
  DATABASE_OPTIMIZATIONS_UNAVAILABLE: 'Some database optimizations are not available',
  STATEMENT_FREE_ERROR: 'Error freeing prepared statement',
  STATEMENT_RESET_ERROR: 'Error resetting statement',
  DUPLICATE_PROPERTY_SKIPPED: (path: string, key: string, index: number | null) =>
    `Skipping duplicate property for ${path}, key: ${key}, arrayIndex: ${index}`,
  DUPLICATE_FILES_IN_INPUT: (duplicates: string[]) =>
    `Duplicate files detected in input: ${duplicates.join(', ')}`,
  DUPLICATE_FILES_IN_BATCH: 'Duplicate files detected in batch, processing individually',
  DUPLICATE_NOTES_IN_BATCH: (count: number, duplicates: string[]) =>
    `Found ${count} duplicate notes in batch: ${duplicates.join(', ')}`,

  FILE_READ_FAILED: (path: string, error: string) => `Could not read file ${path}: ${error}`,
  FILE_CONTENT_READ_FAILED: (path: string) => `Could not read file content for ${path}`,

  NESTED_TEMPLATE_DETECTED: 'Skipped nested template render',
  MARKDOWN_RENDER_FAILED: 'Could not render markdown',
  SLICKGRID_RECREATE_FAILED: 'Could not recreate SlickGrid',
  SLICKGRID_DESTROY_ERROR: 'Error destroying SlickGrid instance',
  SLICKGRID_RESIZE_ERROR: 'Error resizing SlickGrid instance',

  CHART_CONFIG_PARSE_FAILED: 'Could not parse chart config; using defaults',
  SERIES_CONFIG_PARSE_FAILED: 'Could not parse series config',
  OPTIONS_CONFIG_PARSE_FAILED: 'Could not parse options config',
  TEMPLATE_PROPERTY_RESOLVE_FAILED: (property: string) => `Could not resolve template property '${property}'`,
  EXPRESSION_EVALUATE_FAILED: (expression: string) => `Could not evaluate expression '${expression}'`,
  FRONTMATTER_STRINGIFY_FAILED: 'Could not write frontmatter',

  EDIT_PLAN_WARNINGS: (count: number) => `${count} warning(s) while planning edits. Check the console for details.`,
  VIEW_CHECK_FAILED: 'Could not check whether the target is a view',
  EXPLAIN_ROOTPAGE_FAILED: 'Could not map target table with EXPLAIN; trying SQL text parsing',
  AUTO_SYNC_COMPARISON_ERROR: 'Error during auto-sync comparison',
} as const;

export const INFO_MESSAGES = {
  FILES_UPDATED: (count: number) => `Updated ${count} file(s)`,
  SYNC_FAILED: (message: string) => `VaultQuery could not sync changes: ${message}`,
} as const;

export const CONSOLE_ERRORS = {
  PLUGIN_LOAD_FAILED: 'Could not load VaultQuery',
  PLUGIN_INIT_FAILED: 'Could not initialize VaultQuery',
  PLUGIN_UNLOAD_ERROR: 'Error during plugin unload',
  DATABASE_CLOSE_ERROR: 'Error closing database',
  DATABASE_SAVE_FAILED: 'Could not save database to disk',
  DATABASE_ROLLBACK_FAILED: 'Transaction rollback failed - database may be in inconsistent state',
  DATABASE_SAVEPOINT_ROLLBACK_FAILED: 'Savepoint rollback failed - database may be in inconsistent state',

  INDEX_NOTE_FAILED: (path: string) => `Could not index note ${path}`,
  INDEX_FILE_FAILED: (path: string) => `Could not index file ${path}`,
  INDEXING_ERROR: (path: string) => `Error indexing ${path}`,
  REBUILD_INDEX_FAILED: 'Could not rebuild index',

  PENDING_BLOCK_ERROR: (processorName: string) => `Error processing pending ${processorName} block`,
  INVALID_QUERY_RESULTS: (type: string) => `Invalid results from query: ${type}`,

  WRITE_SYNC_ERROR: 'WriteSyncService error',
  APPLY_PREVIEW_FAILED: 'Could not apply preview',
  PREVIEW_FAILED: 'Preview failed',

  TABLE_CELL_INSERT_ERROR: (path: string) => `Error inserting table cell for ${path}`,
  BATCH_NOTE_ERROR: (path: string) => `Error processing batch note ${path}`,

  PROPERTY_KEYS_GET_ERROR: 'Error getting property keys',
  PROPERTIES_VIEW_REBUILD_ERROR: 'Error rebuilding properties view',
  TABLE_STRUCTURES_DISCOVER_ERROR: 'Error discovering table structures',
  TABLE_VIEWS_REBUILD_ERROR: 'Error rebuilding table views',

  INDEXED_FILES_ERROR: 'Error getting indexed files',
  NEEDS_INDEXING_CHECK_ERROR: 'Error checking if file needs indexing',

  TEMPLATE_RENDER_FAILED: 'Template rendering failed',
  CHARTJS_ERROR: 'Chart.js error',
  CHARTJS_REGISTRATION_FAILED: 'Chart.js registration failed',
  COPY_FAILED: 'Could not copy',
  REFRESH_FAILED: 'Could not refresh',
} as const;

export const PERFORMANCE_MESSAGES = {
  SLOW_FILE: (path: string, sizeKB: string, timeMs: string, details: string) =>
    `Slow file: ${path} (${sizeKB}KB, ${timeMs}ms, ${details})`,
} as const;

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return JSON.stringify(error);
}

export function friendlySqliteError(error: unknown, context?: { sql?: string; table?: string }): string {
  const message = getErrorMessage(error);

  if (message.includes('FOREIGN KEY constraint failed')) {
    let pathHint = '';
    if (context?.sql) {
      const pathMatch = context.sql.match(/VALUES\s*\([^)]*'([^']+\.md)'/i);
      if (pathMatch) {
        pathHint = ` The file '${pathMatch[1]}' does not exist in the vault.`;
      }
    }

    const tableHint = context?.table
      ? `When inserting into '${context.table}', the 'path' must reference an existing file in the 'notes' table.`
      : `The 'path' column must reference an existing file in the 'notes' table.`;

    return `Foreign key constraint failed: ${tableHint}${pathHint} Create the note first, or use a path that is already indexed.`;
  }

  const notNullMatch = message.match(/NOT NULL constraint failed: (\w+)\.(\w+)/);
  if (notNullMatch) {
    return `Missing required column: '${notNullMatch[2]}' cannot be NULL in table '${notNullMatch[1]}'.`;
  }

  const uniqueMatch = message.match(/UNIQUE constraint failed: (.+)/);
  if (uniqueMatch) {
    return `Duplicate value: ${uniqueMatch[1]} must be unique. A record with this value already exists.`;
  }

  const noColumnMatch = message.match(/no such column: (\w+)/i);
  if (noColumnMatch) {
    return `Unknown column: '${noColumnMatch[1]}'. Check the column name in the schema reference.`;
  }

  const tableNoColumnMatch = message.match(/table (\w+) has no column named (\w+)/i);
  if (tableNoColumnMatch) {
    return `Unknown column: '${tableNoColumnMatch[2]}' in table '${tableNoColumnMatch[1]}'. Check the schema reference.`;
  }

  const noTableMatch = message.match(/no such table: (\w+)/i);
  if (noTableMatch) {
    return `Unknown table: '${noTableMatch[1]}'. The name may be wrong or its indexing option disabled.`;
  }

  return message;
}
