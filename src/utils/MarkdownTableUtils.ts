interface MarkdownTable {
  table_index: number;
  table_name?: string;
  block_id?: string;
  start_offset: number;
  end_offset: number;
  line_number: number;
}

export interface ParsedMarkdownTable {
  headers: string[];
  rows: string[][];
  totalLines: number;
  dataStartLine: number;
}

export class MarkdownTableUtils {
  private static readonly TABLE_ROW_PATTERN = /^\s*\|.*\|\s*$/;
  private static readonly TABLE_ALIGN_ROW_PATTERN = /^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|\s*$/;

  private static *iterateTables(lines: string[]): Generator<{ startLine: number; endLineExclusive: number }> {
    let i = 0;
    while (i < lines.length - 1) {
      if (this.isTableRow(lines[i]) && this.isAlignRow(lines[i + 1])) {
        let j = i + 2;
        while (j < lines.length && this.isTableRow(lines[j])) j++;
        yield { startLine: i, endLineExclusive: j };
        i = j;
        continue;
      }
      i++;
    }
  }

  static escapeTableCell(value: string): string {
    return value.replace(/\|/g, '\\|');
  }

  static splitTableRow(line: string): string[] {
    const cells: string[] = [];
    let current = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const next = line[i + 1];

      if (char === '\\' && next === '|') {
        current += '|';
        i++;
        continue;
      }

      if (char === '|') {
        cells.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    cells.push(current.trim());

    if (cells.length > 0 && cells[0] === '') {
      cells.shift();
    }
    if (cells.length > 0 && cells[cells.length - 1] === '') {
      cells.pop();
    }

    return cells;
  }

  static detectAllTables(content: string, contentOffset: number = 0, noteTitle?: string): MarkdownTable[] {
    const lines = content.split('\n');
    const lineOffsets = this.buildLineStartOffsets(lines);
    const tables: MarkdownTable[] = [];
    let tableIdx = 0;
    let currentHeading: string | undefined;
    let headingScanFrom = 0;

    for (const { startLine, endLineExclusive } of this.iterateTables(lines)) {
      for (let i = headingScanFrom; i <= startLine; i++) {
        const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
          currentHeading = headingMatch[2].trim();
        }
      }

      let j = endLineExclusive;
      let block_id: string | undefined;
      if (j < lines.length) {
        const blockMatch = lines[j].match(/\^([\w-]+)\s*$/);
        if (blockMatch) {
          block_id = blockMatch[1];
          j++;
        }
      }

      tables.push({
        table_index: tableIdx++,
        table_name: block_id ?? currentHeading ?? noteTitle,
        block_id,
        start_offset: lineOffsets[startLine] + contentOffset,
        end_offset: lineOffsets[j] + contentOffset,
        line_number: startLine + 1
      });
      headingScanFrom = j;
      currentHeading = undefined;
    }

    return tables;
  }

  static findTableByIndex(content: string, tableIndex: number): { start: number; end: number } | null {
    const lines = content.split('\n');
    const lineOffsets = this.buildLineStartOffsets(lines);
    let found = 0;

    for (const { startLine, endLineExclusive } of this.iterateTables(lines)) {
      if (found === tableIndex) {
        return { start: lineOffsets[startLine], end: lineOffsets[endLineExclusive] };
      }
      found++;
    }

    return null;
  }

  static isMarkdownTable(s: string): boolean {
    const lines = s.trim().split('\n');
    if (lines.length < 2) return false;
    if (!this.isTableRow(lines[0])) return false;
    if (!this.isAlignRow(lines[1])) return false;
    return true;
  }

  static parseMarkdownTable(tableMd: string): { header: string[]; rows: string[][] } | null {
    const parsed = this.parseMarkdownTableAt(tableMd.split('\n'), 0);
    if (parsed.headers.length === 0) {
      return null;
    }

    return {
      header: parsed.headers,
      rows: parsed.rows,
    };
  }

  static parseMarkdownTableAt(lines: string[], startIndex: number): ParsedMarkdownTable {
    const tableLines: string[] = [];
    let currentIndex = startIndex;

    while (currentIndex < lines.length && this.isTableRow(lines[currentIndex])) {
      tableLines.push(lines[currentIndex]);
      currentIndex++;
    }

    if (tableLines.length < 2) {
      return { headers: [], rows: [], totalLines: 0, dataStartLine: 0 };
    }

    let headerLineIndex = -1;
    let separatorLineIndex = -1;

    for (let i = 0; i < Math.min(3, tableLines.length); i++) {
      const cells = this.splitTableRow(tableLines[i]);
      const isSeparator = this.isSeparatorCells(cells);

      if (isSeparator) {
        separatorLineIndex = i;
      }
      else if (headerLineIndex === -1 && cells.length > 0) {
        headerLineIndex = i;
      }
    }

    if (headerLineIndex === -1 || separatorLineIndex === -1) {
      return { headers: [], rows: [], totalLines: 0, dataStartLine: 0 };
    }

    const headers = this.splitTableRow(tableLines[headerLineIndex]);
    const rows: string[][] = [];

    for (let i = separatorLineIndex + 1; i < tableLines.length; i++) {
      const cells = this.splitTableRow(tableLines[i]);
      if (this.isSeparatorCells(cells) || cells.length === 0) {
        continue;
      }

      while (cells.length < headers.length) {
        cells.push('');
      }
      if (cells.length > headers.length) {
        cells.splice(headers.length);
      }
      rows.push(cells);
    }

    return {
      headers,
      rows,
      totalLines: tableLines.length,
      dataStartLine: separatorLineIndex + 1,
    };
  }

  private static isTableRow(line: string): boolean {
    return MarkdownTableUtils.TABLE_ROW_PATTERN.test(line);
  }

  private static isAlignRow(line: string): boolean {
    return MarkdownTableUtils.TABLE_ALIGN_ROW_PATTERN.test(line);
  }

  private static isSeparatorCells(cells: string[]): boolean {
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
  }

  private static buildLineStartOffsets(lines: string[]): number[] {
    const offsets = new Array<number>(lines.length + 1);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      offsets[i] = offset;
      offset += lines[i].length + 1;
    }
    offsets[lines.length] = offset;
    return offsets;
  }
}
