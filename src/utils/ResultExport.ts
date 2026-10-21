import { assertTextResults, delimitedHeaderLine, delimitedRowLine, formatResultsAsDelimited, formatResultsAsMarkdown, markdownHeaderLines, markdownRowLine, resultColumns, scalarFromResults } from './ResultFormatUtils';

export type ExportFormat = 'json' | 'csv' | 'tsv' | 'md' | 'scalar';

export interface ExportFormatDescriptor {
  label: string;
  extension: string;
  mime: string;
}

export const EXPORT_FORMATS: Record<'md' | 'csv' | 'json', ExportFormatDescriptor> = {
  md: { label: 'Markdown', extension: 'md', mime: 'text/markdown' },
  csv: { label: 'CSV', extension: 'csv', mime: 'text/csv' },
  json: { label: 'JSON', extension: 'json', mime: 'application/json' },
};

export interface ResultFormatOptions {
  columns?: readonly string[];
  dataFileColumns?: readonly string[];
}

function project(results: Record<string, unknown>[], columns: readonly string[]): Record<string, unknown>[] {
  return results.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
}

export function formatResults(results: Record<string, unknown>[], format: ExportFormat, options: ResultFormatOptions = {}): string {
  assertTextResults(results);
  const dataFileColumns = options.dataFileColumns;
  const columns = options.columns ?? dataFileColumns;

  if (format === 'json') {
    return JSON.stringify(options.columns ? project(results, options.columns) : results, null, 2);
  }

  if (format === 'csv') {
    return formatResultsAsDelimited(results, ',', { columns, preserveText: Boolean(dataFileColumns) });
  }

  if (format === 'tsv') {
    return formatResultsAsDelimited(results, '\t', { columns });
  }

  if (format === 'md') {
    return formatResultsAsMarkdown(results, { formatValues: !dataFileColumns, scanAllRows: true,
      columns: columns ? [...columns] : undefined, escapeColumnNames: Boolean(dataFileColumns) });
  }

  return scalarFromResults(results);
}

export const EXPORT_CHUNK_ROWS = 1_000;

export function* exportChunks(results: Record<string, unknown>[], format: 'md' | 'csv' | 'json', options: ResultFormatOptions = { }, rowsPerChunk = EXPORT_CHUNK_ROWS): Generator<string> {
  assertTextResults(results);

  if (results.length === 0) {
    yield format === 'json' ? '[]' : '';

    return;
  }

  const dataFileColumns = options.dataFileColumns;
  const explicit = options.columns ?? dataFileColumns;

  if (format === 'json') {
    yield* jsonChunks(explicit ? project(results, explicit) : results, rowsPerChunk);

    return;
  }

  const columns = explicit ? [...explicit] : resultColumns(results, { scanAllRows: true });
  const preserveText = Boolean(dataFileColumns);

  const line = format === 'csv'
    ? (row: Record<string, unknown>) => delimitedRowLine(row, columns, ',', { preserveText })
    : (row: Record<string, unknown>) => markdownRowLine(row, columns, { formatValues: !dataFileColumns, preserveText });

  const header = format === 'csv'
    ? [delimitedHeaderLine(columns, ',', { preserveText })]
    : markdownHeaderLines(columns, { escapeColumnNames: Boolean(dataFileColumns) });

  let pending = [...header];
  let emitted = false;

  for (const row of results) {
    pending.push(line(row));

    if (pending.length >= rowsPerChunk) {
      yield (emitted ? '\n' : '') + pending.join('\n');
      emitted = true;
      pending = [];
    }
  }

  if (pending.length) yield (emitted ? '\n' : '') + pending.join('\n');
}

function* jsonChunks(results: Record<string, unknown>[], rowsPerChunk: number): Generator<string> {
  let pending: string[] = ['['];
  let emitted = false;

  for (let index = 0; index < results.length; index++) {
    const body = JSON.stringify(results[index], null, 2).split('\n').map(part => `  ${part}`).join('\n');
    pending.push(index === results.length - 1 ? body : `${body},`);

    if (pending.length >= rowsPerChunk) {
      yield (emitted ? '\n' : '') + pending.join('\n');
      emitted = true;
      pending = [];
    }
  }

  pending.push(']');

  yield (emitted ? '\n' : '') + pending.join('\n');
}
