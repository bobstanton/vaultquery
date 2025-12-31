import { markdownTable } from 'markdown-table';
import { ContentLocationService, type TableLocationInfo, type Range } from '../Services/ContentLocationService';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import { createTableKey, parseTableKey } from '../utils/StringUtils';
import type { TableCellRow, ReplaceRangeEdit, EntityPlanResult, EntityPlannerContext, TableRowGroup } from './types';

export class TableEditPlanner {
  public constructor(private readonly contentLocationService: ContentLocationService, private readonly discoverTableRange?: (content: string, tableIndex: number) => Range | null) {}

  public planTableEdits(ctx: EntityPlannerContext, tableCells: TableCellRow[]): EntityPlanResult {
    const edits: ReplaceRangeEdit[] = [];
    const warnings: string[] = [];

    const tables = this.groupCellsToTables(tableCells);

    for (const t of tables) {
      const tableLocationInfo: TableLocationInfo = {
        path: t.path,
        block_id: t.block_id,
        table_start: t.table_start,
        table_end: t.table_end
      };
      let blockRange = this.contentLocationService.locateTableRange(ctx.content, tableLocationInfo);
      if (!blockRange && this.discoverTableRange) {
        blockRange = this.discoverTableRange(ctx.content, t.table_index);
      }
      if (!blockRange) {
        blockRange = MarkdownTableUtils.findTableByIndex(ctx.content, t.table_index);
      }

      if (!blockRange) {
        const newTable = this.buildMarkdownTable(t.header, t.rows);

        const insertionPoint = t.line_number != null && t.line_number > 0
          ? ContentLocationService.findInsertionPointAtLine(ctx.content, t.line_number)
          : ContentLocationService.findTableInsertionPoint(ctx.content);

        const prefix = insertionPoint.needsNewlineBefore ? '\n' : '';
        const suffix = insertionPoint.needsNewlineAfter ? '\n' : '';

        edits.push({
          type: "replaceRange",
          path: ctx.path,
          range: { start: insertionPoint.offset, end: insertionPoint.offset },
          text: prefix + newTable + suffix,
          reason: t.line_number != null ? "create new table at specified line" : "create new table"
        });
        continue;
      }

      const existingTableMd = ctx.content.slice(blockRange.start, blockRange.end);
      const existingTable = this.parseMarkdownTable(existingTableMd);
      const mergedTable = this.mergeTableContent(existingTable, t);
      const rebuilt = this.buildMarkdownTable(mergedTable.header, mergedTable.rows);

      edits.push({ type: "replaceRange", path: ctx.path, range: blockRange, text: rebuilt + '\n', reason: "rewrite table" });
    }

    return { edits, warnings };
  }

  private groupCellsToTables(cells: TableCellRow[]): TableRowGroup[] {
    const byKey = new Map<string, { header: Set<string>; rows: Map<number, Record<string, string>>; line_number: number | null }>();
    for (const c of cells ?? []) {
      const key = createTableKey(c.path, c.table_index);
      const existing = byKey.get(key);
      const g = existing ?? (byKey.set(key, { header: new Set(), rows: new Map(), line_number: null }), byKey.get(key)!);
      g.header.add(c.column_name);
      const row = g.rows.get(c.row_index) ?? (g.rows.set(c.row_index, {}), g.rows.get(c.row_index)!);
      row[c.column_name] = c.cell_value ?? "";

      if (g.line_number === null && c.line_number != null) {
        g.line_number = c.line_number;
      }
    }

    const out: TableRowGroup[] = [];
    for (const [key, g] of byKey) {
      const { path, tableIndex: table_index } = parseTableKey(key);
      const rows = Array.from(g.rows.entries()).sort((a, b) => a[0] - b[0]).map(([_, r]) => r);
      out.push({
        path,
        table_index,
        line_number: g.line_number,
        header: Array.from(g.header.values()),
        rows,
      });
    }
    return out;
  }

  public buildMarkdownTable(header: string[], rows: Array<Record<string, string>>): string {
    const tableData = [
      header,
      ...rows.map(row => header.map(h => row[h] ?? ''))
    ];

    return markdownTable(tableData);
  }

  private parseMarkdownTable(tableMd: string): { header: string[]; rows: string[][] } | null {
    const lines = tableMd.split('\n').filter(l => /^\s*\|.*\|\s*$/.test(l));
    if (lines.length < 2) return null;

    const parseLine = (l: string) =>
      l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

    const header = parseLine(lines[0]);
    const rows = lines.slice(2).map(parseLine);

    return { header, rows };
  }

  private mergeTableContent(existingTable: { header: string[]; rows: string[][] } | null, newTable: TableRowGroup): { header: string[]; rows: Array<Record<string, string>> } {
    // Prefer existing table's header order to preserve column positions
    let header: string[];
    if (existingTable?.header && existingTable.header.length > 0) {
      header = [...existingTable.header];
      // Add any new columns from newTable that don't exist in existing
      for (const col of newTable.header) {
        if (!header.includes(col)) {
          header.push(col);
        }
      }
    }

    else {
      header = newTable.header;
    }

    return {
      header,
      rows: newTable.rows
    };
  }
}
