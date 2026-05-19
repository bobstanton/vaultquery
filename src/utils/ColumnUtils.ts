export class ColumnUtils {
  private static readonly metadataColumns = ['created', 'modified', 'title', 'size'];

  public static filterRelevantColumns(columns: string[]): string[] {
    return columns.filter(col =>
      col !== 'rowid' &&
      !col.startsWith('sqlite_') &&
      !col.startsWith('__') &&
      !this.metadataColumns.includes(col)
    );
  }

}
