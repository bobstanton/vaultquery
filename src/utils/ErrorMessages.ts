export const ERROR_MESSAGES = {
  QUERY_UNSAFE_OPERATIONS: 'This query includes operations VaultQuery will not run.',
  PREVIEW_UNSAFE_OPERATIONS: 'This preview includes operations VaultQuery will not run.',
  WRITE_OPERATIONS_DISABLED: 'Write operations are off. Enable them in VaultQuery settings to preview changes.',
  WRITE_OPERATIONS_DISABLED_APPLY: 'Write operations are off. Enable them in VaultQuery settings to apply changes.',

  FILE_NOT_FOUND: (path: string) => `File not found: ${path}`,
  FILE_NOT_MARKDOWN: (path: string) => `File not found or not a markdown file: ${path}`,

  DATABASE_READ_FAILED: (path: string, error: string) => `Could not read the database at '${path}': ${error}`,
  SQL_QUERY_FAILED: (error: string) => `Query failed: ${error}`,
  SQL_RUN_FAILED: (error: string) => `SQL statement failed: ${error}`,
  SQL_PREPARE_FAILED: 'Could not prepare SQL statement',

  PREVIEW_FAILED: (error: string) => `Preview failed: ${error}`,
  APPLY_FAILED: (error: string) => `Could not apply changes: ${error}`,

  DML_UNSUPPORTED_OPERATION: 'Only INSERT, UPDATE, and DELETE can be previewed.',
  DML_TABLE_NOT_FOUND: 'Could not identify the table being changed.',
  DML_INVALID_STATEMENT: (stmt: string) => `Unsupported statement: "${stmt}". Use INSERT, UPDATE, or DELETE.`,
  DML_TABLE_NOT_DETERMINED: (stmt: string) => `Could not identify the table in statement: "${stmt}"`,

  WRITE_SYNC_FAILED: (message: string) => `Could not sync changes back to the vault: ${message}`,
} as const;

export const INFO_MESSAGES = {
  FILES_UPDATED: (count: number) => `Updated ${count} file(s)`,
  CHANGES_SKIPPED: (count: number) => `${count} change(s) skipped - see developer console`,
  SYNC_FAILED: (message: string) => `VaultQuery could not sync changes: ${message}`,
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
