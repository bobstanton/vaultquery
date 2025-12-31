export const ERROR_MESSAGES = {
  QUERY_UNSAFE_OPERATIONS: 'Query contains potentially unsafe operations',
  PREVIEW_UNSAFE_OPERATIONS: 'Preview query contains potentially unsafe operations',
  WRITE_OPERATIONS_DISABLED: 'Write operations are disabled. Enable them in settings to use preview functionality.',
  WRITE_OPERATIONS_DISABLED_APPLY: 'Write operations are disabled. Enable them in settings to apply changes.',

  FILE_NOT_FOUND: (path: string) => `File not found: ${path}`,
  FILE_NOT_MARKDOWN: (path: string) => `File not found or not a markdown file: ${path}`,
  FILE_NOT_READABLE: (path: string) => `File not found or unreadable: ${path}`,

  DATABASE_READ_FAILED: (path: string, error: string) => `Failed to read existing database from disk at '${path}': ${error}`,
  SQL_QUERY_FAILED: (error: string) => `SQL query failed: ${error}`,
  SQL_RUN_FAILED: (error: string) => `SQL run failed: ${error}`,
  SQL_PREPARE_FAILED: 'Failed to prepare SQL statement',
  SQL_STATEMENT_NOT_FOUND: 'Failed to get prepared statement',

  PREVIEW_FAILED: (error: string) => `Preview failed: ${error}`,
  APPLY_FAILED: (error: string) => `Failed to apply changes: ${error}`,

  DML_UNSUPPORTED_OPERATION: 'Only INSERT, UPDATE, or DELETE are supported.',
  DML_TABLE_NOT_FOUND: 'Could not determine target table via EXPLAIN rootpage mapping.',
  DML_INVALID_STATEMENT: (stmt: string) => `Invalid statement detected: "${stmt}". Only INSERT, UPDATE, or DELETE are supported.`,
  DML_TABLE_NOT_DETERMINED: (stmt: string) => `Could not determine target table for statement: "${stmt}"`,

  CONFIG_SEMICOLON_REQUIRED: 'Configuration section requires SQL query to end with a semicolon (;)',
  TEMPLATE_SEMICOLON_REQUIRED: 'Template configuration requires SQL query to end with a semicolon (;)',

  API_NOT_INITIALIZED: 'VaultQuery API is not initialized. Plugin may have been unloaded.',
  CHARTJS_INIT_FAILED: 'Failed to initialize Chart.js components',

  WRITE_SYNC_FAILED: (message: string) => `Write sync operation failed: ${message}`,
  INVALID_EDIT_RANGE: (start: number, end: number, length: number) =>
    `Invalid range [${start}, ${end}) for content length ${length}`,

  REFRESH_CONTAINER_NOT_FOUND: 'Could not find parent container for refresh',
} as const;

export const WARNING_MESSAGES = {
  PRAGMA_OPTIMIZE_UNAVAILABLE: 'PRAGMA optimize not available',
  DATABASE_OPTIMIZATIONS_UNAVAILABLE: 'Some database optimizations not available',
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
  FILE_CONTENT_READ_FAILED: (path: string) => `Failed to read file content for ${path}`,

  NESTED_TEMPLATE_DETECTED: 'Detected nested template render attempt, skipping to prevent recursion',
  MARKDOWN_RENDER_FAILED: 'Failed to render markdown',
  SLICKGRID_RECREATE_FAILED: 'Failed to recreate SlickGrid',
  SLICKGRID_DESTROY_ERROR: 'Error destroying SlickGrid instance',
  SLICKGRID_RESIZE_ERROR: 'Error resizing SlickGrid instance',

  CHART_CONFIG_PARSE_FAILED: 'Failed to parse chart config, using defaults',
  SERIES_CONFIG_PARSE_FAILED: 'Failed to parse series config',
  OPTIONS_CONFIG_PARSE_FAILED: 'Failed to parse options config',
  TEMPLATE_PROPERTY_RESOLVE_FAILED: (property: string) => `Failed to resolve template property '${property}'`,
  EXPRESSION_EVALUATE_FAILED: (expression: string) => `Failed to evaluate expression '${expression}'`,
  FRONTMATTER_STRINGIFY_FAILED: 'Failed to stringify frontmatter object',

  EDIT_PLAN_WARNINGS: (count: number) => `${count} warnings during edit planning. Check console for details.`,
  VIEW_CHECK_FAILED: 'Failed to check if target is a view',
  EXPLAIN_ROOTPAGE_FAILED: 'EXPLAIN rootpage mapping failed, falling back to regex parsing',
} as const;

export const INFO_MESSAGES = {
  FILES_UPDATED: (count: number) => `Successfully updated ${count} file(s)`,
  SYNC_FAILED: (message: string) => `VaultQuery sync failed: ${message}`,
} as const;

export const CONSOLE_ERRORS = {
  PLUGIN_LOAD_FAILED: 'Failed to load VaultQuery plugin',
  PLUGIN_INIT_FAILED: 'Failed to initialize plugin',
  PLUGIN_UNLOAD_ERROR: 'Error during plugin unload',
  DATABASE_CLOSE_ERROR: 'Error closing database',
  DATABASE_SAVE_FAILED: 'Failed to save database to disk',
  DATABASE_ROLLBACK_FAILED: 'Transaction rollback failed - database may be in inconsistent state',
  DATABASE_SAVEPOINT_ROLLBACK_FAILED: 'Savepoint rollback failed - database may be in inconsistent state',

  INDEX_NOTE_FAILED: (path: string) => `Failed to index note ${path}`,
  INDEX_FILE_FAILED: (path: string) => `Failed to index file ${path}`,
  INDEXING_ERROR: (path: string) => `Error indexing ${path}`,
  REBUILD_INDEX_FAILED: 'Failed to rebuild index',

  PENDING_BLOCK_ERROR: (processorName: string) => `Error processing pending ${processorName} block`,
  INVALID_QUERY_RESULTS: (type: string) => `Invalid results from query: ${type}`,

  WRITE_SYNC_ERROR: 'WriteSyncService error',
  APPLY_PREVIEW_FAILED: 'Apply preview failed',
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
  COPY_FAILED: 'Copy failed',
  REFRESH_FAILED: 'Refresh failed',
} as const;

export const PERFORMANCE_MESSAGES = {
  SLOW_FILE: (path: string, sizeKB: string, timeMs: string, details: string) =>
    `Very slow file: ${path} (${sizeKB}KB, ${timeMs}ms, ${details})`,
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

    return `Foreign key constraint failed: ${tableHint}${pathHint} Create the note first, or use an existing file path.`;
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
    return `Unknown column: '${noColumnMatch[1]}'. Check the column name or use the schema reference to see available columns.`;
  }

  const tableNoColumnMatch = message.match(/table (\w+) has no column named (\w+)/i);
  if (tableNoColumnMatch) {
    return `Unknown column: '${tableNoColumnMatch[2]}' does not exist in table '${tableNoColumnMatch[1]}'. Check the schema reference for available columns.`;
  }

  const noTableMatch = message.match(/no such table: (\w+)/i);
  if (noTableMatch) {
    return `Unknown table: '${noTableMatch[1]}'. Check that the table name is correct and the corresponding indexing feature is enabled in settings.`;
  }

  return message;
}
