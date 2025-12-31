import type { HeadingRow } from '../Services/ContentLocationService';
import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { extractSql } from './types';

export class HeadingHandler implements EntityHandler {
  readonly supportedTables = ['headings', 'headings_view'];

  canHandle(table: string): boolean {
    return this.supportedTables.includes(table);
  }

  convertPreviewResult(
    previewResult: PreviewResult,
    _context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'delete') {
      return Promise.resolve({
        sqlToApply: extractSql(previewResult),
        tasksAfter: [],
        headingsAfter: [],
        headingsToDelete: previewResult.before.map(row => this.convertToHeadingRow(row)),
        tableCellsAfter: []
      });
    }

    return Promise.resolve({
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: previewResult.after.map(row => this.convertToHeadingRow(row)),
      tableCellsAfter: []
    });
  }

  handleInsertOperation(
    previewResult: PreviewResult,
    _context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const newHeadings = previewResult.after.map(row => {
      const heading = this.convertToHeadingRow(row);
      // Use user-specified line_number if provided, otherwise -1 for default insertion
      if (heading.line_number === null || heading.line_number === undefined) {
        heading.line_number = -1;
      }
      return heading;
    });

    return Promise.resolve({
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: newHeadings,
      tableCellsAfter: []
    });
  }

  convertToHeadingRow(row: Record<string, unknown>): HeadingRow {
    const path = typeof row.path === 'string' ? row.path : '';
    if (!path) {
      console.warn('[VaultQuery] HeadingHandler.convertToHeadingRow: missing required field "path"', row);
    }

    return {
      path,
      level: typeof row.level === 'number' ? row.level : 1,
      line_number: typeof row.line_number === 'number' ? row.line_number : null,
      heading_text: typeof row.heading_text === 'string' ? row.heading_text : '',
      block_id: typeof row.block_id === 'string' ? row.block_id : null,
      start_offset: typeof row.start_offset === 'number' ? row.start_offset : null,
      end_offset: typeof row.end_offset === 'number' ? row.end_offset : null,
      anchor_hash: typeof row.anchor_hash === 'string' ? row.anchor_hash : null
    };
  }
}
