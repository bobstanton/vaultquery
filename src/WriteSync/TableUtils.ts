import type { TableCellRow } from '../Services/ContentLocationService';
import { createTableKey } from '../utils/StringUtils';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('WriteSync');

function parseRowJson(row: Record<string, unknown>, context: string): Record<string, unknown> {
  const raw = row.row_json;
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
    if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  }
  catch (e) {
    logger.warn(`${context}: Failed to parse row_json`, e);
  }
  return {};
}

function extractRowTableKey(r: Record<string, unknown>, affectedTables: Set<string>, tableLineNumbers: Map<string, number | null>): { path: string; table_index: number; tableKey: string } {
  const path = r.path as string;
  const table_index = (r.table_index as number) ?? 0;
  const tableKey = createTableKey(path, table_index);
  affectedTables.add(tableKey);
  const tableLineNumber = r.table_line_number as number | null | undefined;
  if (!tableLineNumbers.has(tableKey) || (tableLineNumber != null && tableLineNumbers.get(tableKey) == null)) {
    tableLineNumbers.set(tableKey, tableLineNumber ?? null);
  }
  return { path, table_index, tableKey };
}

function appendCellsFromObject(cellsByTable: Map<string, TableCellRow[]>, tableKey: string, path: string, table_index: number, row_index: number, obj: Record<string, unknown>, tableLineNumbers: Map<string, number | null>): void {
  const tableCells = cellsByTable.get(tableKey) || [];
  let isFirstCellForTable = tableCells.length === 0;
  for (const [column_name, v] of Object.entries(obj)) {
    const cell: TableCellRow = {
      path,
      table_index,
      row_index,
      column_name,
      cell_value: v == null ? '' : String(v),
      start_offset: null,
      end_offset: null,
    };
    if (isFirstCellForTable && tableLineNumbers.get(tableKey) != null) {
      cell.line_number = tableLineNumbers.get(tableKey);
      isFirstCellForTable = false;
    }
    tableCells.push(cell);
  }
  cellsByTable.set(tableKey, tableCells);
}

export async function appendCellsFromTableRows(rows: Record<string, unknown>[], affectedTables: Set<string>, cellsByTable: Map<string, TableCellRow[]>, queryMaxRow: (path: string, tableIndex: number) => Promise<number>, context: string): Promise<void> {
  const tableLineNumbers = new Map<string, number | null>();
  const maxRowByTable = new Map<string, number>();

  for (const row of rows) {
    const path = row.path as string;
    const tableIndex = (row.table_index as number) ?? 0;
    const tableKey = createTableKey(path, tableIndex);
    if (!maxRowByTable.has(tableKey)) {
      maxRowByTable.set(tableKey, await queryMaxRow(path, tableIndex));
    }
  }

  const rowCountByTable = new Map<string, number>();

  for (const row of rows) {
    const { path, table_index, tableKey } = extractRowTableKey(row, affectedTables, tableLineNumbers);
    const baseRowIndex = maxRowByTable.get(tableKey) ?? 0;
    const rowOffset = rowCountByTable.get(tableKey) ?? 0;
    const rowIndex = (row.row_index as number) ?? (baseRowIndex + rowOffset);
    rowCountByTable.set(tableKey, rowOffset + 1);

    appendCellsFromObject(cellsByTable, tableKey, path, table_index, rowIndex, parseRowJson(row, context), tableLineNumbers);
  }
}
