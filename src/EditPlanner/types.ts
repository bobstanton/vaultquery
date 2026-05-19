import type { TaskRow, HeadingRow, ListItemRow, TableCellRow, Range, InsertionPoint } from '../Services/ContentLocationService';

export type { TaskRow, HeadingRow, ListItemRow, TableCellRow };

export type FrontmatterValue = string | number | boolean | null | undefined | Date | FrontmatterValue[] | { [key: string]: FrontmatterValue };
export type FrontmatterData = { [key: string]: FrontmatterValue };

export type ReplaceRangeEdit = {
  type: "replaceRange";
  path: string;
  range: Range;
  text: string;
  reason?: string;
};

export type FrontmatterEdit = {
  type: "frontmatter";
  path: string;
  mutate: (fm: FrontmatterData) => void;
  reason?: string;
};

type CreateFileEdit = { type: "createFile"; path: string; text: string; reason?: string };
type DeleteFileEdit = { type: "deleteFile"; path: string; reason?: string };

export type Edit = ReplaceRangeEdit | FrontmatterEdit | CreateFileEdit | DeleteFileEdit;

export interface PropertyRow {
  path: string;
  key: string;
  value: string | null;
  type: string | null;
}

export interface TableRowGroup {
  path: string;
  table_index: number;
  block_id?: string | null;
  table_start?: number | null;
  table_end?: number | null;
  line_number?: number | null;
  header: string[];
  rows: Array<Record<string, string>>;
}

export interface EntityPlannerContext {
  content: string;
  path: string;
  warnings: string[];
}

export interface EntityPlanResult {
  edits: ReplaceRangeEdit[];
  warnings: string[];
}

export function validateLineNumberBatch<T extends { line_number?: number | null }>(
  items: T[],
  entityName: string,
  warnings: string[]
): number {
  items.sort((a, b) => (a.line_number ?? 0) - (b.line_number ?? 0));
  const lineNumbers = items.map(x => x.line_number!);
  const minLineNumber = lineNumbers[0];
  const maxLineNumber = lineNumbers[lineNumbers.length - 1];
  const isConsecutive = (maxLineNumber - minLineNumber) <= (items.length - 1);
  if (!isConsecutive) {
    warnings.push(`Non-consecutive line numbers detected (${minLineNumber} to ${maxLineNumber} for ${items.length} ${entityName}). Use consecutive line numbers like +1, +2, +3 for batch inserts.`);
  }
  return minLineNumber;
}

export function pushInsertionEdit(edits: ReplaceRangeEdit[], ctx: EntityPlannerContext, insertionPoint: InsertionPoint, text: string, reason: string): void {
  const prefix = insertionPoint.needsNewlineBefore ? '\n' : '';
  const suffix = insertionPoint.needsNewlineAfter ? '\n' : '';
  edits.push({
    type: "replaceRange",
    path: ctx.path,
    range: { start: insertionPoint.offset, end: insertionPoint.offset },
    text: prefix + text + suffix,
    reason
  });
}

/**
 * Get block ID suffix for content that may have existing block references
 */
export function getBlockIdSuffix(blockId?: string | null, existing?: string): string {
  if (blockId) {
    return ` ^${blockId}`;
  }
  const blockIdMatch = existing?.match(/\s+\^([\w-]+)\s*$/);
  if (blockIdMatch) {
    return ` ^${blockIdMatch[1]}`;
  }
  return '';
}
