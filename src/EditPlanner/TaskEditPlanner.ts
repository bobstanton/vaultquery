import { ContentLocationService } from '../Services/ContentLocationService';
import type { TaskRow, ReplaceRangeEdit, EntityPlanResult, EntityPlannerContext } from './types';
import { getBlockIdSuffix, validateLineNumberBatch, pushInsertionEdit } from './types';

interface TaskStyle { bullet: "-" | "*" | "+"; indent: string; }

export class TaskEditPlanner {
  public constructor(private readonly contentLocationService: ContentLocationService) {}

  public planTaskEdits(ctx: EntityPlannerContext, tasks: TaskRow[], tasksToDelete: TaskRow[]): EntityPlanResult {
    const edits: ReplaceRangeEdit[] = [];
    const warnings: string[] = [];
    const newTasks: TaskRow[] = [];
    const tasksWithLineNumber: TaskRow[] = [];

    for (const row of tasks) {
      if (row.line_number === -1) {
        newTasks.push(row);
        continue;
      }

      if (row.line_number != null && row.line_number > 0 && row.start_offset == null && row.end_offset == null && !row.block_id) {
        tasksWithLineNumber.push(row);
        continue;
      }

      const loc = this.contentLocationService.locateTask(ctx.content, row);
      if (loc.kind === "miss") {
        warnings.push(`${ctx.path}: task ${row.id} - ${loc.reason}`);
        continue;
      }
      const existing = ctx.content.slice(loc.range.start, loc.range.end);
      const next = this.emitTaskLine(row, !!row.completed, existing);
      if (next !== existing) {
        edits.push({ type: "replaceRange", path: ctx.path, range: loc.range, text: next, reason: "update task" });
      }
    }

    if (tasksWithLineNumber.length > 0) {
      const minLineNumber = validateLineNumberBatch(tasksWithLineNumber, 'tasks', warnings);
      const insertionPoint = ContentLocationService.findInsertionPointAtLine(ctx.content, minLineNumber);
      const combinedText = tasksWithLineNumber.map(t => this.emitTaskLine(t, !!t.completed)).join('\n');
      pushInsertionEdit(edits, ctx, insertionPoint, combinedText, 'insert tasks at specified line');
    }

    if (newTasks.length > 0) {
      const insertionPoint = this.contentLocationService.findTaskInsertionPoint(ctx.content);
      const newTaskText = newTasks.map(t => this.emitTaskLine(t, !!t.completed)).join('\n');
      pushInsertionEdit(edits, ctx, insertionPoint, newTaskText, 'insert new tasks');
    }

    for (const row of tasksToDelete) {
      const loc = this.contentLocationService.locateTask(ctx.content, row);
      if (loc.kind === "miss") {
        warnings.push(`${ctx.path}: task ${row.id} to delete - ${loc.reason}`);
        continue;
      }
      const deleteRange = ContentLocationService.expandRangeToIncludeNewline(ctx.content, loc.range);
      edits.push({
        type: "replaceRange",
        path: ctx.path,
        range: deleteRange,
        text: "",
        reason: "delete task"
      });
    }

    return { edits, warnings };
  }

  private parseTaskStyle(existing: string): TaskStyle {
    const m = existing.match(/^(\s*)([-*+])\s+\[[ xX]\]/);
    return { indent: m?.[1] ?? "", bullet: (m?.[2] as "-" | "*" | "+") ?? "-" };
  }

  public emitTaskLine(base: TaskRow, completed: boolean, existing?: string): string {
    const style = existing ? this.parseTaskStyle(existing) : { indent: "", bullet: "-" as const };
    const blockIdSuffix = getBlockIdSuffix(base.block_id, existing);

    const status = base.status?.toUpperCase() ?? '';

    let box: string;
    if (status === 'CANCELLED') {
      box = "[-]";
    }

    else if (status === 'IN_PROGRESS') {
      box = "[/]";
    }

    else if (status === 'DONE' || completed) {
      box = "[x]";
    }

    else {
      box = "[ ]";
    }

    let text = base.task_text ?? "";

    text = text.replace(/🔺|⏫|🔼|🔽|⏬/g, '');
    text = text.replace(/➕\s*\d{4}-\d{2}-\d{2}/g, '');
    text = text.replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, '');
    text = text.replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, '');
    text = text.replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '');
    text = text.replace(/✅\s*\d{4}-\d{2}-\d{2}/g, '');
    text = text.replace(/❌\s*\d{4}-\d{2}-\d{2}/g, '');
    text = text.replace(/🔁\s*[^📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🆔⛔🏁#]*/g, '');
    text = text.replace(/🏁\s*\w+/g, '');
    text = text.replace(/🆔\s*[\w-]+/g, '');
    text = text.replace(/⛔\s*[\w,-]+/g, '');
    text = text.replace(/#[\w-]+/g, '');
    text = text.replace(/\s+\^[\w-]+\s*$/, '');
    text = text.trim();

    const parts: string[] = [text];

    if (base.created_date) parts.push(`➕ ${base.created_date}`);
    if (base.scheduled_date) parts.push(`⏳ ${base.scheduled_date}`);
    if (base.start_date) parts.push(`🛫 ${base.start_date}`);
    if (base.due_date) parts.push(`📅 ${base.due_date}`);
    if (base.done_date && (status === 'DONE' || completed)) parts.push(`✅ ${base.done_date}`);
    if (base.cancelled_date && status === 'CANCELLED') parts.push(`❌ ${base.cancelled_date}`);
    if (base.recurrence) parts.push(`🔁 ${base.recurrence}`);
    if (base.on_completion) parts.push(`🏁 ${base.on_completion}`);

    if (base.priority) {
      const priority = base.priority.toLowerCase();
      const emoji = priority === 'highest' ? '🔺' :
                    priority === 'high' ? '⏫' :
                    priority === 'medium' ? '🔼' :
                    priority === 'low' ? '🔽' :
                    priority === 'lowest' ? '⏬' : '';
      if (emoji) parts.push(emoji);
    }

    if (base.task_id) parts.push(`🆔 ${base.task_id}`);
    if (base.depends_on) parts.push(`⛔ ${base.depends_on}`);

    if (base.tags) {
      const tagStr = base.tags.trim();
      if (tagStr) {
        const formattedTags = tagStr.split(/\s+/)
          .map(tag => tag.startsWith('#') ? tag : `#${tag}`)
          .join(' ');
        parts.push(formattedTags);
      }
    }

    const fullText = parts.filter(p => p).join(' ');
    return `${style.indent}${style.bullet} ${box} ${fullText}${blockIdSuffix}`;
  }
}
