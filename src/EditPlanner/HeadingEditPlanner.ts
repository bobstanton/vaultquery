import { ContentLocationService } from '../Services/ContentLocationService';
import type { HeadingRow, ReplaceRangeEdit, EntityPlanResult, EntityPlannerContext } from './types';
import { getBlockIdSuffix } from './types';

export class HeadingEditPlanner {
  public constructor(private readonly contentLocationService: ContentLocationService) {}

  public planHeadingEdits(ctx: EntityPlannerContext, headings: HeadingRow[], headingsToDelete: HeadingRow[]): EntityPlanResult {
    const edits: ReplaceRangeEdit[] = [];
    const warnings: string[] = [];
    const newHeadings: HeadingRow[] = [];
    const headingsWithLineNumber: HeadingRow[] = [];

    for (const row of headings) {
      if (row.line_number === -1) {
        newHeadings.push(row);
        continue;
      }

      if (row.line_number != null && row.line_number > 0 && row.start_offset == null && row.end_offset == null && !row.block_id) {
        headingsWithLineNumber.push(row);
        continue;
      }

      const loc = this.contentLocationService.locateHeading(ctx.content, row);
      if (loc.kind === "miss") {
        warnings.push(`${ctx.path}: heading "${row.heading_text}" - ${loc.reason}`);
        continue;
      }
      const existing = ctx.content.slice(loc.range.start, loc.range.end);
      const next = this.emitHeadingLine(row, existing);
      if (next !== existing) {
        edits.push({ type: "replaceRange", path: ctx.path, range: loc.range, text: next, reason: "rename heading" });
      }
    }

    if (headingsWithLineNumber.length > 0) {
      headingsWithLineNumber.sort((a, b) => (a.line_number ?? 0) - (b.line_number ?? 0));

      const lineNumbers = headingsWithLineNumber.map(h => h.line_number!);
      const minLineNumber = lineNumbers[0];
      const maxLineNumber = lineNumbers[lineNumbers.length - 1];
      const isConsecutive = (maxLineNumber - minLineNumber) <= (headingsWithLineNumber.length - 1);

      if (!isConsecutive) {
        warnings.push(`Non-consecutive line numbers detected (${minLineNumber} to ${maxLineNumber} for ${headingsWithLineNumber.length} headings). Use consecutive line numbers like +1, +2, +3 for batch inserts.`);
      }

      const insertionPoint = ContentLocationService.findInsertionPointAtLine(ctx.content, minLineNumber);
      const headingLines = headingsWithLineNumber.map(heading => this.emitHeadingLine(heading));
      const combinedText = headingLines.join('\n');

      const prefix = insertionPoint.needsNewlineBefore ? '\n' : '';
      const suffix = insertionPoint.needsNewlineAfter ? '\n' : '';

      edits.push({
        type: "replaceRange",
        path: ctx.path,
        range: { start: insertionPoint.offset, end: insertionPoint.offset },
        text: prefix + combinedText + suffix,
        reason: "insert headings at specified line"
      });
    }

    if (newHeadings.length > 0) {
      const insertionPoint = ContentLocationService.findTableInsertionPoint(ctx.content);
      const newHeadingText = newHeadings.map(heading => this.emitHeadingLine(heading)).join('\n');

      const prefix = insertionPoint.needsNewlineBefore ? '\n' : '';
      const suffix = insertionPoint.needsNewlineAfter ? '\n' : '';

      edits.push({
        type: "replaceRange",
        path: ctx.path,
        range: { start: insertionPoint.offset, end: insertionPoint.offset },
        text: prefix + newHeadingText + suffix,
        reason: "insert new headings"
      });
    }

    for (const row of headingsToDelete) {
      const loc = this.contentLocationService.locateHeading(ctx.content, row);
      if (loc.kind === "miss") {
        warnings.push(`${ctx.path}: heading "${row.heading_text}" to delete - ${loc.reason}`);
        continue;
      }
      const deleteRange = ContentLocationService.expandRangeToIncludeNewline(ctx.content, loc.range);
      edits.push({
        type: "replaceRange",
        path: ctx.path,
        range: deleteRange,
        text: "",
        reason: "delete heading"
      });
    }

    return { edits, warnings };
  }

  private preserveFenceAndId(existing: string): { fence: string; suffix: string } {
    const m = existing.match(/^(#+)\s+.*?(\s+#+\s*)?(\s+\{#.*\})?\s*$/);
    return { fence: (m?.[1] ?? "##"), suffix: ((m?.[2] ?? "") + (m?.[3] ?? "")) };
  }

  public emitHeadingLine(row: HeadingRow, existing?: string): string {
    const { fence, suffix } = existing
      ? this.preserveFenceAndId(existing)
      : { fence: "#".repeat(row.level || 1), suffix: "" };
    const blockIdSuffix = getBlockIdSuffix(row.block_id, existing);

    return `${fence} ${row.heading_text}${suffix}${blockIdSuffix}`.trimEnd();
  }
}
