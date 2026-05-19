import type { TableCellRow } from '../Services/ContentLocationService';
import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { createTableKey, parseTableKey, createRowColumnKey } from '../utils/StringUtils';
import { asNum, asStr, extractSql } from './types';
import { appendCellsFromTableRows } from './TableUtils';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('WriteSync');

export class TableCellHandler implements EntityHandler {
  readonly supportedTables = ['table_cells', 'table_rows'];

  canHandle(table: string): boolean {
    if (this.supportedTables.includes(table)) return true;
    if (table.endsWith('_table')) return true;
    return false;
  }

  async convertPreviewResult(previewResult: PreviewResult, context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    return this.handleTableCellsOperation(previewResult, context);
  }

  async handleInsertOperation(previewResult: PreviewResult, context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    if (previewResult.table === 'table_rows') {
      return this.handleTableRowsInsert(previewResult, context);
    }
    return this.handleTableCellsOperation(previewResult, context);
  }

  private async handleTableRowsInsert(previewResult: PreviewResult, context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    const allCells: TableCellRow[] = [];
    const affectedTables = new Set<string>();
    const newCellsByTable = new Map<string, TableCellRow[]>();

    await appendCellsFromTableRows(
      previewResult.after,
      affectedTables,
      newCellsByTable,
      async (path, tableIndex) => {
        const existingMaxRows = await context.queryDatabase<{ max_row: number }>(
          'SELECT COALESCE(MAX(row_index), -1) as max_row FROM table_cells WHERE path = ? AND table_index = ?',
          [path, tableIndex]
        );
        return ((existingMaxRows[0]?.max_row as number) ?? -1) + 1;
      },
      'TableCellHandler'
    );

    for (const tableKey of affectedTables) {
      const { path, tableIndex } = parseTableKey(tableKey);

      const existingCells = await context.queryDatabase<Record<string, unknown>>(
        'SELECT * FROM table_cells WHERE path = ? AND table_index = ? ORDER BY row_index, column_name',
        [path, tableIndex]
      );

      const newCells = newCellsByTable.get(tableKey) || [];

      const explicitRowIndices = newCells
        .map(c => c.row_index)
        .filter(idx => idx !== undefined && idx !== null);
      const insertAtIndex = explicitRowIndices.length > 0
        ? Math.min(...explicitRowIndices)
        : null;

      for (const row of existingCells) {
        const cell = this.convertToTableCellRow(row);
        if (insertAtIndex !== null && cell.row_index >= insertAtIndex) {
          cell.row_index = cell.row_index + 1;
        }
        allCells.push(cell);
      }

      allCells.push(...newCells);
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: allCells
    };
  }

  private async handleTableCellsOperation(previewResult: PreviewResult, context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    const changedCells = previewResult.after.map(row => this.convertToTableCellRow(row));

    const affectedTables = new Set<string>();
    changedCells.forEach(cell => {
      affectedTables.add(createTableKey(cell.path, cell.table_index));
    });

    const allCells: TableCellRow[] = [];
    for (const tableKey of affectedTables) {
      const { path, tableIndex } = parseTableKey(tableKey);

      const existingCells = await context.queryDatabase<Record<string, unknown>>(
        'SELECT * FROM table_cells WHERE path = ? AND table_index = ? ORDER BY row_index, column_name',
        [path, tableIndex]
      );

      const existingCellRows = existingCells.map(row => this.convertToTableCellRow(row));

      if (previewResult.op === 'update') {
        const changedCellMap = new Map<string, TableCellRow>();
        for (const cell of changedCells) {
          if (cell.path === path && cell.table_index === tableIndex) {
            const key = createRowColumnKey(cell.row_index, cell.column_name);
            changedCellMap.set(key, cell);
          }
        }

        for (const existingCell of existingCellRows) {
          const key = createRowColumnKey(existingCell.row_index, existingCell.column_name);
          if (changedCellMap.has(key)) {
            allCells.push(changedCellMap.get(key)!);
          }

          else {
            allCells.push(existingCell);
          }
        }
      }

      else if (previewResult.op === 'insert') {
        allCells.push(...existingCellRows);
        for (const cell of changedCells) {
          if (cell.path === path && cell.table_index === tableIndex) {
            allCells.push(cell);
          }
        }
      }

      else if (previewResult.op === 'delete') {
        const deletedCellKeys = new Set<string>();
        for (const row of previewResult.before) {
          const cell = this.convertToTableCellRow(row);
          if (cell.path === path && cell.table_index === tableIndex) {
            deletedCellKeys.add(createRowColumnKey(cell.row_index, cell.column_name));
          }
        }
        for (const existingCell of existingCellRows) {
          const key = createRowColumnKey(existingCell.row_index, existingCell.column_name);
          if (!deletedCellKeys.has(key)) {
            allCells.push(existingCell);
          }
        }
      }

      else {
        allCells.push(...existingCellRows);
      }
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: allCells
    };
  }

  convertToTableCellRow(row: Record<string, unknown>): TableCellRow {
    const path = asStr(row.path);
    if (!path) {
      logger.warn('TableCellHandler.convertToTableCellRow: missing required field "path"', row);
    }

    return {
      path,
      table_index: asNum(row.table_index, 0),
      row_index: asNum(row.row_index, 0),
      column_name: asStr(row.column_name),
      cell_value: asStr(row.cell_value),
      start_offset: asNum(row.start_offset, null),
      end_offset: asNum(row.end_offset, null),
      line_number: asNum(row.line_number, null)
    };
  }

  /**
   * Transform rows from a dynamic *_table view format back to table_cells format.
   */
  transformDynamicViewToTableCells(previewResult: PreviewResult): PreviewResult {
    const metaColumns = new Set(['path', 'table_index', 'row_index', 'table_name', 'rowid']);

    const transformRows = (rows: Record<string, unknown>[]): Record<string, unknown>[] => {
      const result: Record<string, unknown>[] = [];
      for (const row of rows) {
        const path = row.path as string;
        const tableIndex = row.table_index as number;
        const rowIndex = row.row_index as number;

        for (const [colName, value] of Object.entries(row)) {
          if (!metaColumns.has(colName)) {
            result.push({
              path,
              table_index: tableIndex,
              row_index: rowIndex,
              column_name: colName,
              cell_value: value == null ? '' : String(value)
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
}
