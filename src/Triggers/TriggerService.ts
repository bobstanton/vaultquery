import { App, TFile, Notice, normalizePath } from 'obsidian';
import type {
  TriggerFunctions,
  PendingAction,
  SetPropertyParams,
  RemovePropertyParams,
  RenameNoteParams,
  SetContentParams,
  ReplaceContentParams,
  UpdateTaskParams,
  CompleteTaskParams,
  AddTaskParams,
  DeleteTaskParams,
  UpdateHeadingParams,
  AddHeadingParams,
  DeleteHeadingParams,
  UpdateListItemParams,
  AddListItemParams,
  DeleteListItemParams,
  AddTableRowParams,
  SetTableCellParams,
  DeleteTableRowParams,
  CreateNoteParams
} from './TriggerFunctions';
import { logger as rootLogger } from '../utils/logger';
import { MarkdownTableUtils, type MarkdownTableLineInfo } from '../utils/MarkdownTableUtils';

const logger = rootLogger.scope('Triggers');

interface TriggerServiceDependencies {
  app: App;
  triggerFunctions: TriggerFunctions;
  reindexFile: (path: string) => Promise<void>;
}

interface MarkdownTableContext {
  file: TFile;
  lines: string[];
  table: MarkdownTableLineInfo;
}

const PATTERNS = {
  TASK_LINE: /^(\s*[-*+]?\s*\[)([^\]]*)(\]\s*)(.*)/,
  TASK_CHECKBOX: /^(\s*[-*+]?\s*\[)([^\]]*)(\].*)$/,
  HEADING: /^(#{1,6})\s+(.*)/,
  HEADING_VALIDATION: /^#{1,6}\s+/,
  LIST_ITEM: /^(\s*[-*+]\s*)/,
  LIST_ITEM_VALIDATION: /^\s*[-*+]\s+/,
} as const;

const MAX_CASCADE_DEPTH = 10;
const MAX_ACTIONS_PER_PASS = 50;

/**
 * Service for processing pending trigger actions and applying them to files.
 */
export class TriggerService {
  private app: App;
  private triggerFunctions: TriggerFunctions;
  private reindexFile: (path: string) => Promise<void>;

  public constructor(deps: TriggerServiceDependencies) {
    this.app = deps.app;
    this.triggerFunctions = deps.triggerFunctions;
    this.reindexFile = deps.reindexFile;

    this.triggerFunctions.setOnDeferredReady(() => {
      void this.processPendingActions();
    });
  }

  /**
   * Clean up resources (e.g., when unloading the plugin).
   */
  public destroy(): void {
    this.triggerFunctions.clearDeferTimers();
  }

  /** Get a TFile from path, logging warning if not found */
  private getFile(path: string, action: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      logger.warn(`Trigger: file not found for ${action}`, path);
      return null;
    }
    return file;
  }

  private async readCurrentFile(file: TFile): Promise<string> {
    return this.app.vault.read(file);
  }

  private async writeFromTrigger(file: TFile, content: string): Promise<void> {
    await this.app.vault.modify(file, content);
  }

  /** Read file and split into lines, validating line number */
  private async getFileLines(file: TFile, lineNumber: number, action: string): Promise<{ lines: string[]; lineIndex: number } | null> {
    const content = await this.readCurrentFile(file);
    const lines = content.split('\n');
    const lineIndex = lineNumber - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
      logger.warn(`Trigger: invalid line number for ${action}`, lineNumber);
      return null;
    }

    return { lines, lineIndex };
  }

  /**
   * Process all pending trigger actions.
   * Called after indexing completes.
   *
   * Supports cascading triggers: if a trigger (like WUPHF broadcast) fires during reindex
   * and queues new actions, those are processed in subsequent passes until no more
   * actions are pending.
   */
  public async processPendingActions(): Promise<void> {
    this.triggerFunctions.clearCurrentDeferKey();

    if (!this.triggerFunctions.hasPendingActions()) {
      return;
    }

    // Set flag to prevent vq_* functions from queuing (but sync handlers can still queue for cascade)
    this.triggerFunctions.setProcessingTriggers(true);

    let cascadeDepth = 0;

    try {
      // Loop until no more actions are pending (handles cascading triggers)
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
          }
        }

        // NOTE: This may fire cascading triggers that queue new actions
        // (e.g., WUPHF broadcast fires when table_cells gets new rows)
        // Temporarily allow vq_* functions to queue during reindex for cascade support
        this.triggerFunctions.setProcessingTriggers(false);
        for (const path of affectedPaths) {
          try {
            await this.reindexFile(path);
          } catch (error) {
            logger.error('Failed to re-index after trigger action', path, error);
          }
        }
        this.triggerFunctions.setProcessingTriggers(true);

        // Safety: limit actions per cascade pass to prevent runaway triggers
        const pendingCount = this.triggerFunctions.getPendingActionsCount();
        if (pendingCount > MAX_ACTIONS_PER_PASS) {
          logger.warn(`Too many actions queued (${pendingCount}), limiting to ${MAX_ACTIONS_PER_PASS}`);
          this.triggerFunctions.limitPendingActions(MAX_ACTIONS_PER_PASS);
        }
        // After reindex, loop back to check if any new actions were queued
      }

      if (cascadeDepth >= MAX_CASCADE_DEPTH) {
        logger.warn(`Max cascade depth reached ${MAX_CASCADE_DEPTH}. Possible infinite loop in triggers.`);
        this.triggerFunctions.clearPendingActions();
      }
    } finally {
      this.triggerFunctions.setProcessingTriggers(false);
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
        logger.warn('Unknown trigger action type', action);
        return {};
    }
  }

  private async setProperty({ path, key, value }: SetPropertyParams): Promise<void> {
    const file = this.getFile(path, 'set_property');
    if (!file) return;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[key] = value;
    });
  }

  private async removeProperty({ path, key }: RemovePropertyParams): Promise<void> {
    const file = this.getFile(path, 'remove_property');
    if (!file) return;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
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
      return null;
    }
  }

  private async setContent({ path, content }: SetContentParams): Promise<void> {
    const file = this.getFile(path, 'set_content');
    if (!file) return;

    const currentContent = await this.readCurrentFile(file);

    // Preserve frontmatter when setting content
    // The content parameter is just the body; we need to keep existing frontmatter
    const frontmatterMatch = currentContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const frontmatter = frontmatterMatch ? frontmatterMatch[0] : '';
    const newContent = frontmatter + content;

    await this.writeFromTrigger(file, newContent);
  }

  private async replaceContent({ path, search, replacement }: ReplaceContentParams): Promise<void> {
    const file = this.getFile(path, 'replace_content');
    if (!file) return;

    const fileContent = await this.readCurrentFile(file);
    const newContent = fileContent.split(search).join(replacement);

    if (newContent !== fileContent) {
      await this.writeFromTrigger(file, newContent);
    }
  }

  private async updateTask({ path, lineNumber, status, taskText }: UpdateTaskParams): Promise<void> {
    const file = this.getFile(path, 'update_task');
    if (!file) return;

    const result = await this.getFileLines(file, lineNumber, 'update_task');
    if (!result) return;

    const { lines, lineIndex } = result;

    const line = lines[lineIndex];
    const match = line.match(PATTERNS.TASK_LINE);
    if (!match) {
      const contextStart = Math.max(0, lineIndex - 2);
      const contextEnd = Math.min(lines.length, lineIndex + 3);
      const context = lines.slice(contextStart, contextEnd).map((l, i) => `  ${contextStart + i + 1}: ${l}`).join('\n');
      logger.warn('Trigger: line is not a task for update_task', { lineNumber, line, context });
      return;
    }

    const existingStatus = match[2];
    const statusChar = status === null
      ? existingStatus
      : status === 'DONE' ? 'x' : status === 'TODO' ? ' ' : status.charAt(0).toLowerCase();

    const existingText = match[4];
    const newText = taskText === null ? existingText : taskText;

    const newLine = `${match[1]}${statusChar}] ${newText}`;
    lines[lineIndex] = newLine;

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async setTaskStatus({ path, lineNumber, status }: CompleteTaskParams): Promise<void> {
    const file = this.getFile(path, 'setTaskStatus');
    if (!file) return;

    const result = await this.getFileLines(file, lineNumber, 'setTaskStatus');
    if (!result) return;

    const { lines, lineIndex } = result;
    const line = lines[lineIndex];
    const match = line.match(PATTERNS.TASK_CHECKBOX);
    if (!match) {
      logger.warn('Trigger: line is not a task for setTaskStatus', line);
      return;
    }

    const statusChar = status === 'DONE' ? 'x' : status === 'TODO' ? ' ' : status.charAt(0).toLowerCase();
    lines[lineIndex] = `${match[1]}${statusChar}${match[3]}`;

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async addTask({ path, text, afterLine }: AddTaskParams): Promise<void> {
    await this.insertLine(path, 'add_task', afterLine, `- [ ] ${text}`);
  }

  private async updateHeading({ path, lineNumber, level, headingText }: UpdateHeadingParams): Promise<void> {
    const file = this.getFile(path, 'update_heading');
    if (!file) return;

    const result = await this.getFileLines(file, lineNumber, 'update_heading');
    if (!result) return;

    const { lines, lineIndex } = result;

    const line = lines[lineIndex];
    const match = line.match(PATTERNS.HEADING);
    if (!match) {
      logger.warn('Trigger: line is not a heading for update_heading', line);
      return;
    }

    const existingLevel = match[1].length;
    const newLevel = level === null ? existingLevel : level;

    const existingText = match[2];
    const newText = headingText === null ? existingText : headingText;

    const hashes = '#'.repeat(newLevel);
    lines[lineIndex] = `${hashes} ${newText}`;

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async addHeading({ path, level, text, afterLine }: AddHeadingParams): Promise<void> {
    const hashes = '#'.repeat(Math.max(1, Math.min(6, level)));
    await this.insertLine(path, 'add_heading', afterLine, `${hashes} ${text}`);
  }

  private async addListItem({ path, text, afterLine }: AddListItemParams): Promise<void> {
    await this.insertLine(path, 'add_list_item', afterLine, `- ${text}`);
  }

  private async insertLine(path: string, action: string, afterLine: number, newLine: string): Promise<void> {
    const file = this.getFile(path, action);
    if (!file) return;

    const content = await this.readCurrentFile(file);
    const lines = content.split('\n');

    const insertIndex = Math.max(0, Math.min(afterLine, lines.length));
    lines.splice(insertIndex, 0, newLine);

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async deleteTask({ path, lineNumber }: DeleteTaskParams): Promise<void> {
    const file = this.getFile(path, 'delete_task');
    if (!file) return;

    const result = await this.getFileLines(file, lineNumber, 'delete_task');
    if (!result) return;

    const { lines, lineIndex } = result;

    const line = lines[lineIndex];
    if (!PATTERNS.TASK_CHECKBOX.test(line)) {
      logger.warn('Trigger: line is not a task for delete_task', line);
      return;
    }

    lines.splice(lineIndex, 1);

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async deleteHeading({ path, lineNumber }: DeleteHeadingParams): Promise<void> {
    const file = this.getFile(path, 'delete_heading');
    if (!file) return;

    const result = await this.getFileLines(file, lineNumber, 'delete_heading');
    if (!result) return;

    const { lines, lineIndex } = result;

    const line = lines[lineIndex];
    if (!PATTERNS.HEADING_VALIDATION.test(line)) {
      logger.warn('Trigger: line is not a heading for delete_heading', line);
      return;
    }

    lines.splice(lineIndex, 1);

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async deleteListItem({ path, lineNumber }: DeleteListItemParams): Promise<void> {
    const file = this.getFile(path, 'delete_list_item');
    if (!file) return;

    const result = await this.getFileLines(file, lineNumber, 'delete_list_item');
    if (!result) return;

    const { lines, lineIndex } = result;

    const line = lines[lineIndex];
    if (!PATTERNS.LIST_ITEM_VALIDATION.test(line)) {
      logger.warn('Trigger: line is not a list item for delete_list_item', line);
      return;
    }

    lines.splice(lineIndex, 1);

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async updateListItem({ path, lineNumber, itemText }: UpdateListItemParams): Promise<void> {
    const file = this.getFile(path, 'update_list_item');
    if (!file) return;

    const result = await this.getFileLines(file, lineNumber, 'update_list_item');
    if (!result) return;

    const { lines, lineIndex } = result;

    const line = lines[lineIndex];
    const match = line.match(PATTERNS.LIST_ITEM);
    if (!match) {
      logger.warn('Trigger: line is not a list item for update_list_item', line);
      return;
    }

    lines[lineIndex] = `${match[1]}${itemText}`;

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async getMarkdownTableContext(path: string, tableIndex: number, action: string, warningAction: string = action): Promise<MarkdownTableContext | null> {
    const file = this.getFile(path, action);
    if (!file) return null;

    const fileContent = await this.readCurrentFile(file);
    const lines = fileContent.split('\n');
    const tables = MarkdownTableUtils.parseTableLines(lines);

    if (tableIndex < 0 || tableIndex >= tables.length) {
      logger.warn(`Trigger: invalid table index for ${warningAction}`, tableIndex);
      return null;
    }

    return {
      file,
      lines,
      table: tables[tableIndex],
    };
  }

  private async addTableRow({ path, tableIndex, valuesJson }: AddTableRowParams): Promise<void> {
    const context = await this.getMarkdownTableContext(path, tableIndex, 'add_table_row', 'addTableRow');
    if (!context) return;

    const { file, lines, table } = context;
    let values: Record<string, string>;
    try {
      values = JSON.parse(valuesJson);
    } catch {
      logger.warn('Trigger: invalid JSON for addTableRow', valuesJson);
      return;
    }

    const cells = table.columns.map(col => values[col] || '');
    const newRow = `| ${cells.join(' | ')} |`;

    lines.splice(table.endLine + 1, 0, newRow);

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async setTableCell({ path, tableIndex, rowIndex, columnName, value }: SetTableCellParams): Promise<void> {
    const context = await this.getMarkdownTableContext(path, tableIndex, 'set_table_cell', 'updateTableCell');
    if (!context) return;

    const { file, lines, table } = context;
    const columnIndex = table.columns.indexOf(columnName);
    if (columnIndex === -1) {
      logger.warn('Trigger: column not found for updateTableCell', columnName);
      return;
    }

    const lineIndex = table.dataStartLine + rowIndex;
    if (lineIndex > table.endLine || lineIndex >= lines.length) {
      logger.warn('Trigger: invalid row index for updateTableCell', rowIndex);
      return;
    }

    const cells = MarkdownTableUtils.splitTableRow(lines[lineIndex]);
    if (columnIndex >= cells.length) {
      logger.warn('Trigger: cell index out of bounds for updateTableCell');
      return;
    }

    cells[columnIndex] = String(value).replace(/\|/g, '\\|');
    lines[lineIndex] = `| ${cells.join(' | ')} |`;

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async deleteTableRow({ path, tableIndex, rowIndex }: DeleteTableRowParams): Promise<void> {
    const context = await this.getMarkdownTableContext(path, tableIndex, 'delete_table_row', 'deleteTableRow');
    if (!context) return;

    const { file, lines, table } = context;
    const lineIndex = table.dataStartLine + rowIndex;
    if (lineIndex > table.endLine || lineIndex >= lines.length) {
      logger.warn('Trigger: invalid row index for deleteTableRow', rowIndex);
      return;
    }

    lines.splice(lineIndex, 1);

    await this.writeFromTrigger(file, lines.join('\n'));
  }

  private async createNote({ path, content }: CreateNoteParams): Promise<void> {
    const normalizedPath = normalizePath(path);

    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (existing) {
      logger.warn('Trigger: file already exists for createNote', path);
      return;
    }

    const folderPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
    if (folderPath) {
      const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
      if (!folder) {
        try {
          await this.app.vault.createFolder(normalizePath(folderPath));
        } catch {
          // Folder might already exist or be created concurrently
        }
      }
    }

    try {
      await this.app.vault.create(normalizedPath, content);
    } catch (error) {
      logger.error('Trigger: failed to create note', path, error);
    }
  }
}
