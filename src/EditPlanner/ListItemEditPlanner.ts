import { ContentLocationService } from '../Services/ContentLocationService';
import type { ListItemRow, ReplaceRangeEdit, EntityPlanResult, EntityPlannerContext } from './types';
import { getBlockIdSuffix } from './types';

export class ListItemEditPlanner {
  public constructor(private readonly contentLocationService: ContentLocationService) {}

  public async planListItemEdits(
    ctx: EntityPlannerContext,
    listItems: ListItemRow[],
    listItemsToDelete: ListItemRow[],
    queryListItemsByListIndex?: (path: string, listIndex: number) => Promise<Array<{ line_number: number | null; item_index: number }>>
  ): Promise<EntityPlanResult> {
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

      const loc = this.contentLocationService.locateListItem(ctx.content, row);
      if (loc.kind === "miss") {
        warnings.push(`${ctx.path}: list item "${row.content?.substring(0, 30)}..." - ${loc.reason}`);
        continue;
      }
      const existing = ctx.content.slice(loc.range.start, loc.range.end);
      const next = this.emitListItemLine(row, existing);
      if (next !== existing) {
        edits.push({ type: "replaceRange", path: ctx.path, range: loc.range, text: next, reason: "update list item" });
      }
    }

    if (listItemsWithLineNumber.length > 0) {
      listItemsWithLineNumber.sort((a, b) => (a.line_number ?? 0) - (b.line_number ?? 0));

      const lineNumbers = listItemsWithLineNumber.map(l => l.line_number!);
      const minLineNumber = lineNumbers[0];
      const maxLineNumber = lineNumbers[lineNumbers.length - 1];
      const isConsecutive = (maxLineNumber - minLineNumber) <= (listItemsWithLineNumber.length - 1);

      if (!isConsecutive) {
        warnings.push(`Non-consecutive line numbers detected (${minLineNumber} to ${maxLineNumber} for ${listItemsWithLineNumber.length} list items). Use consecutive line numbers like +1, +2, +3 for batch inserts.`);
      }

      const insertionPoint = ContentLocationService.findInsertionPointAtLine(ctx.content, minLineNumber);
      const itemLines = listItemsWithLineNumber.map(item => this.emitListItemLine(item));
      const combinedText = itemLines.join('\n');

      const prefix = insertionPoint.needsNewlineBefore ? '\n' : '';
      const suffix = insertionPoint.needsNewlineAfter ? '\n' : '';

      edits.push({
        type: "replaceRange",
        path: ctx.path,
        range: { start: insertionPoint.offset, end: insertionPoint.offset },
        text: prefix + combinedText + suffix,
        reason: "insert list items at specified line"
      });
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

        const prefix = insertionPoint.needsNewlineBefore ? '\n' : '';
        const suffix = insertionPoint.needsNewlineAfter ? '\n' : '';

        edits.push({
          type: "replaceRange",
          path: ctx.path,
          range: { start: insertionPoint.offset, end: insertionPoint.offset },
          text: prefix + newItemText + suffix,
          reason: `insert new list items into list ${listIndex}`
        });
      }
    }

    for (const row of listItemsToDelete) {
      const loc = this.contentLocationService.locateListItem(ctx.content, row);
      if (loc.kind === "miss") {
        warnings.push(`${ctx.path}: list item "${row.content?.substring(0, 30)}..." to delete - ${loc.reason}`);
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
