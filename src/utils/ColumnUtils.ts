const METADATA_COLUMNS = ['created', 'modified', 'title', 'size'];

export function filterRelevantColumns(columns: string[]): string[] {
  return columns.filter(column => column !== 'rowid'
    && !column.startsWith('sqlite_')
    && !column.startsWith('__')
    && !METADATA_COLUMNS.includes(column));
}
