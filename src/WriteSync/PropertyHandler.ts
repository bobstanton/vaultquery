import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult, PropertyRow } from './types';
import { extractSql } from './types';

export class PropertyHandler implements EntityHandler {
  readonly supportedTables = ['properties'];

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
        tableCellsAfter: [],
        propertiesAfter: [],
        propertiesToDelete: previewResult.before.map(row => this.convertToPropertyRow(row))
      });
    }

    // For updates, check if key changed - if so, we need to delete old and add new
    if (previewResult.op === 'update') {
      const beforeProps = previewResult.before.map(row => this.convertToPropertyRow(row));
      const afterProps = previewResult.after.map(row => this.convertToPropertyRow(row));

      // Find properties where the key changed (need to delete old key)
      const propsToDelete: PropertyRow[] = [];
      for (let i = 0; i < beforeProps.length; i++) {
        const before = beforeProps[i];
        const after = afterProps[i];
        if (before && after && before.key !== after.key) {
          propsToDelete.push(before);
        }
      }

      return Promise.resolve({
        sqlToApply: extractSql(previewResult),
        tasksAfter: [],
        headingsAfter: [],
        tableCellsAfter: [],
        propertiesAfter: afterProps,
        propertiesToDelete: propsToDelete.length > 0 ? propsToDelete : undefined
      });
    }

    // For inserts, just add the new properties
    return Promise.resolve({
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      propertiesAfter: previewResult.after.map(row => this.convertToPropertyRow(row))
    });
  }

  handleInsertOperation(
    previewResult: PreviewResult,
    _context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    return Promise.resolve({
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      propertiesAfter: previewResult.after.map(row => this.convertToPropertyRow(row))
    });
  }

  convertToPropertyRow(row: Record<string, unknown>): PropertyRow {
    const path = typeof row.path === 'string' ? row.path : '';
    if (!path) {
      console.warn('[VaultQuery] PropertyHandler.convertToPropertyRow: missing required field "path"', row);
    }

    return {
      path,
      key: typeof row.key === 'string' ? row.key : '',
      value: typeof row.value === 'string' ? row.value : null,
      type: typeof row.type === 'string' ? row.type : null
    };
  }
}
