import { App, TFile, MetadataCache, normalizePath } from 'obsidian';
import { escapeRegex, hashString } from '../utils/StringUtils';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import type { TaskMetadataFields } from '../types';

export type Range = { start: number; end: number };

export interface InsertionPoint {
  offset: number;
  needsNewlineBefore: boolean;
  needsNewlineAfter: boolean;
}

export interface TableLocationInfo {
  path: string;
  block_id?: string | null;
  table_start?: number | null;
  table_end?: number | null;
}

export interface TableCellRow {
  path: string;
  table_index: number;
  row_index: number;
  column_name: string;
  cell_value: string;
  start_offset?: number | null;
  end_offset?: number | null;
  line_number?: number | null;
}

export interface TaskRow extends Partial<TaskMetadataFields> {
  id: number;
  path: string;
  task_text: string;
  completed: 0 | 1;
  status?: string | null;
  line_number?: number | null;
}

export interface HeadingRow {
  path: string;
  level: number;
  line_number?: number | null;
  heading_text: string;
  block_id?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  anchor_hash?: string | null;
}

export interface ListItemRow {
  id: number;
  path: string;
  list_index: number;
  item_index: number;
  parent_index?: number | null;
  content: string;
  list_type: 'bullet' | 'number';
  indent_level: number;
  line_number?: number | null;
  block_id?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  anchor_hash?: string | null;
}

interface StableLocationRow {
  path: string;
  block_id?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  anchor_hash?: string | null;
}

/** Map of checkbox characters to task status */
const TASK_STATUS_MAP: ReadonlyMap<string, { completed: boolean; status: string }> = new Map([
  ['x', { completed: true, status: 'DONE' }],
  ['/', { completed: false, status: 'IN_PROGRESS' }],
  ['-', { completed: false, status: 'CANCELLED' }],
]);

/** Default task status for unrecognized checkbox characters */
const DEFAULT_TASK_STATUS_ENTRY = { completed: false, status: 'TODO' };

export class ContentLocationService {
  public constructor(private app: App, private metadataCache: MetadataCache) {}

  /**
   * Get task completed/status from checkbox character.
   */
  public static getTaskStatus(checkbox: string): { completed: boolean; status: string } {
    return TASK_STATUS_MAP.get(checkbox.toLowerCase()) ?? DEFAULT_TASK_STATUS_ENTRY;
  }

  /**
   * Extract block ID from a line or the following line.
   * Block IDs are in the format ^block-id at the end of a line or on a line by itself.
   */
  public static extractBlockId(lines: string[], lineIndex: number, lineContent?: string): string | undefined {
    const line = lineContent ?? lines[lineIndex] ?? '';

    const inlineMatch = line.match(/\^([\w-]+)\s*$/);
    if (inlineMatch) {
      return inlineMatch[1];
    }

    if (lineIndex < lines.length - 1) {
      const nextLine = lines[lineIndex + 1];
      const nextLineMatch = nextLine?.match(/^\s*\^([\w-]+)\s*$/);
      if (nextLineMatch) {
        return nextLineMatch[1];
      }
    }

    return undefined;
  }

  /**
   * Compute a content-based hash for identifying an item across reindexing.
   * Uses surrounding context (prev/current/next lines) rather than position,
   * so moving an item doesn't change its identity.
   */
  public static computeAnchorHash(lineIndex: number, lines: string[], occurrence: number = 0): string {
    const prevLine = (lineIndex > 0 ? lines[lineIndex - 1] : '') || '';
    const currentLine = lines[lineIndex] || '';
    const nextLine = (lineIndex < lines.length - 1 ? lines[lineIndex + 1] : '') || '';

    const contextWindow = [prevLine, currentLine, nextLine]
      .map(line => line.trim().toLowerCase())
      .join('\n');

    // Include occurrence number to distinguish items with identical context.
    // Occurrence 0 means "first item with this context", 1 means "second", etc.
    const hashInput = occurrence > 0 ? `${contextWindow}::O${occurrence}` : contextWindow;

    return hashString(hashInput);
  }

  /**
   * Compute the context key used to track occurrences (before adding occurrence number).
   */
  public static computeContextKey(lineIndex: number, lines: string[]): string {
    const prevLine = (lineIndex > 0 ? lines[lineIndex - 1] : '') || '';
    const currentLine = lines[lineIndex] || '';
    const nextLine = (lineIndex < lines.length - 1 ? lines[lineIndex + 1] : '') || '';

    return [prevLine, currentLine, nextLine]
      .map(line => line.trim().toLowerCase())
      .join('\n');
  }

  public static getLineOffsets(content: string, lineIndex: number): Range {
    if (lineIndex < 0) return { start: 0, end: 0 };
    
    let currentPos = 0;
    let currentLine = 0;
    
    while (currentLine < lineIndex && currentPos < content.length) {
      const nextNewline = content.indexOf('\n', currentPos);
      if (nextNewline === -1) break;
      currentPos = nextNewline + 1;
      currentLine++;
    }
    
    const start = currentPos;
    
    const nextNewline = content.indexOf('\n', currentPos);
    const end = nextNewline === -1 ? content.length : nextNewline;
    
    return { start, end };
  }

  public rangeFromBlockId(path: string, blockId: string): Range | null {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) return null;
    
    const cache = this.metadataCache.getFileCache(file);
    const block = cache?.blocks?.[blockId];
    if (!block) return null;
    
    return { 
      start: block.position.start.offset, 
      end: block.position.end.offset 
    };
  }

  public locateTask(content: string, row: TaskRow): { kind: "ok"; range: Range } | { kind: "miss"; reason: string } {
    const stableRange = this.locateByStableReferences(content, row, ContentLocationService.looksLikeTask);
    if (stableRange) {
      return { kind: "ok", range: stableRange };
      }

    const fuzzyResult = this.fuzzyTaskInSection(content, row);
    if (fuzzyResult) {
      return { kind: "ok", range: fuzzyResult };
    }

    return { kind: "miss", reason: "Unable to locate task safely" };
  }

  public locateHeading(content: string, row: HeadingRow): { kind: "ok"; range: Range } | { kind: "miss"; reason: string } {
    const stableRange = this.locateByStableReferences(content, row, ContentLocationService.looksLikeHeading);
    if (stableRange) {
      return { kind: "ok", range: stableRange };
    }

    const level = Math.max(1, Math.min(6, row.level || 1));
    const escapedText = escapeRegex(row.heading_text);
    const re = new RegExp(`(^|\\n)(#{${level}})\\s+${escapedText}(\\s+#+\\s*)?(\\s+\\{#.*\\})?\\s*$`, "m");
    const m = content.match(re);
    if (m && m.index != null) {
      const lineStart = content.lastIndexOf("\n", m.index) + 1;
      const lineEnd = content.indexOf("\n", m.index);
      const end = (lineEnd === -1 ? content.length : lineEnd);
      return { kind: "ok", range: { start: lineStart, end } };
    }

    return { kind: "miss", reason: "Unable to locate heading" };
  }

  public locateListItem(content: string, row: ListItemRow): { kind: "ok"; range: Range } | { kind: "miss"; reason: string } {
    const stableRange = this.locateByStableReferences(content, row, ContentLocationService.looksLikeListItem);
    if (stableRange) {
      return { kind: "ok", range: stableRange };
    }

    return { kind: "miss", reason: "Unable to locate list item" };
  }

  private locateByStableReferences(content: string, row: StableLocationRow, isExpectedLine: (slice: string) => boolean): Range | null {
    if (row.block_id) {
      const range = this.rangeFromBlockId(row.path, row.block_id);
      if (this.rangeMatches(content, range, isExpectedLine)) {
        return range;
      }
    }

    if (ContentLocationService.isValidRange(content, row.start_offset, row.end_offset)) {
      const range = { start: row.start_offset!, end: row.end_offset! };
      if (this.rangeMatches(content, range, isExpectedLine)) {
        return range;
      }
    }

    if (row.anchor_hash) {
      const range = this.searchByAnchorHash(content, row.anchor_hash);
      if (this.rangeMatches(content, range, isExpectedLine)) {
        return range;
      }
    }

    return null;
  }

  private rangeMatches(content: string, range: Range | null, isExpectedLine: (slice: string) => boolean): range is Range {
    return Boolean(range && isExpectedLine(content.slice(range.start, range.end)));
  }

  public static isValidRange(content: string, start?: number | null, end?: number | null): boolean {
    if (start == null || end == null) return false;
    if (start < 0 || end < 0) return false;
    if (start >= end) return false;
    if (end > content.length) return false;
    return true;
  }

  public static looksLikeTask(slice: string): boolean {
    // Match tasks with any checkbox state: [ ], [x], [X], [/], [-], [?], [>], [<], [!], etc.
    return /^\s*[-*+]\s+\[[^\]]\]\s+/.test(slice);
  }

  public static looksLikeHeading(slice: string): boolean {
    return /^#{1,6}\s+/.test(slice);
  }

  public static looksLikeListItem(slice: string): boolean {
    // Match bullet lists (-, *, +) or numbered lists (1., 2), etc.)
    // Exclude task items (those have [x] or any other checkbox state)
    return /^\s*(?:[-*+]|\d+[.)])\s+(?!\[[^\]]\])/.test(slice);
  }

  public searchByAnchorHash(content: string, targetHash: string): Range | null {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (ContentLocationService.computeAnchorHash(i, lines) === targetHash) {
        return ContentLocationService.getLineOffsets(content, i);
      }
    }
    return null;
  }

  private fuzzyTaskInSection(content: string, row: TaskRow): Range | null {
    const normalized = ContentLocationService.normalizeText(row.task_text ?? "");
    const re = /^(\s*)([-*+])\s+\[[ xX]\]\s+(.*)$/gm;
    let best: { start: number; end: number; score: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const raw = m[3] ?? "";
      const score = ContentLocationService.lcsScore(ContentLocationService.normalizeText(raw), normalized);
      if (score > (best?.score ?? 0)) {
        const lastNewline = content.lastIndexOf("\n", m.index);
        const start = lastNewline === -1 ? 0 : lastNewline + 1;
        const lineEnd = content.indexOf("\n", m.index + 1);
        const end = lineEnd === -1 ? content.length : lineEnd;
        best = { start, end, score };
      }
    }
    if (best && best.score >= 0.6) {
      return { start: best.start, end: best.end };
    }
    return null;
  }

  private static normalizeText(s: string): string {
    return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, "");
  }

  private static lcsScore(a: string, b: string): number {
    const A = new Set(a.split(" ").filter(Boolean));
    const B = new Set(b.split(" ").filter(Boolean));
    const inter = new Set([...A].filter(x => B.has(x))).size;
    const union = new Set([...A, ...B]).size || 1;
    return inter / union;
  }

  static getLineStartOffset(content: string, lineIndex: number): number {
    if (lineIndex <= 0) return 0;
    let pos = 0, line = 0;
    while (line < lineIndex && pos !== -1) {
      pos = content.indexOf('\n', pos);
      if (pos === -1) return content.length;
      pos += 1; line++;
    }
    return pos === -1 ? content.length : pos;
  }

  static getLineEndOffset(content: string, lineIndex: number): number {
    const start = ContentLocationService.getLineStartOffset(content, lineIndex);
    const end = content.indexOf('\n', start);
    return end === -1 ? content.length : end;
  }

  static expandRangeToIncludeNewline(content: string, range: Range): Range {
    // If the character after the range is a newline, include it in the deletion
    // to avoid leaving blank lines behind.
    if (range.end < content.length && content[range.end] === '\n') {
      return { start: range.start, end: range.end + 1 };
    }
    // If deleting at end of file, check if there's a leading newline we should remove instead
    if (range.start > 0 && content[range.start - 1] === '\n') {
      return { start: range.start - 1, end: range.end };
    }
    return range;
  }

  public static findInsertionPointAtLine(content: string, lineNumber: number): InsertionPoint {
    const lines = content.split('\n');
    const targetLineIndex = lineNumber - 1;

    // If the target line is beyond the file, append at end
    if (targetLineIndex >= lines.length) {
      return ContentLocationService.findTableInsertionPoint(content);
    }

    // If target line is 0 or negative, insert at beginning
    if (targetLineIndex <= 0) {
      return {
        offset: 0,
        needsNewlineBefore: false,
        needsNewlineAfter: true
      };
    }

    // Insert at the start of the target line (content will appear at that line number)
    const offset = ContentLocationService.getLineStartOffset(content, targetLineIndex);

    return {
      offset,
      needsNewlineBefore: false,
      needsNewlineAfter: true
    };
  }

  public findTaskInsertionPoint(content: string): InsertionPoint {
    const lines = content.split('\n');

    let lastTaskLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*[-*+]\s*\[[ xX]\]/.test(lines[i])) {
        lastTaskLineIndex = i;
        break;
      }
    }

    if (lastTaskLineIndex >= 0) {
      return ContentLocationService.insertAfterLine(content, lastTaskLineIndex);
    }

    return ContentLocationService.findTableInsertionPoint(content);
  }

  public async findListItemInsertionPoint(content: string, path: string, listIndex: number, queryListItemsByListIndex?: (path: string, listIndex: number) => Promise<Array<{ line_number: number | null; item_index: number }>>): Promise<InsertionPoint> {
    const lines = content.split('\n');

    if (queryListItemsByListIndex) {
      const existingItems = await queryListItemsByListIndex(path, listIndex);

      if (existingItems.length > 0) {
        const lastItem = existingItems
          .filter(item => item.line_number != null && item.line_number > 0)
          .sort((a, b) => (b.line_number ?? 0) - (a.line_number ?? 0))[0];

        if (lastItem?.line_number) {
          const lineIndex = lastItem.line_number - 1;
          if (lineIndex >= 0 && lineIndex < lines.length) {
            return ContentLocationService.insertAfterLine(content, lineIndex);
          }
        }
      }

      return ContentLocationService.findTableInsertionPoint(content);
    }

    let lastListItemLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // Match bullet or numbered list, but NOT task items (any checkbox state)
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) && !/^\s*[-*+]\s*\[[^\]]\]/.test(line)) {
        lastListItemLineIndex = i;
        break;
      }
    }

    if (lastListItemLineIndex >= 0) {
      return ContentLocationService.insertAfterLine(content, lastListItemLineIndex);
    }

    return ContentLocationService.findTableInsertionPoint(content);
  }

  public static findTableInsertionPoint(content: string): InsertionPoint {
    return ContentLocationService.findEndInsertionPoint(content);
  }

  public static findEndInsertionPoint(content: string): InsertionPoint {
    const endsWithNewline = content.endsWith('\n');
    return {
      offset: content.length,
      needsNewlineBefore: !endsWithNewline,
      needsNewlineAfter: false
    };
  }

  private static insertAfterLine(content: string, lineIndex: number): InsertionPoint {
    return {
      offset: ContentLocationService.getLineEndOffset(content, lineIndex),
      needsNewlineBefore: true,
      needsNewlineAfter: false
    };
  }

  public locateTableRange(content: string, tableInfo: TableLocationInfo): Range | null {
    if (tableInfo.block_id) {
      const r = this.rangeFromBlockId(tableInfo.path, tableInfo.block_id);
      if (r) return r;
    }
    
    if (ContentLocationService.isValidRange(content, tableInfo.table_start, tableInfo.table_end)) {
      const slice = content.slice(tableInfo.table_start!, tableInfo.table_end!);
      if (MarkdownTableUtils.isMarkdownTable(slice)) {
        return { start: tableInfo.table_start!, end: tableInfo.table_end! };
      }
    }
    return null;
  }
}
