import { App, TFile, Notice, normalizePath } from 'obsidian';
import { assertNever } from './TriggerFunctions';
import type { TriggerFunctions, PendingAction, SetPropertyParams, RemovePropertyParams, RenameNoteParams, SetContentParams, ReplaceContentParams, UpdateTaskParams, CompleteTaskParams, AddTaskParams, DeleteTaskParams, UpdateHeadingParams, AddHeadingParams, DeleteHeadingParams, UpdateListItemParams, AddListItemParams, DeleteListItemParams, AddTableRowParams, SetTableCellParams, DeleteTableRowParams, CreateNoteParams } from './TriggerFunctions';
import { logger as rootLogger } from '../utils/logger';
import { createNoteWithFolders } from '../utils/VaultUtils';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import { ContentLocationService } from '../Services/ContentLocationService';
import type { Range } from '../Services/ContentLocationService';
import { HeadingEditPlanner, ListItemEditPlanner, TableEditPlanner } from '../EditPlanner';
import type { ListItemRow } from '../EditPlanner';

const logger = rootLogger.scope('Triggers');

interface TriggerServiceDependencies {
  app: App;
  triggerFunctions: TriggerFunctions;
  reindexFile: (path: string) => Promise<void>;
}

const MAX_CASCADE_DEPTH = 10;
const MAX_ACTIONS_PER_PASS = 50;
const MAX_ISSUES_IN_NOTICE = 3;

/**
 * Service for processing pending trigger actions and applying them to files.
 */
const TASK_LINE_CAPTURE = /^(\s*[-*+]\s+\[)([^\]])(\]\s*)(.*)$/;

const HEADING_CAPTURE = /^(#{1,6})\s+(.*)$/;

const TODO_CHECKBOX = ContentLocationService.statusToCheckbox('TODO') ?? ' ';

function clampHeadingLevel(level: number): number {
  return Math.max(1, Math.min(6, level));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ParsedTaskLine {
  prefix: string;
  checkbox: string;
  rest: string;
  text: string;
}

function parseTaskLine(line: string): ParsedTaskLine | null {
  if (!ContentLocationService.looksLikeTask(line)) {
    return null;
  }

  const match = line.match(TASK_LINE_CAPTURE);
  if (!match) {
    return null;
  }

  return { prefix: match[1], checkbox: match[2], rest: match[3] + match[4], text: match[4] };
}

export class TriggerService {
  private app: App;
  private triggerFunctions: TriggerFunctions;
  private reindexFile: (path: string) => Promise<void>;
  private headingPlanner: HeadingEditPlanner;
  private listItemPlanner: ListItemEditPlanner;
  private tablePlanner: TableEditPlanner;
  private runIssues: string[] = [];

  public constructor(deps: TriggerServiceDependencies) {
    this.app = deps.app;
    this.triggerFunctions = deps.triggerFunctions;
    this.reindexFile = deps.reindexFile;

    const contentLocationService = new ContentLocationService(this.app, this.app.metadataCache);
    this.headingPlanner = new HeadingEditPlanner(contentLocationService);
    this.listItemPlanner = new ListItemEditPlanner(contentLocationService);
    this.tablePlanner = new TableEditPlanner();

    this.triggerFunctions.setOnDeferredReady(() => {
      void this.processPendingActions();
    });
  }

  public destroy(): void {
    this.triggerFunctions.clearDeferTimers();
  }

  private reportIssue(action: string, message: string, details?: unknown): void {
    if (details === undefined) {
      logger.warn(`Trigger ${action}: ${message}`);
    } else {
      logger.warn(`Trigger ${action}: ${message}`, details);
    }
    this.runIssues.push(`${action}: ${message}`);
  }

  private showRunIssues(): void {
    if (this.runIssues.length === 0) {
      return;
    }

    const shown = this.runIssues.slice(0, MAX_ISSUES_IN_NOTICE);
    const extra = this.runIssues.length - shown.length;
    const suffix = extra > 0 ? `\n…and ${extra} more (see console)` : '';
    new Notice(`VaultQuery: ${this.runIssues.length} trigger action(s) did not apply:\n${shown.join('\n')}${suffix}`);
    this.runIssues = [];
  }

  private getFile(path: string, action: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      this.reportIssue(action, `file not found: ${path}`);
      return null;
    }
    return file;
  }

  /**
   * Uses vault.process so a trigger writing to a note that is open in an
   * editor never clobbers concurrent edits with content from a stale read.
   */
  private async transformFile(file: TFile, transform: (content: string) => string | null): Promise<void> {
    await this.app.vault.process(file, (content) => transform(content) ?? content);
  }

  /**
   * Process all pending trigger actions.
   * Called after indexing completes.
   *
   * Supports cascading triggers: if a trigger fires during reindex and queues
   * new actions, those are processed in subsequent passes until no more
   * actions are pending.
   */
  public async processPendingActions(): Promise<void> {
    this.triggerFunctions.clearCurrentDeferKey();

    if (!this.triggerFunctions.hasPendingActions()) {
      return;
    }

    this.runIssues = [];

    // Set flag to prevent vq_* functions from queuing (but sync handlers can still queue for cascade)
    this.triggerFunctions.setProcessingTriggers(true);

    let cascadeDepth = 0;

    try {
      while (this.triggerFunctions.hasPendingActions() && cascadeDepth < MAX_CASCADE_DEPTH) {
        cascadeDepth++;
        const actions = this.triggerFunctions.getPendingActions();
        if (actions.length === 0) break;

        const affectedPaths = new Set<string>();

        for (const action of actions) {
          try {
            const result = await this.executeAction(action);
            if (result.affectedPath) {
              affectedPaths.add(result.affectedPath);
            }
          } catch (error) {
            logger.error('Trigger action failed', action, error);
            this.runIssues.push(`${action.type}: ${errorMessage(error)}`);
          }
        }

        // NOTE: This may fire cascading triggers that queue new actions
        // (e.g., a trigger watching table_cells fires again when a row lands there)
        // Temporarily allow vq_* functions to queue during reindex for cascade support
        this.triggerFunctions.setProcessingTriggers(false);
        for (const path of affectedPaths) {
          try {
            await this.reindexFile(path);
          } catch (error) {
            logger.error('Failed to re-index after trigger action', path, error);
            this.runIssues.push(`re-index ${path}: ${errorMessage(error)}`);
          }
        }
        this.triggerFunctions.setProcessingTriggers(true);

        const pendingCount = this.triggerFunctions.getPendingActionsCount();
        if (pendingCount > MAX_ACTIONS_PER_PASS) {
          logger.warn(`Too many actions queued (${pendingCount}), limiting to ${MAX_ACTIONS_PER_PASS}`);
          this.triggerFunctions.limitPendingActions(MAX_ACTIONS_PER_PASS);
        }
      }

      if (cascadeDepth >= MAX_CASCADE_DEPTH) {
        logger.warn(`Max cascade depth reached ${MAX_CASCADE_DEPTH}. Possible infinite loop in triggers.`);
        this.triggerFunctions.clearPendingActions();
      }
    } finally {
      this.triggerFunctions.setProcessingTriggers(false);
      this.showRunIssues();
    }
  }

  private async executeAction(action: PendingAction): Promise<{ affectedPath?: string }> {
    switch (action.type) {
      case 'set_property':
        await this.setProperty(action.params);
        return { affectedPath: action.params.path };

      case 'remove_property':
        await this.removeProperty(action.params);
        return { affectedPath: action.params.path };

      case 'notify':
        new Notice(action.params.message);
        return {};

      case 'rename_note': {
        const newPath = await this.renameNote(action.params);
        return newPath ? { affectedPath: newPath } : {};
      }

      case 'set_content':
        await this.setContent(action.params);
        return { affectedPath: action.params.path };

      case 'replace_content':
        await this.replaceContent(action.params);
        return { affectedPath: action.params.path };

      case 'update_task':
        await this.updateTask(action.params);
        return { affectedPath: action.params.path };

      case 'complete_task':
        await this.setTaskStatus(action.params);
        return { affectedPath: action.params.path };

      case 'add_task':
        await this.addTask(action.params);
        return { affectedPath: action.params.path };

      case 'delete_task':
        await this.deleteTask(action.params);
        return { affectedPath: action.params.path };

      case 'update_heading':
        await this.updateHeading(action.params);
        return { affectedPath: action.params.path };

      case 'add_heading':
        await this.addHeading(action.params);
        return { affectedPath: action.params.path };

      case 'delete_heading':
        await this.deleteHeading(action.params);
        return { affectedPath: action.params.path };

      case 'update_list_item':
        await this.updateListItem(action.params);
        return { affectedPath: action.params.path };

      case 'add_list_item':
        await this.addListItem(action.params);
        return { affectedPath: action.params.path };

      case 'delete_list_item':
        await this.deleteListItem(action.params);
        return { affectedPath: action.params.path };

      case 'add_table_row':
        await this.addTableRow(action.params);
        return { affectedPath: action.params.path };

      case 'set_table_cell':
        await this.setTableCell(action.params);
        return { affectedPath: action.params.path };

      case 'delete_table_row':
        await this.deleteTableRow(action.params);
        return { affectedPath: action.params.path };

      case 'create_note':
        await this.createNote(action.params);
        return { affectedPath: action.params.path };

      default:
        return assertNever(action);
    }
  }

  private async setProperty({ path, key, value }: SetPropertyParams): Promise<void> {
    const file = this.getFile(path, 'set_property');
    if (!file) return;

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[key] = value;
    });
  }

  private async removeProperty({ path, key }: RemovePropertyParams): Promise<void> {
    const file = this.getFile(path, 'remove_property');
    if (!file) return;

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      delete fm[key];
    });
  }

  private async renameNote({ path, newName }: RenameNoteParams): Promise<string | null> {
    const file = this.getFile(path, 'rename_note');
    if (!file) return null;
    const folder = file.parent?.path || '';
    const extension = file.extension;
    const newPath = folder ? `${folder}/${newName}.${extension}` : `${newName}.${extension}`;

    try {
      await this.app.fileManager.renameFile(file, newPath);
      return newPath;
    }
    catch (error) {
      logger.error('Trigger: failed to rename note', { path, newPath }, error);
      this.runIssues.push(`rename_note: failed to rename ${path} - ${errorMessage(error)}`);
      return null;
    }
  }

  private async setContent({ path, content }: SetContentParams): Promise<void> {
    const file = this.getFile(path, 'set_content');
    if (!file) return;

    await this.transformFile(file, (currentContent) => {
      // Preserve frontmatter when setting content
      // The content parameter is just the body; we need to keep existing frontmatter
      const frontmatterMatch = currentContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const frontmatter = frontmatterMatch ? frontmatterMatch[0] : '';
      return frontmatter + content;
    });
  }

  private async replaceContent({ path, search, replacement }: ReplaceContentParams): Promise<void> {
    const file = this.getFile(path, 'replace_content');
    if (!file) return;

    await this.transformFile(file, (fileContent) => {
      const newContent = fileContent.split(search).join(replacement);
      return newContent !== fileContent ? newContent : null;
    });
  }

  private locateLine(content: string, lineNumber: number, action: string): { range: Range; line: string } | null {
    const lineIndex = lineNumber - 1;
    if (lineIndex < 0 || lineIndex >= content.split('\n').length) {
      this.reportIssue(action, `invalid line number ${lineNumber}`);
      return null;
    }

    const range = ContentLocationService.getLineOffsets(content, lineIndex);
    return { range, line: content.slice(range.start, range.end) };
  }

  private async rewriteLine(path: string, lineNumber: number, action: string, rewrite: (line: string) => string | null): Promise<void> {
    const file = this.getFile(path, action);
    if (!file) return;

    await this.transformFile(file, (content) => {
      const located = this.locateLine(content, lineNumber, action);
      if (!located) return null;

      const next = rewrite(located.line);
      if (next === null || next === located.line) return null;

      return content.slice(0, located.range.start) + next + content.slice(located.range.end);
    });
  }

  private async deleteEntityLine(path: string, lineNumber: number, action: string, isEntity: (line: string) => boolean, entityName: string): Promise<void> {
    const file = this.getFile(path, action);
    if (!file) return;

    await this.transformFile(file, (content) => {
      const located = this.locateLine(content, lineNumber, action);
      if (!located) return null;

      if (!isEntity(located.line)) {
        this.reportIssue(action, `line ${lineNumber} is not a ${entityName}`, located.line);
        return null;
      }

      const range = ContentLocationService.expandRangeToIncludeNewline(content, located.range);
      return content.slice(0, range.start) + content.slice(range.end);
    });
  }

  private async insertLineAfter(path: string, action: string, afterLine: number, text: string): Promise<void> {
    const file = this.getFile(path, action);
    if (!file) return;

    await this.transformFile(file, (content) => {
      const point = ContentLocationService.findInsertionPointAtLine(content, Math.max(0, afterLine) + 1);
      const prefix = point.needsNewlineBefore ? '\n' : '';
      const suffix = point.needsNewlineAfter ? '\n' : '';
      return content.slice(0, point.offset) + prefix + text + suffix + content.slice(point.offset);
    });
  }

  private async updateTask({ path, lineNumber, status, taskText }: UpdateTaskParams): Promise<void> {
    await this.rewriteLine(path, lineNumber, 'update_task', (line) => {
      const parsed = parseTaskLine(line);
      if (!parsed) {
        this.reportIssue('update_task', `line ${lineNumber} is not a task`, line);
        return null;
      }

      const checkbox = status === null ? parsed.checkbox : ContentLocationService.statusToCheckbox(status);
      if (checkbox === null) {
        this.reportIssue('update_task', `unknown task status "${status}"`);
        return null;
      }

      const text = taskText === null ? parsed.text : taskText;
      return `${parsed.prefix}${checkbox}] ${text}`;
    });
  }

  private async setTaskStatus({ path, lineNumber, status }: CompleteTaskParams): Promise<void> {
    await this.rewriteLine(path, lineNumber, 'complete_task', (line) => {
      const parsed = parseTaskLine(line);
      if (!parsed) {
        this.reportIssue('complete_task', `line ${lineNumber} is not a task`, line);
        return null;
      }

      const checkbox = ContentLocationService.statusToCheckbox(status);
      if (checkbox === null) {
        this.reportIssue('complete_task', `unknown task status "${status}"`);
        return null;
      }

      return `${parsed.prefix}${checkbox}${parsed.rest}`;
    });
  }

  private async addTask({ path, text, afterLine }: AddTaskParams): Promise<void> {
    await this.insertLineAfter(path, 'add_task', afterLine, `- [${TODO_CHECKBOX}] ${text}`);
  }

  private async deleteTask({ path, lineNumber }: DeleteTaskParams): Promise<void> {
    await this.deleteEntityLine(path, lineNumber, 'delete_task', ContentLocationService.looksLikeTask, 'task');
  }

  private async updateHeading({ path, lineNumber, level, headingText }: UpdateHeadingParams): Promise<void> {
    await this.rewriteLine(path, lineNumber, 'update_heading', (line) => {
      const match = ContentLocationService.looksLikeHeading(line) ? line.match(HEADING_CAPTURE) : null;
      if (!match) {
        this.reportIssue('update_heading', `line ${lineNumber} is not a heading`, line);
        return null;
      }

      if (level === null && headingText !== null) {
        return this.headingPlanner.emitHeadingLine({ path, level: match[1].length, heading_text: headingText }, line);
      }

      return this.headingPlanner.emitHeadingLine({
        path,
        level: clampHeadingLevel(level ?? match[1].length),
        heading_text: headingText ?? match[2],
      });
    });
  }

  private async addHeading({ path, level, text, afterLine }: AddHeadingParams): Promise<void> {
    const line = this.headingPlanner.emitHeadingLine({ path, level: clampHeadingLevel(level), heading_text: text });
    await this.insertLineAfter(path, 'add_heading', afterLine, line);
  }

  private async deleteHeading({ path, lineNumber }: DeleteHeadingParams): Promise<void> {
    await this.deleteEntityLine(path, lineNumber, 'delete_heading', ContentLocationService.looksLikeHeading, 'heading');
  }

  private listItemRow(path: string, content: string): ListItemRow {
    return { id: 0, path, list_index: 0, item_index: 0, content, list_type: 'bullet', indent_level: 0 };
  }

  private async updateListItem({ path, lineNumber, itemText }: UpdateListItemParams): Promise<void> {
    await this.rewriteLine(path, lineNumber, 'update_list_item', (line) => {
      if (!ContentLocationService.looksLikeListItem(line)) {
        this.reportIssue('update_list_item', `line ${lineNumber} is not a list item`, line);
        return null;
      }

      return this.listItemPlanner.emitListItemLine(this.listItemRow(path, itemText), line);
    });
  }

  private async addListItem({ path, text, afterLine }: AddListItemParams): Promise<void> {
    await this.insertLineAfter(path, 'add_list_item', afterLine, this.listItemPlanner.emitListItemLine(this.listItemRow(path, text)));
  }

  private async deleteListItem({ path, lineNumber }: DeleteListItemParams): Promise<void> {
    await this.deleteEntityLine(path, lineNumber, 'delete_list_item', ContentLocationService.looksLikeListItem, 'list item');
  }

  private async transformMarkdownTable(path: string, tableIndex: number, action: string, buildRows: (header: string[], rows: string[][]) => string[][] | null): Promise<void> {
    const file = this.getFile(path, action);
    if (!file) return;

    await this.transformFile(file, (content) => {
      const range = MarkdownTableUtils.findTableByIndex(content, tableIndex);
      if (!range) {
        this.reportIssue(action, `table ${tableIndex} not found in ${path}`);
        return null;
      }

      const parsed = MarkdownTableUtils.parseMarkdownTable(content.slice(range.start, range.end));
      if (!parsed) {
        this.reportIssue(action, `could not parse table ${tableIndex} in ${path}`);
        return null;
      }

      const nextRows = buildRows(parsed.header, parsed.rows);
      if (nextRows === null) return null;

      const records = nextRows.map(cells => Object.fromEntries(parsed.header.map((column, index) => [column, cells[index] ?? ''])));
      const rebuilt = this.tablePlanner.buildMarkdownTable(parsed.header, records);
      return content.slice(0, range.start) + rebuilt + '\n' + content.slice(range.end);
    });
  }

  private async addTableRow({ path, tableIndex, values }: AddTableRowParams): Promise<void> {
    await this.transformMarkdownTable(path, tableIndex, 'add_table_row', (header, rows) => [...rows, header.map(column => values[column] || '')]);
  }

  private async setTableCell({ path, tableIndex, rowIndex, columnName, value }: SetTableCellParams): Promise<void> {
    await this.transformMarkdownTable(path, tableIndex, 'set_table_cell', (header, rows) => {
      const columnIndex = header.indexOf(columnName);
      if (columnIndex === -1) {
        this.reportIssue('set_table_cell', `column "${columnName}" not found`);
        return null;
      }

      if (rowIndex < 0 || rowIndex >= rows.length) {
        this.reportIssue('set_table_cell', `invalid row index ${rowIndex}`);
        return null;
      }

      const next = rows.map(row => [...row]);
      next[rowIndex][columnIndex] = value;
      return next;
    });
  }

  private async deleteTableRow({ path, tableIndex, rowIndex }: DeleteTableRowParams): Promise<void> {
    await this.transformMarkdownTable(path, tableIndex, 'delete_table_row', (_header, rows) => {
      if (rowIndex < 0 || rowIndex >= rows.length) {
        this.reportIssue('delete_table_row', `invalid row index ${rowIndex}`);
        return null;
      }

      return rows.filter((_, index) => index !== rowIndex);
    });
  }

  private async createNote({ path, content }: CreateNoteParams): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (existing) {
      logger.warn('Trigger: file already exists for createNote', path);
      return;
    }

    try {
      await createNoteWithFolders(this.app.vault, path, content);
    } catch (error) {
      logger.error('Trigger: failed to create note', path, error);
      this.runIssues.push(`create_note: failed to create ${path} - ${errorMessage(error)}`);
    }
  }
}
