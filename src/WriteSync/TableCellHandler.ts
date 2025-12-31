import type { TableCellRow } from '../Services/ContentLocationService';
import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { createTableKey, parseTableKey, createRowColumnKey } from '../utils/StringUtils';
import { extractSql } from './types';

export class TableCellHandler implements EntityHandler {
  readonly supportedTables = ['table_cells', 'table_rows'];

  canHandle(table: string): boolean {
    if (this.supportedTables.includes(table)) return true;
    // Dynamic table views end with _table
    if (table.endsWith('_table')) return true;
    return false;
  }

  async convertPreviewResult(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    return this.handleTableCellsOperation(previewResult, context);
  }

  async handleInsertOperation(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    if (previewResult.table === 'table_rows') {
      return this.handleTableRowsInsert(previewResult, context);
    }
    return this.handleTableCellsOperation(previewResult, context);
  }

  private async handleTableRowsInsert(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const allCells: TableCellRow[] = [];
    const affectedTables = new Set<string>();
    const newCellsByTable = new Map<string, TableCellRow[]>();
    const tableLineNumbers = new Map<string, number | null>();

    // Pre-fetch max row indices for all affected tables
    const maxRowByTable = new Map<string, number>();
    for (const r of previewResult.after) {
      const path = r.path as string;
      const table_index = (r.table_index as number) ?? 0;
      const tableKey = createTableKey(path, table_index);
      if (!maxRowByTable.has(tableKey)) {
        const existingMaxRows = await context.queryDatabase<{ max_row: number }>(
          'SELECT COALESCE(MAX(row_index), -1) as max_row FROM table_cells WHERE path = ? AND table_index = ?',
          [path, table_index]
        );
        maxRowByTable.set(tableKey, ((existingMaxRows[0]?.max_row as number) ?? -1) + 1);
      }
    }

    // Track how many rows we've added per table for incrementing row_index
    const rowCountByTable = new Map<string, number>();

    for (let i = 0; i < previewResult.after.length; i++) {
      const r = previewResult.after[i];
      const path = r.path as string;
      const table_index = (r.table_index as number) ?? 0;
      const tableKey = createTableKey(path, table_index);
      affectedTables.add(tableKey);

      // Capture table_line_number from the first row that has it
      const tableLineNumber = r.table_line_number as number | null | undefined;
      if (!tableLineNumbers.has(tableKey) || (tableLineNumber != null && tableLineNumbers.get(tableKey) == null)) {
        tableLineNumbers.set(tableKey, tableLineNumber ?? null);
      }

      const baseRowIndex = maxRowByTable.get(tableKey) ?? 0;
      const rowOffset = rowCountByTable.get(tableKey) ?? 0;
      const row_index = (r.row_index as number) ?? (baseRowIndex + rowOffset);
      rowCountByTable.set(tableKey, rowOffset + 1);

      const raw = r.row_json;
      let obj: Record<string, unknown> = {};
      try {
        if (typeof raw === 'string') obj = JSON.parse(raw);
        else if (typeof raw === 'object' && raw !== null) obj = raw as Record<string, unknown>;
      }

      catch (e) {
        console.warn('[VaultQuery] TableCellHandler: Failed to parse row_json', e);
      }

      const tableCells = newCellsByTable.get(tableKey) || [];
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
        // Add line_number to first cell of new table for positioning
        if (isFirstCellForTable && tableLineNumbers.get(tableKey) != null) {
          cell.line_number = tableLineNumbers.get(tableKey);
          isFirstCellForTable = false;
        }
        tableCells.push(cell);
      }
      newCellsByTable.set(tableKey, tableCells);
    }

    // For each affected table, fetch existing cells and add new cells
    for (const tableKey of affectedTables) {
      const { path, tableIndex } = parseTableKey(tableKey);

      const existingCells = await context.queryDatabase<Record<string, unknown>>(
        'SELECT * FROM table_cells WHERE path = ? AND table_index = ? ORDER BY row_index, column_name',
        [path, tableIndex]
      );

      const newCells = newCellsByTable.get(tableKey) || [];

      // Find the minimum row_index being inserted
      const explicitRowIndices = newCells
        .map(c => c.row_index)
        .filter(idx => idx !== undefined && idx !== null);
      const insertAtIndex = explicitRowIndices.length > 0
        ? Math.min(...explicitRowIndices)
        : null;

      // Add existing cells, shifting row_index if inserting at a specific position
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

  private async handleTableCellsOperation(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
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
    const path = typeof row.path === 'string' ? row.path : '';
    if (!path) {
      console.warn('[VaultQuery] TableCellHandler.convertToTableCellRow: missing required field "path"', row);
    }

    return {
      path,
      table_index: typeof row.table_index === 'number' ? row.table_index : 0,
      row_index: typeof row.row_index === 'number' ? row.row_index : 0,
      column_name: typeof row.column_name === 'string' ? row.column_name : '',
      cell_value: typeof row.cell_value === 'string' ? row.cell_value : '',
      start_offset: typeof row.start_offset === 'number' ? row.start_offset : null,
      end_offset: typeof row.end_offset === 'number' ? row.end_offset : null,
      line_number: typeof row.line_number === 'number' ? row.line_number : null
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
