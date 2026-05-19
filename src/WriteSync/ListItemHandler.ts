import type { ListItemRow } from '../Services/ContentLocationService';
import type { EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { asNum, asStr, createEntityResult, readLocationFields } from './types';
import { BaseEntityHandler } from './BaseEntityHandler';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('WriteSync');

export class ListItemHandler extends BaseEntityHandler {
  public constructor() {
    super(['list_items', 'list_items_view']);
  }

  convertPreviewResult(previewResult: PreviewResult, _context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'delete') {
      return Promise.resolve(createEntityResult(previewResult, {
        listItemsAfter: [],
        listItemsToDelete: previewResult.before.map(row => this.convertToListItemRow(row))
      }));
    }

    if (previewResult.op === 'update') {
      const listItems = previewResult.after.map(row => {
        const item = this.convertToListItemRow(row);
        const beforeRow = previewResult.before.find(b => b.id === row.id);
        if (beforeRow) {
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

      return Promise.resolve(createEntityResult(previewResult, {
        listItemsAfter: listItems
      }));
    }

    return Promise.resolve(createEntityResult(previewResult, {
      listItemsAfter: previewResult.after.map(row => this.convertToListItemRow(row))
    }));
  }

  handleInsertOperation(previewResult: PreviewResult, _context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    const newListItems = previewResult.after.map((row, index) => {
      const item = this.convertToListItemRow(row);
      if (item.list_index == null) {
        item.list_index = 0;
      }
      if (item.item_index == null) {
        item.item_index = index;
      }
      if (item.line_number == null) {
        item.line_number = -1;
      }
      return item;
    });

    return Promise.resolve(createEntityResult(previewResult, {
      listItemsAfter: newListItems
    }));
  }

  convertToListItemRow(row: Record<string, unknown>): ListItemRow {
    const path = asStr(row.path);
    if (!path) {
      logger.warn('ListItemHandler.convertToListItemRow: missing required field "path"', row);
    }

    return {
      id: asNum(row.id, -1),
      path,
      list_index: asNum(row.list_index, 0),
      item_index: asNum(row.item_index, 0),
      parent_index: asNum(row.parent_index, null),
      content: asStr(row.content),
      list_type: (row.list_type as 'bullet' | 'number') || 'bullet',
      indent_level: asNum(row.indent_level, 0),
      ...readLocationFields(row)
    };
  }
}
