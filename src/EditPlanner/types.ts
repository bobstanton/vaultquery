import type { TaskRow, HeadingRow, ListItemRow, TableCellRow, Range } from '../Services/ContentLocationService';

export type { TaskRow, HeadingRow, ListItemRow, TableCellRow, Range };

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

export type CreateFileEdit = { type: "createFile"; path: string; text: string; reason?: string };
export type DeleteFileEdit = { type: "deleteFile"; path: string; reason?: string };

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
