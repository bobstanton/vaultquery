interface MarkdownTable {
  table_index: number;
  table_name?: string;
  block_id?: string;
  start_offset: number;
  end_offset: number;
}

export class MarkdownTableUtils {
  /**
   * Split a markdown table row on unescaped pipe characters.
   * Leading/trailing table delimiters are removed, escaped pipes are kept as cell text.
   */
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

  /**
   * Detect all markdown tables in content.
   */
  static detectAllTables(content: string, contentOffset: number = 0, noteTitle?: string): MarkdownTable[] {
    const lines = content.split('\n');
    const tables: MarkdownTable[] = [];
    let tableIdx = 0;
    let currentHeading: string | undefined;

    const isTableHeader = (s: string) => /^\s*\|.*\|\s*$/.test(s);
    const isAlignRow = (s: string) => /^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|\s*$/.test(s);
    const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);

    let i = 0;
    while (i < lines.length) {
      const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        currentHeading = headingMatch[2].trim();
      }

      if (i < lines.length - 1 && isTableHeader(lines[i]) && isAlignRow(lines[i + 1])) {
        const start_offset = this.getLineStartOffset(content, i) + contentOffset;
        let j = i + 2;
        while (j < lines.length && isTableRow(lines[j])) j++;

        let block_id: string | undefined;
        if (j < lines.length) {
          const blockMatch = lines[j].match(/\^([\w-]+)\s*$/);
          if (blockMatch) {
            block_id = blockMatch[1];
            j++;
          }
        }

        const end_offset = this.getLineStartOffset(content, j) + contentOffset;
        const table_name = block_id ?? currentHeading ?? noteTitle;
        tables.push({
          table_index: tableIdx++,
          table_name,
          block_id,
          start_offset,
          end_offset
        });
        i = j;
        currentHeading = undefined;
        continue;
      }
      i++;
    }
    return tables;
  }

  static findTableByIndex(content: string, tableIndex: number): { start: number; end: number } | null {
    const lines = content.split('\n');
    let i = 0, found = 0;
    
    while (i < lines.length - 1) {
      const currentLine = lines[i];
      const nextLine = lines[i + 1];
      
      if (/^\s*\|.*\|\s*$/.test(currentLine) && 
        /^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|\s*$/.test(nextLine)) {
        
        if (found === tableIndex) {
          const start = this.getLineStartOffset(content, i);
          let j = i + 2;

          while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
            j++;
          }

          const end = this.getLineStartOffset(content, j);
          return { start, end };
        }
        
        found++;
        
        let j = i + 2;
        while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
          j++;
        }
        i = j;
        continue;
      }
      i++;
    }
    
    return null;
  }

  static isMarkdownTable(s: string): boolean {
    const lines = s.trim().split('\n');
    if (lines.length < 2) return false;
    if (!/^\s*\|.*\|\s*$/.test(lines[0])) return false;
    if (!/^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|\s*$/.test(lines[1])) return false;
    return true;
  }

  private static getLineStartOffset(content: string, lineIndex: number): number {
    const lines = content.split('\n');
    let offset = 0;
    for (let i = 0; i < lineIndex && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    return offset;
  }
}
