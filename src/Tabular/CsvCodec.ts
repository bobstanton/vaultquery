import { sqliteIdentifierKey } from '../utils/SqlIdentifierUtils';
import { parse, unparse } from 'papaparse';
import { columnNames, DataFileError, textColumns } from './TabularTypes';
import type { TabularDocument, CsvFormat, TabularParseLimits, TabularRows, TabularValue } from './TabularTypes';
import { checkDataFileSize, dataFileParseLimits, dataFileUtf8ByteLength } from './TabularLimits';

export function validateCsvHeaders(headers: readonly string[], path: string): void {
  if (headers.length === 0) throw new DataFileError(path, 'format', 'A header record is required.');
  const seen = new Set<string>();

  for (const header of headers) {
    const key = sqliteIdentifierKey(header);
    let hasControl = false;

    for (let index = 0; index < header.length; index++) {
      const code = header.charCodeAt(index);
      if (code < 32 || (code >= 127 && code <= 159)) { hasControl = true; break; }
    }

    if (header.trim() === '' || hasControl) {
      throw new DataFileError(path, 'format', 'Headers must be nonempty and contain no control characters.');
    }

    if (key.startsWith('_vq_') || ['rowid', '_rowid_', 'oid'].includes(key)) {
      throw new DataFileError(path, 'format', `Reserved header ${JSON.stringify(header)}.`);
    }

    if (seen.has(key)) throw new DataFileError(path, 'format', `Duplicate header ${JSON.stringify(header)} under SQLite identifier comparison.`);
    seen.add(key);
  }
}

function inspectRecords(input: string, path: string, limits: TabularParseLimits): { format: Omit<CsvFormat, 'bom'>; records: number; columns: number; } {
  let quoted = false;
  let closedQuote = false;
  let fieldStart = true;
  let columns = 0;
  let fields = 1;
  let records = 0;
  let lastRecordEnd = 0;
  let newline: CsvFormat['newline'] | undefined;

  const finishRecord = (): void => {
    if (records === 0) columns = fields;

    if (fields !== columns) {
      throw new DataFileError(path, 'format', `Record ${records + 1} has ${fields} fields; the header has ${columns}.`);
    }

    records++;
    fields = 1;
    fieldStart = true;
    closedQuote = false;
  };

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '\0') throw new DataFileError(path, 'format', 'NUL characters are not supported in CSV fields.');

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') index++;
        else { quoted = false; closedQuote = true; }
      }

      continue;
    }

    if (char === ',') {
      if (++fields > limits.maxColumns) {
        throw new DataFileError(path, 'limit', `The CSV exceeds ${limits.maxColumns} columns.`);
      }

      fieldStart = true;
      closedQuote = false;
      continue;
    }

    if (char === '\n' || char === '\r') {
      let separator: CsvFormat['newline'] = '\n';

      if (char === '\r') {
        if (input[index + 1] !== '\n') throw new DataFileError(path, 'format', 'Record separators must be LF or CRLF.');
        index++;
        separator = '\r\n';
      }

      if (newline && newline !== separator) throw new DataFileError(path, 'format', 'Mixed LF and CRLF record separators are not supported.');
      newline = separator;
      finishRecord();
      lastRecordEnd = index + 1;
      continue;
    }

    if (closedQuote) throw new DataFileError(path, 'format', `Unexpected text after a closing quote in record ${records + 1}.`);

    if (char === '"') {
      if (!fieldStart) throw new DataFileError(path, 'format', `An unescaped quote occurs in record ${records + 1}.`);
      quoted = true;
    }

    fieldStart = false;
  }

  if (quoted) throw new DataFileError(path, 'format', 'A quoted field is not closed.');
  if (lastRecordEnd < input.length) finishRecord();
  if (records === 0) throw new DataFileError(path, 'format', 'A header record is required; the file is empty.');

  return { format: { kind: 'csv' as const, newline: newline ?? '\n', terminalNewline: lastRecordEnd === input.length }, records, columns };
}

export function parseCsv(source: string, path: string, limits: TabularParseLimits = dataFileParseLimits()): TabularDocument {
  const sourceBytes = dataFileUtf8ByteLength(source, path);
  checkDataFileSize(path, sourceBytes, limits);
  const bom = source.startsWith('\ufeff');
  const input = bom ? source.slice(1) : source;
  const inspection = inspectRecords(input, path, limits);
  let headers: string[] | undefined;
  const rows: string[][] = [];
  let record = 0;

  parse<string[]>(source, {
    delimiter: ',', newline: inspection.format.newline, header: false,
    dynamicTyping: false, skipEmptyLines: false, fastMode: false,
    step: result => {
      if (record++ >= inspection.records) return;
      if (result.errors.length > 0) throw new DataFileError(path, 'format', result.errors[0].message);
      if (!headers) {
        validateCsvHeaders(result.data, path);
        headers = result.data;
      }
      else rows.push(result.data);
    },
  });

  if (!headers || rows.length !== inspection.records - 1) {
    throw new DataFileError(path, 'format', 'Parsed record count does not match CSV framing.');
  }

  return { path, columns: textColumns(headers), rows, format: { ...inspection.format, bom }, source, sourceBytes };
}

export function serializeCsv(document: TabularDocument, rows: TabularRows, limits: TabularParseLimits = dataFileParseLimits()): string {
  const { path, format } = document;
  if (format.kind !== 'csv') throw new DataFileError(path, 'format', 'This document was not read from a CSV file.');
  const headers = columnNames(document.columns);
  validateCsvHeaders(headers, path);

  if (headers.length > limits.maxColumns) {
    throw new DataFileError(path, 'limit', 'The prepared CSV exceeds the SQLite column limit.');
  }

  const needsQuotes = (value: string): boolean => /[",\r\n\ufeff]/.test(value) || value.startsWith(' ') || value.endsWith(' ') || (headers.length === 1 && value === '');

  let bytes = format.bom ? 3 : 0;

  const measure = (record: readonly TabularValue[]): void => {
    if (record.length !== headers.length) throw new DataFileError(path, 'format', 'A prepared record does not match the header width.');
    bytes += Math.max(0, record.length - 1);

    for (const value of record) {
      if (typeof value !== 'string') throw new DataFileError(path, 'format', 'CSV fields must be TEXT; NULL and BLOB values are not supported.');
      if (value.includes('\0')) throw new DataFileError(path, 'format', 'NUL characters are not supported in CSV fields.');
      bytes += dataFileUtf8ByteLength(value, path) + (needsQuotes(value) ? 2 : 0);

      for (let index = value.indexOf('"'); index >= 0; index = value.indexOf('"', index + 1)) {
        bytes++;
      }
    }

    checkDataFileSize(path, bytes, limits);
  };

  measure(headers);

  for (const row of rows) {
    bytes += format.newline.length;
    measure(row);
  }

  if (format.terminalNewline) bytes += format.newline.length;
  checkDataFileSize(path, bytes, limits);

  return (format.bom ? '\ufeff' : '') + unparse<readonly string[]>([headers, ...rows as readonly (readonly string[])[]], {
    delimiter: ',', newline: format.newline, quotes: value => headers.length === 1 && value === '', skipEmptyLines: false, escapeFormulae: false,
  }) + (format.terminalNewline ? format.newline : '');
}
