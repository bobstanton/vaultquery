export function csvVisibleColumns(row: Record<string, unknown>, allowlist?: readonly string[]): string[] {
  return allowlist ? allowlist.filter(key => Object.prototype.hasOwnProperty.call(row, key))
    : Object.keys(row).filter(key => !key.startsWith('_'));
}

export function csvGridColumnId(field: string): string {
  return `_vq_csv_column_${encodeURIComponent(field).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`;
}
