import type { TaskRow } from '../Services/ContentLocationService';
import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { extractSql } from './types';

export class TaskHandler implements EntityHandler {
  readonly supportedTables = ['tasks', 'tasks_view'];

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
        tasksToDelete: previewResult.before.map(row => this.convertToTaskRow(row)),
        headingsAfter: [],
        tableCellsAfter: []
      });
    }

    // For updates/inserts, check if these are new tasks (no line_number or id in before)
    const isNewTasks = previewResult.before.length === 0 ||
      previewResult.after.every(afterRow =>
        !previewResult.before.some(beforeRow => beforeRow.id === afterRow.id)
      );

    const tasks = previewResult.after.map(row => {
      const task = this.convertToTaskRow(row);
      const beforeRow = previewResult.before.find(b => b.id === row.id);
      const hasMatchingBefore = !!beforeRow;

      if (hasMatchingBefore) {
        // Preserve positioning data from before row for updates
        if (task.start_offset == null && beforeRow.start_offset != null) {
          task.start_offset = beforeRow.start_offset as number;
        }
        if (task.end_offset == null && beforeRow.end_offset != null) {
          task.end_offset = beforeRow.end_offset as number;
        }
        if (task.anchor_hash == null && beforeRow.anchor_hash != null) {
          task.anchor_hash = beforeRow.anchor_hash as string;
        }
        if (task.block_id == null && beforeRow.block_id != null) {
          task.block_id = beforeRow.block_id as string;
        }
      }

      if (isNewTasks || !hasMatchingBefore) {
        if (task.line_number === null || task.line_number === undefined) {
          task.line_number = -1;
        }
      }
      return task;
    });

    return Promise.resolve({
      sqlToApply: extractSql(previewResult),
      tasksAfter: tasks,
      headingsAfter: [],
      tableCellsAfter: []
    });
  }

  handleInsertOperation(
    previewResult: PreviewResult,
    _context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const newTasks = previewResult.after.map(row => {
      const task = this.convertToTaskRow(row);
      // Use user-specified line_number if provided, otherwise -1 for default insertion
      if (task.line_number === null || task.line_number === undefined) {
        task.line_number = -1;
      }
      return task;
    });

    return Promise.resolve({
      sqlToApply: extractSql(previewResult),
      tasksAfter: newTasks,
      headingsAfter: [],
      tableCellsAfter: []
    });
  }

  convertToTaskRow(row: Record<string, unknown>): TaskRow {
    const path = typeof row.path === 'string' ? row.path : '';
    if (!path) {
      console.warn('[VaultQuery] TaskHandler.convertToTaskRow: missing required field "path"', row);
    }

    return {
      id: typeof row.id === 'number' ? row.id : -1,
      path,
      task_text: typeof row.task_text === 'string' ? row.task_text : '',
      completed: row.completed === 1 ? 1 : 0,
      status: typeof row.status === 'string' ? row.status : null,
      priority: typeof row.priority === 'string' ? row.priority : null,
      due_date: typeof row.due_date === 'string' ? row.due_date : null,
      scheduled_date: typeof row.scheduled_date === 'string' ? row.scheduled_date : null,
      start_date: typeof row.start_date === 'string' ? row.start_date : null,
      created_date: typeof row.created_date === 'string' ? row.created_date : null,
      done_date: typeof row.done_date === 'string' ? row.done_date : null,
      cancelled_date: typeof row.cancelled_date === 'string' ? row.cancelled_date : null,
      recurrence: typeof row.recurrence === 'string' ? row.recurrence : null,
      on_completion: typeof row.on_completion === 'string' ? row.on_completion : null,
      task_id: typeof row.task_id === 'string' ? row.task_id : null,
      depends_on: typeof row.depends_on === 'string' ? row.depends_on : null,
      tags: typeof row.tags === 'string' ? row.tags : null,
      line_number: typeof row.line_number === 'number' ? row.line_number : null,
      block_id: typeof row.block_id === 'string' ? row.block_id : null,
      start_offset: typeof row.start_offset === 'number' ? row.start_offset : null,
      end_offset: typeof row.end_offset === 'number' ? row.end_offset : null,
      anchor_hash: typeof row.anchor_hash === 'string' ? row.anchor_hash : null,
      section_heading: typeof row.section_heading === 'string' ? row.section_heading : null
    };
  }
}
