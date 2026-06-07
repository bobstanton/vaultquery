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
      const existingTable = MarkdownTableUtils.parseMarkdownTable(existingTableMd);
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

      let group = byKey.get(key);
      if (!group) {
        group = { header: new Set(), rows: new Map(), line_number: null };
        byKey.set(key, group);
      }

      group.header.add(c.column_name);

      let row = group.rows.get(c.row_index);
      if (!row) {
        row = {};
        group.rows.set(c.row_index, row);
      }

      row[c.column_name] = c.cell_value ?? "";

      if (group.line_number === null && c.line_number != null) {
        group.line_number = c.line_number;
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

  private mergeTableContent(existingTable: { header: string[]; rows: string[][] } | null, newTable: TableRowGroup): { header: string[]; rows: Array<Record<string, string>> } {
    let header: string[];
    if (existingTable?.header && existingTable.header.length > 0) {
      header = [...existingTable.header];
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
