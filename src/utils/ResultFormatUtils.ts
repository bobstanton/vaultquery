export function assertTextResults(results: readonly Record<string, unknown>[]): void {
  if (results.some(row => Object.values(row).some(value => value instanceof Uint8Array))) {
    throw new Error('Binary values require an explicit SQL conversion such as hex(content) for text output.');
  }
}

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

  return formatUnknownValue(value);
}

export function formatUnknownValue(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Uint8Array) return `[Binary: ${value.byteLength} bytes]`;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return '[Function]';

  try {
    const json = JSON.stringify(value);

    return json ?? '';
  }
  catch {
    return Object.prototype.toString.call(value);
  }
}

export interface ResultColumnOptions {
  columns?: readonly string[];
  preserveText?: boolean;
  includeHidden?: boolean;
  scanAllRows?: boolean;
}

export interface MarkdownFormatOptions extends ResultColumnOptions {
  columns?: string[];
  emptyResult?: string;
  emptyColumns?: string;
  newlineReplacement?: string;
  formatValues?: boolean;
  escapeColumnNames?: boolean;
}

export function resultColumns(results: Record<string, unknown>[], options: ResultColumnOptions = {}): string[] {
  if (results.length === 0) {
    return [];
  }

  if (options.columns) return [...options.columns];

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
  assertTextResults(results);

  if (results.length === 0) {
    return options.emptyResult ?? '';
  }

  const visibleColumns = options.columns && options.columns.length > 0
    ? options.columns
    : resultColumns(results, options);

  if (visibleColumns.length === 0) {
    return options.emptyColumns ?? '';
  }

  const newlineReplacement = options.newlineReplacement ?? '<br>';

  return [...markdownHeaderLines(visibleColumns, options),
    ...results.map(row => markdownRowLine(row, visibleColumns, { ...options, newlineReplacement }))].join('\n');
}

export function markdownHeaderLines(columns: readonly string[], options: MarkdownFormatOptions = {}): [string, string] {
  return [
    '| ' + columns.map(column => options.escapeColumnNames
      ? column.replace(/&/g, '&amp;').replace(/([\\|`*_[\]<>])/g, '\\$1') : column).join(' | ') + ' |',
    '| ' + columns.map(() => '---').join(' | ') + ' |',
  ];
}

export function markdownRowLine(row: Record<string, unknown>, columns: readonly string[], options: MarkdownFormatOptions = {}): string {
  const newlineReplacement = options.newlineReplacement ?? '<br>';

  const cells = columns.map(column => {
    const value = row[column];
    if (value == null) return '';

    const str = options.formatValues === true
      ? formatDisplayValue(value, column, options.preserveText)
      : formatUnknownValue(value);

    return str
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, newlineReplacement)
      .replace(/\r/g, '');
  });

  return '| ' + cells.join(' | ') + ' |';
}

export function formatResultsAsDelimited(results: Record<string, unknown>[], delimiter: ',' | '\t', options: ResultColumnOptions = {}): string {
  assertTextResults(results);

  if (results.length === 0) {
    return '';
  }

  const columns = resultColumns(results, { ...options, scanAllRows: options.scanAllRows ?? true });

  return [delimitedHeaderLine(columns, delimiter, options),
    ...results.map(row => delimitedRowLine(row, columns, delimiter, options))].join('\n');
}

export function delimitedHeaderLine(columns: readonly string[], delimiter: ',' | '\t', options: ResultColumnOptions = {}): string {
  return columns.map(column => escapeDelimitedCell(column, delimiter, options.preserveText)).join(delimiter);
}

export function delimitedRowLine(row: Record<string, unknown>, columns: readonly string[], delimiter: ',' | '\t', options: ResultColumnOptions = { }): string {
  return columns.map(column => escapeDelimitedCell(row[column], delimiter, options.preserveText)).join(delimiter);
}

function escapeDelimitedCell(value: unknown, delimiter: ',' | '\t', preserveText = false): string {
  const valueText = formatUnknownValue(value);
  const str = preserveText && delimiter === ',' ? valueText : valueText.replace(/\r?\n/g, ' ');

  if (delimiter === '\t') {
    return str.replace(/\t/g, ' ');
  }

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export const DATE_COLUMN_FORMATTERS: ReadonlyMap<string, (value: unknown) => string> = new Map([
  ...['created', 'modified'].map(name => [name, formatTimestampValue] as const),
  ...['due_date', 'scheduled_date', 'start_date', 'created_date', 'done_date', 'cancelled_date']
    .map(name => [name, (value: unknown) => formatIsoDateString(formatUnknownValue(value))] as const),
]);

export function formatDisplayValue(value: unknown, column: string, preserveText = false): string {
  if (value == null || value === '') return '';
  if (preserveText || value instanceof Uint8Array) return formatUnknownValue(value);

  return DATE_COLUMN_FORMATTERS.get(column)?.(value) ?? formatUnknownValue(value);
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
