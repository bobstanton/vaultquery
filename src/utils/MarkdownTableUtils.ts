import { ContentLocationService } from '../Services/ContentLocationService';

interface MarkdownTable {
  table_index: number;
  table_name?: string;
  block_id?: string;
  start_offset: number;
  end_offset: number;
}

export class MarkdownTableUtils {
  /**
   * Detect all markdown tables in content.
   * @param content The markdown content to scan
   * @param contentOffset Character offset to add to positions
   * @param noteTitle Optional fallback name when no heading or block_id exists
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
        const start_offset = ContentLocationService.getLineStartOffset(content, i) + contentOffset;
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

        const end_offset = ContentLocationService.getLineStartOffset(content, j) + contentOffset;
        // Priority: block_id > heading > note title
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
          const start = ContentLocationService.getLineStartOffset(content, i);
          let j = i + 2;

          while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
            j++;
          }

          const end = ContentLocationService.getLineStartOffset(content, j);
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
}