export * from './types';
export { TaskHandler } from './TaskHandler';
export { HeadingHandler } from './HeadingHandler';
export { ListItemHandler } from './ListItemHandler';
export { PropertyHandler } from './PropertyHandler';
export { TableCellHandler } from './TableCellHandler';
export { ContentHandler } from './ContentHandler';

import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { createEmptyResult, extractSql } from './types';
import { TaskHandler } from './TaskHandler';
import { HeadingHandler } from './HeadingHandler';
import { ListItemHandler } from './ListItemHandler';
import { PropertyHandler } from './PropertyHandler';
import { TableCellHandler } from './TableCellHandler';
import { ContentHandler } from './ContentHandler';

/**
 * Registry of all entity handlers
 */
export class EntityHandlerRegistry {
  private handlers: EntityHandler[] = [];
  private tableCellHandler: TableCellHandler;

  public constructor() {
    this.tableCellHandler = new TableCellHandler();
    this.handlers = [
      new TaskHandler(),
      new HeadingHandler(),
      new ListItemHandler(),
      new PropertyHandler(),
      this.tableCellHandler,
      new ContentHandler()
    ];
  }

  /**
   * Find a handler that can process the given table
   */
  findHandler(table: string): EntityHandler | null {
    return this.handlers.find(h => h.canHandle(table)) || null;
  }

  /**
   * Get the TableCellHandler for dynamic view transformation
   */
  getTableCellHandler(): TableCellHandler {
    return this.tableCellHandler;
  }

  /**
   * Convert a preview result using the appropriate handler
   */
  async convertPreviewResult(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const handler = this.findHandler(previewResult.table);
    if (!handler) {
      return createEmptyResult(extractSql(previewResult));
    }
    return handler.convertPreviewResult(previewResult, context);
  }

  /**
   * Handle an INSERT operation using the appropriate handler
   */
  async handleInsertOperation(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const handler = this.findHandler(previewResult.table);
    if (!handler) {
      return createEmptyResult(extractSql(previewResult));
    }
    return handler.handleInsertOperation(previewResult, context);
  }
}
