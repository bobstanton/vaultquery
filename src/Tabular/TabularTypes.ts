export interface CsvFormat {
  readonly kind: 'csv';
  readonly bom: boolean;
  readonly newline: '\n' | '\r\n';
  readonly terminalNewline: boolean;
}

export interface JsonFormat {
  readonly kind: 'json';
  readonly bom: boolean;
  readonly indent: string;
  readonly newline: '\n' | '\r\n';
  readonly terminalNewline: boolean;
  readonly root: string | null;
  readonly scalarRows: boolean;
  readonly unsafeIntegers: boolean;
}

export type TabularFormat = CsvFormat | JsonFormat;
export type DataFileFormat = TabularFormat['kind'];

export type TabularColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'JSON';

export interface TabularColumn {
  readonly name: string;
  readonly type: TabularColumnType;
}

export type TabularValue = string | number | null;
export type TabularRows = readonly (readonly TabularValue[])[];

export type RowOrigins = readonly (number | null)[];

export interface TabularDocument {
  readonly path: string;
  readonly columns: readonly TabularColumn[];
  readonly rows: TabularRows;
  readonly format: TabularFormat;
  readonly source: string;
  readonly sourceBytes: number;
}

export interface TabularParseLimits {
  readonly maxFileBytes: number;
  readonly maxColumns: number;
}

export type DataFileErrorCode = 'format' | 'encoding' | 'limit' | 'source-changed' | 'ownership' | 'io';

const FORMAT_EXTENSIONS: Record<string, DataFileFormat> = { csv: 'csv', json: 'json' };

export function dataFileFormat(path: string): DataFileFormat | undefined {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();

  return extension ? FORMAT_EXTENSIONS[extension] : undefined;
}

export const dataFileLabel = (path: string): string => dataFileFormat(path)?.toUpperCase() ?? 'Data file';

export class DataFileError extends Error {
  public constructor(public readonly path: string, public readonly code: DataFileErrorCode, message: string) {
    super(`${dataFileLabel(path)} ${path}: ${message}`);
    this.name = 'DataFileError';
  }
}

export const columnNames = (columns: readonly TabularColumn[]): string[] => columns.map(column => column.name);

export const textColumns = (names: readonly string[]): TabularColumn[] => names.map(name => ({ name, type: 'TEXT' }));
