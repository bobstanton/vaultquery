export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

export function quoteIdentifier(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function validateSqlIdentifier(identifier: string, label: string = 'SQL identifier'): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid ${label}: ${identifier}`);
  }
}

export function quoteValidatedIdentifier(identifier: string, label: string = 'SQL identifier'): string {
  validateSqlIdentifier(identifier, label);
  return quoteIdentifier(identifier);
}
