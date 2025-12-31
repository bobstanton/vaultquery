import { App, TFile, MetadataCache, normalizePath } from 'obsidian';
import { escapeRegex, hashString } from '../utils/StringUtils';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';

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

export interface TaskRow {
  id: number;
  path: string;
  task_text: string;
  completed: 0 | 1;
  status?: string | null;
  priority?: string | null;
  due_date?: string | null;
  scheduled_date?: string | null;
  start_date?: string | null;
  created_date?: string | null;
  done_date?: string | null;
  cancelled_date?: string | null;
  recurrence?: string | null;
  on_completion?: string | null;
  task_id?: string | null;
  depends_on?: string | null;
  tags?: string | null;
  line_number?: number | null;
  block_id?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  anchor_hash?: string | null;
  section_heading?: string | null;
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

export class ContentLocationService {
  public constructor(private app: App, private metadataCache: MetadataCache) {}

  public static computeAnchorHash(content: string, lineIndex: number, lines: string[]): string {
    const prevLine = lineIndex > 0 ? lines[lineIndex - 1] : '';
    const currentLine = lines[lineIndex] || '';
    const nextLine = lineIndex < lines.length - 1 ? lines[lineIndex + 1] : '';
    
    const contextWindow = [prevLine, currentLine, nextLine]
      .map(line => line.trim().toLowerCase())
      .join('\n');
    
    const hashInput = `${contextWindow}::L${lineIndex}`;
    
    return hashString(hashInput);
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
    if (row.block_id) {
      const r = this.rangeFromBlockId(row.path, row.block_id);
      if (r && ContentLocationService.looksLikeTask(content.slice(r.start, r.end))) {
        return { kind: "ok", range: r };
      }
    }

    if (ContentLocationService.isValidRange(content, row.start_offset, row.end_offset)) {
      const slice = content.slice(row.start_offset!, row.end_offset!);
      if (ContentLocationService.looksLikeTask(slice)) {
        return { kind: "ok", range: { start: row.start_offset!, end: row.end_offset! } };
      }
    }

    if (row.anchor_hash) {
      const r = this.searchByAnchorHash(content, row.anchor_hash);
      if (r && ContentLocationService.looksLikeTask(content.slice(r.start, r.end))) {
        return { kind: "ok", range: r };
      }
    }

    const fuzzyResult = this.fuzzyTaskInSection(content, row);
    if (fuzzyResult) {
      return { kind: "ok", range: fuzzyResult };
    }

    return { kind: "miss", reason: "Unable to locate task safely" };
  }

  public locateHeading(content: string, row: HeadingRow): { kind: "ok"; range: Range } | { kind: "miss"; reason: string } {
    if (row.block_id) {
      const r = this.rangeFromBlockId(row.path, row.block_id);
      if (r && ContentLocationService.looksLikeHeading(content.slice(r.start, r.end))) {
        return { kind: "ok", range: r };
      }
    }

    if (ContentLocationService.isValidRange(content, row.start_offset, row.end_offset)) {
      const slice = content.slice(row.start_offset!, row.end_offset!);
      if (ContentLocationService.looksLikeHeading(slice)) {
        return { kind: "ok", range: { start: row.start_offset!, end: row.end_offset! } };
      }
    }

    if (row.anchor_hash) {
      const r = this.searchByAnchorHash(content, row.anchor_hash);
      if (r && ContentLocationService.looksLikeHeading(content.slice(r.start, r.end))) {
        return { kind: "ok", range: r };
      }
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
    if (row.block_id) {
      const r = this.rangeFromBlockId(row.path, row.block_id);
      if (r && ContentLocationService.looksLikeListItem(content.slice(r.start, r.end))) {
        return { kind: "ok", range: r };
      }
    }

    if (ContentLocationService.isValidRange(content, row.start_offset, row.end_offset)) {
      const slice = content.slice(row.start_offset!, row.end_offset!);
      if (ContentLocationService.looksLikeListItem(slice)) {
        return { kind: "ok", range: { start: row.start_offset!, end: row.end_offset! } };
      }
    }

    if (row.anchor_hash) {
      const r = this.searchByAnchorHash(content, row.anchor_hash);
      if (r && ContentLocationService.looksLikeListItem(content.slice(r.start, r.end))) {
        return { kind: "ok", range: r };
      }
    }

    return { kind: "miss", reason: "Unable to locate list item" };
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
      if (ContentLocationService.computeAnchorHash(content, i, lines) === targetHash) {
        return ContentLocationService.getLineOffsets(content, i);
      }
    }
    return null;
  }

  private fuzzyTaskInSection(content: string, row: TaskRow): Range | null {
    const normalized = ContentLocationService.normalizeText(row.task_text ?? "");
    const re = /^(?<indent>\s*)(?<bullet>[-*+])\s+\[[ xX]\]\s+(?<text>.*)$/gm;
    let best: { start: number; end: number; score: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const raw = m.groups?.text ?? "";
      const score = ContentLocationService.lcsScore(ContentLocationService.normalizeText(raw), normalized);
      if (score > (best?.score ?? 0)) {
        const lastNewline = content.lastIndexOf("\n", m.index);
        const start = lastNewline === -1 ? 0 : lastNewline + 1;
        // Find the newline AFTER the match starts, not at the match position
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
    // This prevents leaving blank lines after deletion
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

    // Convert 1-based line number to 0-based index
    const targetLineIndex = lineNumber - 1;

    // If the target line is beyond the file, append at end
    if (targetLineIndex >= lines.length) {
      const endsWithNewline = content.endsWith('\n');
      return {
        offset: content.length,
        needsNewlineBefore: !endsWithNewline,
        needsNewlineAfter: false
      };
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
      const offset = ContentLocationService.getLineEndOffset(content, lastTaskLineIndex);

      return {
        offset,
        needsNewlineBefore: true,
        needsNewlineAfter: false
      };
    }

    const endsWithNewline = content.endsWith('\n');
    return {
      offset: content.length,
      needsNewlineBefore: !endsWithNewline,
      needsNewlineAfter: false
    };
  }

  public async findListItemInsertionPoint(content: string, path: string, listIndex: number, queryListItemsByListIndex?: (path: string, listIndex: number) => Promise<Array<{ line_number: number | null; item_index: number }>>): Promise<InsertionPoint> {
    const lines = content.split('\n');

    if (queryListItemsByListIndex) {
      const existingItems = await queryListItemsByListIndex(path, listIndex);

      if (existingItems.length > 0) {
        // Find the last item in this list 
        const lastItem = existingItems
          .filter(item => item.line_number != null && item.line_number > 0)
          .sort((a, b) => (b.line_number ?? 0) - (a.line_number ?? 0))[0];

        if (lastItem?.line_number) {
          // line_number is 1-based, convert to 0-based index
          const lineIndex = lastItem.line_number - 1;
          if (lineIndex >= 0 && lineIndex < lines.length) {
            const offset = ContentLocationService.getLineEndOffset(content, lineIndex);
            return {
              offset,
              needsNewlineBefore: true,
              needsNewlineAfter: false
            };
          }
        }
      }

      const endsWithNewline = content.endsWith('\n');
      return {
        offset: content.length,
        needsNewlineBefore: !endsWithNewline,
        needsNewlineAfter: false
      };
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
      const offset = ContentLocationService.getLineEndOffset(content, lastListItemLineIndex);

      return {
        offset,
        needsNewlineBefore: true,
        needsNewlineAfter: false
      };
    }

    const endsWithNewline = content.endsWith('\n');
    return {
      offset: content.length,
      needsNewlineBefore: !endsWithNewline,
      needsNewlineAfter: false
    };
  }

  public static findTableInsertionPoint(content: string): InsertionPoint {
    const endsWithNewline = content.endsWith('\n');
    return {
      offset: content.length,
      needsNewlineBefore: !endsWithNewline,
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