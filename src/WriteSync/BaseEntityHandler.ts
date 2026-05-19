import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';

export abstract class BaseEntityHandler implements EntityHandler {
  public constructor(public readonly supportedTables: string[]) {}

  public canHandle(table: string): boolean {
    return this.supportedTables.includes(table);
  }

  public abstract convertPreviewResult(previewResult: PreviewResult, context: EntityHandlerContext): Promise<EditPlannerPreviewResult>;

  public abstract handleInsertOperation(previewResult: PreviewResult, context: EntityHandlerContext): Promise<EditPlannerPreviewResult>;
}
