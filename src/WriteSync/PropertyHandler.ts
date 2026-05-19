import type { EntityHandlerContext, PreviewResult, EditPlannerPreviewResult, PropertyRow } from './types';
import { asStr, createEntityResult } from './types';
import { BaseEntityHandler } from './BaseEntityHandler';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('WriteSync');

export class PropertyHandler extends BaseEntityHandler {
  public constructor() {
    super(['properties']);
  }

  convertPreviewResult(previewResult: PreviewResult, _context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'delete') {
      return Promise.resolve(createEntityResult(previewResult, {
        propertiesAfter: [],
        propertiesToDelete: previewResult.before.map(row => this.convertToPropertyRow(row))
      }));
    }

    if (previewResult.op === 'update') {
      const beforeProps = previewResult.before.map(row => this.convertToPropertyRow(row));
      const afterProps = previewResult.after.map(row => this.convertToPropertyRow(row));

      const propsToDelete: PropertyRow[] = [];
      for (let i = 0; i < beforeProps.length; i++) {
        const before = beforeProps[i];
        const after = afterProps[i];
        if (before && after && before.key !== after.key) {
          propsToDelete.push(before);
        }
      }

      return Promise.resolve(createEntityResult(previewResult, {
        propertiesAfter: afterProps,
        propertiesToDelete: propsToDelete.length > 0 ? propsToDelete : undefined
      }));
    }

    return Promise.resolve(createEntityResult(previewResult, {
      propertiesAfter: previewResult.after.map(row => this.convertToPropertyRow(row))
    }));
  }

  handleInsertOperation(previewResult: PreviewResult, _context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    return Promise.resolve(createEntityResult(previewResult, {
      propertiesAfter: previewResult.after.map(row => this.convertToPropertyRow(row))
    }));
  }

  convertToPropertyRow(row: Record<string, unknown>): PropertyRow {
    const path = asStr(row.path);
    if (!path) {
      logger.warn('PropertyHandler.convertToPropertyRow: missing required field "path"', row);
    }

    return {
      path,
      key: asStr(row.key),
      value: asStr(row.value, null),
      type: asStr(row.type, null)
    };
  }
}
