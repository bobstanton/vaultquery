import type { PreviewResult } from './types';
import { formatUnknownValue } from '../utils/ResultFormatUtils';

const META_COLUMNS = new Set(['path', 'table_index', 'row_index', 'table_name', 'rowid']);

export function transformDynamicViewToTableCells(previewResult: PreviewResult): PreviewResult {
  const transformRows = (rows: Record<string, unknown>[]): Record<string, unknown>[] => {
    const result: Record<string, unknown>[] = [];
    for (const row of rows) {
      const path = row.path as string;
      const tableIndex = row.table_index as number;
      const rowIndex = row.row_index as number;

      for (const [colName, value] of Object.entries(row)) {
        if (!META_COLUMNS.has(colName)) {
          result.push({
            path,
            table_index: tableIndex,
            row_index: rowIndex,
            column_name: colName,
            cell_value: formatUnknownValue(value)
          });
        }
      }
    }
    return result;
  };

  return {
    ...previewResult,
    table: 'table_cells',
    before: transformRows(previewResult.before),
    after: transformRows(previewResult.after)
  };
}

export function transformDynamicViewToTableRows(previewResult: PreviewResult): PreviewResult {
  const transformRows = (rows: Record<string, unknown>[]): Record<string, unknown>[] => {
    return rows.map(row => {
      const rowJson: Record<string, unknown> = {};
      for (const [colName, value] of Object.entries(row)) {
        if (!META_COLUMNS.has(colName)) {
          rowJson[colName] = formatUnknownValue(value);
        }
      }

      return {
        path: row.path,
        table_index: row.table_index,
        row_index: row.row_index,
        row_json: JSON.stringify(rowJson)
      };
    });
  };

  return {
    ...previewResult,
    table: 'table_rows',
    before: transformRows(previewResult.before),
    after: transformRows(previewResult.after)
  };
}
