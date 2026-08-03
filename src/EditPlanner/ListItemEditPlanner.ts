import { ContentLocationService } from '../Services/ContentLocationService';
import type { ListItemRow, EntityPlanResult, EntityPlannerContext } from './types';
import { INSERT_NEW_LINE, getBlockIdSuffix, planLineEntityEdits, pushInsertionEdit } from './types';

type QueryListItemsByListIndex = (path: string, listIndex: number) => Promise<Array<{ line_number: number | null; item_index: number }>>;

export class ListItemEditPlanner {
  public constructor(private readonly contentLocationService: ContentLocationService) {}

  public async planListItemEdits(ctx: EntityPlannerContext, listItems: ListItemRow[], listItemsToDelete: ListItemRow[], queryListItemsByListIndex?: QueryListItemsByListIndex): Promise<EntityPlanResult> {
    const newListItems = listItems.filter(item => item.line_number === INSERT_NEW_LINE);
    const existingListItems = listItems.filter(item => item.line_number !== INSERT_NEW_LINE);

    const { edits, warnings } = planLineEntityEdits(ctx, existingListItems, listItemsToDelete, {
      entityName: 'list items',
      insertAtLineReason: 'insert list items at specified line',
      insertNewReason: 'insert new list items',
      updateReason: 'update list item',
      deleteReason: 'delete list item',
      locate: row => this.contentLocationService.locateListItem(ctx.content, row),
      missingMessage: (row, action, reason) => `${ctx.path}: list item "${row.content?.substring(0, 30)}..."${action} - ${reason}`,
      emit: (row, existing) => this.emitListItemLine(row, existing),
      findNewInsertionPoint: () => ContentLocationService.findEndInsertionPoint(ctx.content),
    });

    if (newListItems.length > 0) {
      const byListIndex = new Map<number, ListItemRow[]>();
      for (const item of newListItems) {
        const listIndex = item.list_index ?? 0;
        if (!byListIndex.has(listIndex)) {
          byListIndex.set(listIndex, []);
        }
        byListIndex.get(listIndex)!.push(item);
      }

      for (const [listIndex, items] of byListIndex) {
        const insertionPoint = await this.contentLocationService.findListItemInsertionPoint(
          ctx.content, ctx.path, listIndex, queryListItemsByListIndex
        );
        const newItemText = items.map(item => this.emitListItemLine(item)).join('\n');
        pushInsertionEdit(edits, ctx, insertionPoint, newItemText, `insert new list items into list ${listIndex}`);
      }
    }

    return { edits, warnings };
  }

  private parseListItemStyle(existing: string): { indent: string; marker: string } {
    const bulletMatch = existing.match(/^(\s*)([-*+])\s/);
    const numberMatch = existing.match(/^(\s*)(\d+[.)])\s/);
    if (bulletMatch) {
      return { indent: bulletMatch[1], marker: bulletMatch[2] };
    }

    else if (numberMatch) {
      return { indent: numberMatch[1], marker: numberMatch[2] };
    }
    return { indent: "", marker: "-" };
  }

  public emitListItemLine(base: ListItemRow, existing?: string): string {
    const style = existing ? this.parseListItemStyle(existing) : { indent: "  ".repeat(base.indent_level), marker: base.list_type === 'number' ? "1." : "-" };
    const blockIdSuffix = getBlockIdSuffix(base.block_id, existing);

    return `${style.indent}${style.marker} ${base.content}${blockIdSuffix}`;
  }
}
