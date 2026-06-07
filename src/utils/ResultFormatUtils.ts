export function scalarFromResults(results: Record<string, unknown>[]): string {
  const firstRow = results[0];
  if (!firstRow) {
    return '';
  }

  const firstColumn = Object.keys(firstRow)[0];
  if (!firstColumn) {
    return '';
  }

  const value = firstRow[firstColumn];
  return value == null ? '' : String(value);
}

export interface ResultColumnOptions {
  includeHidden?: boolean;
  scanAllRows?: boolean;
}

export interface MarkdownFormatOptions extends ResultColumnOptions {
  columns?: string[];
  emptyResult?: string;
  emptyColumns?: string;
  newlineReplacement?: string;
  formatValues?: boolean;
}

export function getResultColumns(results: Record<string, unknown>[], options: ResultColumnOptions = {}): string[] {
  if (results.length === 0) {
    return [];
  }

  const includeColumn = (column: string) => options.includeHidden === true || !column.startsWith('_');

  if (!options.scanAllRows) {
    return Object.keys(results[0]).filter(includeColumn);
  }

  const columns = new Set<string>();
  for (const row of results) {
    Object.keys(row)
      .filter(includeColumn)
      .forEach(column => columns.add(column));
  }

  return Array.from(columns);
}

export function formatResultsAsMarkdown(results: Record<string, unknown>[], options: MarkdownFormatOptions = {}): string {
  if (results.length === 0) {
    return options.emptyResult ?? '';
  }

  const visibleColumns = options.columns && options.columns.length > 0
    ? options.columns
    : getResultColumns(results, options);

  if (visibleColumns.length === 0) {
    return options.emptyColumns ?? '';
  }

  const newlineReplacement = options.newlineReplacement ?? '<br>';
  const headerRow = '| ' + visibleColumns.join(' | ') + ' |';
  const separatorRow = '| ' + visibleColumns.map(() => '---').join(' | ') + ' |';

  const dataRows = results.map(row => {
    const cells = visibleColumns.map(column => {
      const value = row[column];
      if (value == null) return '';

      const str = options.formatValues === true
        ? formatValueForMarkdown(value)
        : String(value);

      return str
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, newlineReplacement)
        .replace(/\r/g, '');
    });
    return '| ' + cells.join(' | ') + ' |';
  });

  return [headerRow, separatorRow, ...dataRows].join('\n');
}

export function formatResultsAsDelimited(results: Record<string, unknown>[], delimiter: ',' | '\t', options: ResultColumnOptions = {}): string {
  if (results.length === 0) {
    return '';
  }

  const columns = getResultColumns(results, { ...options, scanAllRows: options.scanAllRows ?? true });
  const rows = [
    columns.map(column => escapeDelimitedCell(column, delimiter)).join(delimiter),
    ...results.map(row => columns.map(column => escapeDelimitedCell(row[column], delimiter)).join(delimiter))
  ];

  return rows.join('\n');
}

function stringifyCell(value: unknown): string {
  return value == null ? '' : String(value);
}

function escapeDelimitedCell(value: unknown, delimiter: ',' | '\t'): string {
  const str = stringifyCell(value).replace(/\r?\n/g, ' ');
  if (delimiter === '\t') {
    return str.replace(/\t/g, ' ');
  }

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

function formatValueForMarkdown(value: unknown): string {
  const strValue = String(value);

  if (/^\d{13}$/.test(strValue)) {
    return formatTimestampValue(strValue);
  }

  return formatIsoDateString(strValue);
}

export function formatTimestampValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return trimmed;
    }
  }

  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 'N/A';
  }

  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    return 'Invalid Date';
  }

  return date.toLocaleString();
}

export function formatIsoDateString(dateStr: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString();
    }
  }

  return dateStr;
}
