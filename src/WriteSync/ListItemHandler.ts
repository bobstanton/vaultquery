import type { ListItemRow } from '../Services/ContentLocationService';
import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { extractSql } from './types';

export class ListItemHandler implements EntityHandler {
  readonly supportedTables = ['list_items', 'list_items_view'];

  canHandle(table: string): boolean {
    return this.supportedTables.includes(table);
  }

  convertPreviewResult(
    previewResult: PreviewResult,
    _context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'delete') {
      return Promise.resolve({
        sqlToApply: extractSql(previewResult),
        tasksAfter: [],
        headingsAfter: [],
        tableCellsAfter: [],
        listItemsAfter: [],
        listItemsToDelete: previewResult.before.map(row => this.convertToListItemRow(row))
      });
    }

    // For updates, merge positioning data from the before row
    if (previewResult.op === 'update') {
      const listItems = previewResult.after.map(row => {
        const item = this.convertToListItemRow(row);
        const beforeRow = previewResult.before.find(b => b.id === row.id);
        if (beforeRow) {
          // Preserve positioning data from before row
          if (item.start_offset == null && beforeRow.start_offset != null) {
            item.start_offset = beforeRow.start_offset as number;
          }
          if (item.end_offset == null && beforeRow.end_offset != null) {
            item.end_offset = beforeRow.end_offset as number;
          }
          if (item.anchor_hash == null && beforeRow.anchor_hash != null) {
            item.anchor_hash = beforeRow.anchor_hash as string;
          }
          if (item.block_id == null && beforeRow.block_id != null) {
            item.block_id = beforeRow.block_id as string;
          }
        }
        return item;
      });

      return Promise.resolve({
        sqlToApply: extractSql(previewResult),
        tasksAfter: [],
        headingsAfter: [],
        tableCellsAfter: [],
        listItemsAfter: listItems
      });
    }

    // Default case
    return Promise.resolve({
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      listItemsAfter: previewResult.after.map(row => this.convertToListItemRow(row))
    });
  }

  handleInsertOperation(
    previewResult: PreviewResult,
    _context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const newListItems = previewResult.after.map((row, index) => {
      const item = this.convertToListItemRow(row);
      // Provide defaults for required fields
      if (item.list_index === null || item.list_index === undefined) {
        item.list_index = 0; // Default to first list
      }
      if (item.item_index === null || item.item_index === undefined) {
        item.item_index = index; // Default to sequential index
      }
      // Use user-specified line_number if provided, otherwise -1 for default insertion
      if (item.line_number === null || item.line_number === undefined) {
        item.line_number = -1;
      }
      return item;
    });

    return Promise.resolve({
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      listItemsAfter: newListItems
    });
  }

  convertToListItemRow(row: Record<string, unknown>): ListItemRow {
    const id = typeof row.id === 'number' ? row.id : -1;
    const path = typeof row.path === 'string' ? row.path : '';
    const content = typeof row.content === 'string' ? row.content : '';
    const listIndex = typeof row.list_index === 'number' ? row.list_index : 0;
    const itemIndex = typeof row.item_index === 'number' ? row.item_index : 0;

    if (!path) {
      console.warn('[VaultQuery] ListItemHandler.convertToListItemRow: missing required field "path"', row);
    }

    return {
      id,
      path,
      list_index: listIndex,
      item_index: itemIndex,
      parent_index: typeof row.parent_index === 'number' ? row.parent_index : null,
      content,
      list_type: (row.list_type as 'bullet' | 'number') || 'bullet',
      indent_level: typeof row.indent_level === 'number' ? row.indent_level : 0,
      line_number: typeof row.line_number === 'number' ? row.line_number : null,
      block_id: typeof row.block_id === 'string' ? row.block_id : null,
      start_offset: typeof row.start_offset === 'number' ? row.start_offset : null,
      end_offset: typeof row.end_offset === 'number' ? row.end_offset : null,
      anchor_hash: typeof row.anchor_hash === 'string' ? row.anchor_hash : null
    };
  }
}
