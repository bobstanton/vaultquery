import type { HeadingRow } from '../Services/ContentLocationService';
import type { EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { asNum, asStr, createEntityResult, readLocationFields } from './types';
import { BaseEntityHandler } from './BaseEntityHandler';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('WriteSync');

export class HeadingHandler extends BaseEntityHandler {
  public constructor() {
    super(['headings', 'headings_view']);
  }

  convertPreviewResult(previewResult: PreviewResult, _context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'delete') {
      return Promise.resolve(createEntityResult(previewResult, {
        headingsAfter: [],
        headingsToDelete: previewResult.before.map(row => this.convertToHeadingRow(row)),
        tableCellsAfter: []
      }));
    }

    return Promise.resolve(createEntityResult(previewResult, {
      headingsAfter: previewResult.after.map(row => this.convertToHeadingRow(row)),
      tableCellsAfter: []
    }));
  }

  handleInsertOperation(previewResult: PreviewResult, _context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    const newHeadings = previewResult.after.map(row => {
      const heading = this.convertToHeadingRow(row);
      if (heading.line_number == null) {
        heading.line_number = -1;
      }
      return heading;
    });

    return Promise.resolve(createEntityResult(previewResult, {
      headingsAfter: newHeadings,
      tableCellsAfter: []
    }));
  }

  convertToHeadingRow(row: Record<string, unknown>): HeadingRow {
    const path = asStr(row.path);
    if (!path) {
      logger.warn('HeadingHandler.convertToHeadingRow: missing required field "path"', row);
    }

    return {
      path,
      level: asNum(row.level, 1),
      heading_text: asStr(row.heading_text),
      ...readLocationFields(row)
    };
  }
}
