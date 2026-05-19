import type { TaskRow } from '../Services/ContentLocationService';
import type { EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { asNum, asStr, createEntityResult, readLocationFields } from './types';
import { BaseEntityHandler } from './BaseEntityHandler';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('WriteSync');

export class TaskHandler extends BaseEntityHandler {
  public constructor() {
    super(['tasks', 'tasks_view']);
  }

  convertPreviewResult(previewResult: PreviewResult, _context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'delete') {
      return Promise.resolve(createEntityResult(previewResult, {
        tasksAfter: [],
        tasksToDelete: previewResult.before.map(row => this.convertToTaskRow(row)),
        tableCellsAfter: []
      }));
    }

    const isNewTasks = previewResult.before.length === 0 ||
      previewResult.after.every(afterRow =>
        !previewResult.before.some(beforeRow => beforeRow.id === afterRow.id)
      );

    const tasks = previewResult.after.map(row => {
      const task = this.convertToTaskRow(row);
      const beforeRow = previewResult.before.find(b => b.id === row.id);
      const hasMatchingBefore = !!beforeRow;

      if (hasMatchingBefore) {
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
        if (task.line_number == null) {
          task.line_number = -1;
        }
      }
      return task;
    });

    return Promise.resolve(createEntityResult(previewResult, {
      tasksAfter: tasks,
      tableCellsAfter: []
    }));
  }

  handleInsertOperation(previewResult: PreviewResult, _context: EntityHandlerContext): Promise<EditPlannerPreviewResult> {
    const newTasks = previewResult.after.map(row => {
      const task = this.convertToTaskRow(row);
      if (task.line_number == null) {
        task.line_number = -1;
      }
      return task;
    });

    return Promise.resolve(createEntityResult(previewResult, {
      tasksAfter: newTasks,
      tableCellsAfter: []
    }));
  }

  convertToTaskRow(row: Record<string, unknown>): TaskRow {
    const path = asStr(row.path);
    if (!path) {
      logger.warn('TaskHandler.convertToTaskRow: missing required field "path"', row);
    }

    return {
      id: asNum(row.id, -1),
      path,
      task_text: asStr(row.task_text),
      completed: row.completed === 1 ? 1 : 0,
      status: asStr(row.status, null),
      priority: asStr(row.priority, null),
      due_date: asStr(row.due_date, null),
      scheduled_date: asStr(row.scheduled_date, null),
      start_date: asStr(row.start_date, null),
      created_date: asStr(row.created_date, null),
      done_date: asStr(row.done_date, null),
      cancelled_date: asStr(row.cancelled_date, null),
      recurrence: asStr(row.recurrence, null),
      on_completion: asStr(row.on_completion, null),
      task_id: asStr(row.task_id, null),
      depends_on: asStr(row.depends_on, null),
      tags: asStr(row.tags, null),
      ...readLocationFields(row),
      section_heading: asStr(row.section_heading, null)
    };
  }
}
