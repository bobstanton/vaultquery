import { escapeHTML } from './StringUtils';

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

  static formatProposedValue(value: unknown, html: (s: string) => string): string {
    const escaped = escapeHTML(String(value ?? ''));
    return html(`<span class="vaultquery-proposed-value" style="color: var(--text-success); font-weight: 600;">${escaped}</span>`);
  }

  static formatCurrentValue(value: unknown, html: (s: string) => string): string {
    const escaped = escapeHTML(String(value ?? ''));
    return html(`<span class="vaultquery-current-value" style="color: var(--text-error); text-decoration: line-through;">${escaped}</span>`);
  }

  static prepareColumnData(results: Record<string, unknown>[], columnKeys: string[]): unknown[][] {
    return results.map(row =>
      columnKeys.map(key => {
        const value = row[key];
        return value !== undefined && value !== null ? value : '';
      })
    );
  }
}
