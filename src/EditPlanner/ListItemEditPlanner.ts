import { ContentLocationService } from '../Services/ContentLocationService';
import type { ListItemRow, ReplaceRangeEdit, EntityPlanResult, EntityPlannerContext } from './types';
import { getBlockIdSuffix, validateLineNumberBatch, pushInsertionEdit } from './types';

type QueryListItemsByListIndex = (path: string, listIndex: number) => Promise<Array<{ line_number: number | null; item_index: number }>>;

export class ListItemEditPlanner {
  public constructor(private readonly contentLocationService: ContentLocationService) {}

  public async planListItemEdits(ctx: EntityPlannerContext, listItems: ListItemRow[], listItemsToDelete: ListItemRow[], queryListItemsByListIndex?: QueryListItemsByListIndex): Promise<EntityPlanResult> {
    const edits: ReplaceRangeEdit[] = [];
    const warnings: string[] = [];
    const newListItems: ListItemRow[] = [];
    const listItemsWithLineNumber: ListItemRow[] = [];

    for (const row of listItems) {
      if (row.line_number === -1) {
        newListItems.push(row);
        continue;
      }

      if (row.line_number != null && row.line_number > 0 && row.start_offset == null && row.end_offset == null && !row.block_id) {
        listItemsWithLineNumber.push(row);
        continue;
      }

      const loc = this.locateListItem(ctx, row, warnings);
      if (!loc) {
        continue;
      }
      const existing = ctx.content.slice(loc.range.start, loc.range.end);
      const next = this.emitListItemLine(row, existing);
      if (next !== existing) {
        edits.push({ type: "replaceRange", path: ctx.path, range: loc.range, text: next, reason: "update list item" });
      }
    }

    if (listItemsWithLineNumber.length > 0) {
      const minLineNumber = validateLineNumberBatch(listItemsWithLineNumber, 'list items', warnings);
      const insertionPoint = ContentLocationService.findInsertionPointAtLine(ctx.content, minLineNumber);
      const combinedText = listItemsWithLineNumber.map(item => this.emitListItemLine(item)).join('\n');
      pushInsertionEdit(edits, ctx, insertionPoint, combinedText, 'insert list items at specified line');
    }

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

    for (const row of listItemsToDelete) {
      const loc = this.locateListItem(ctx, row, warnings, ' to delete');
      if (!loc) {
        continue;
      }
      const deleteRange = ContentLocationService.expandRangeToIncludeNewline(ctx.content, loc.range);
      edits.push({
        type: "replaceRange",
        path: ctx.path,
        range: deleteRange,
        text: "",
        reason: "delete list item"
      });
    }

    return { edits, warnings };
  }

  private locateListItem(ctx: EntityPlannerContext, row: ListItemRow, warnings: string[], action = ''): Exclude<ReturnType<ContentLocationService['locateListItem']>, { kind: 'miss' }> | null {
    const loc = this.contentLocationService.locateListItem(ctx.content, row);
    if (loc.kind === "miss") {
      warnings.push(`${ctx.path}: list item "${row.content?.substring(0, 30)}..."${action} - ${loc.reason}`);
      return null;
    }
    return loc;
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
