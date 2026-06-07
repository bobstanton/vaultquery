import { ContentLocationService } from '../Services/ContentLocationService';
import type { HeadingRow, EntityPlanResult, EntityPlannerContext } from './types';
import { getBlockIdSuffix, planLineEntityEdits } from './types';

export class HeadingEditPlanner {
  public constructor(private readonly contentLocationService: ContentLocationService) {}

  public planHeadingEdits(ctx: EntityPlannerContext, headings: HeadingRow[], headingsToDelete: HeadingRow[]): EntityPlanResult {
    return planLineEntityEdits(ctx, headings, headingsToDelete, {
      entityName: 'headings',
      insertAtLineReason: 'insert headings at specified line',
      insertNewReason: 'insert new headings',
      updateReason: 'rename heading',
      deleteReason: 'delete heading',
      locate: row => this.contentLocationService.locateHeading(ctx.content, row),
      missingMessage: (row, action, reason) => `${ctx.path}: heading "${row.heading_text}"${action} - ${reason}`,
      emit: (row, existing) => this.emitHeadingLine(row, existing),
      findNewInsertionPoint: () => ContentLocationService.findEndInsertionPoint(ctx.content),
    });
  }

  private preserveFenceAndId(existing: string): { fence: string; suffix: string } {
    const m = existing.match(/^(#+)\s+.*?(\s+#+\s*)?(\s+\{#.*\})?\s*$/);
    return { fence: (m?.[1] ?? "##"), suffix: ((m?.[2] ?? "") + (m?.[3] ?? "")) };
  }

  public emitHeadingLine(row: HeadingRow, existing?: string): string {
    const { fence, suffix } = existing
      ? this.preserveFenceAndId(existing)
      : { fence: "#".repeat(row.level || 1), suffix: "" };
    const blockIdSuffix = getBlockIdSuffix(row.block_id, existing);

    return `${fence} ${row.heading_text}${suffix}${blockIdSuffix}`.trimEnd();
  }
}
