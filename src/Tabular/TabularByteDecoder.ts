import { parseCsv, serializeCsv } from './CsvCodec';
import { parseJson, serializeJson } from './JsonCodec';
import { checkDataFileSize, dataFileParseLimits } from './TabularLimits';
import { DataFileError, dataFileFormat } from './TabularTypes';
import type { DataFileFormat, RowOrigins, TabularDocument, TabularParseLimits, TabularRows } from './TabularTypes';

const PARSERS: Record<DataFileFormat, (source: string, path: string, limits: TabularParseLimits) => TabularDocument> = {
  csv: parseCsv,
  json: parseJson,
};

const SERIALIZERS: Record<DataFileFormat, (document: TabularDocument, rows: TabularRows, limits: TabularParseLimits, origins: RowOrigins) => string> = {
  csv: serializeCsv,
  json: serializeJson,
};

/** The BOM is kept in the decoded source so each parser can record it and a write can restore it. */
export function decodeDataFileBytes(bytes: ArrayBuffer | Uint8Array, path: string, format = dataFileFormat(path), limits: TabularParseLimits = dataFileParseLimits()): TabularDocument {
  if (!format) throw new DataFileError(path, 'format', 'Only CSV and JSON files are indexed as tables.');
  checkDataFileSize(path, bytes.byteLength, limits);
  let source: string;

  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  catch {
    throw new DataFileError(path, 'encoding', 'The file is not valid UTF-8.');
  }

  return PARSERS[format](source, path, limits);
}

export function serializeDataFile(document: TabularDocument, rows: TabularRows, limits: TabularParseLimits = dataFileParseLimits(), origins: RowOrigins = []): string {
  const unchanged = rows.length === document.rows.length
    && rows.every((row, index) => row.length === document.columns.length && row.every((value, column) => value === document.rows[index][column]));

  if (unchanged) {
    checkDataFileSize(document.path, document.sourceBytes, limits);

    return document.source;
  }

  return SERIALIZERS[document.format.kind](document, rows, limits, origins);
}
