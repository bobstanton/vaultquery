import { App, TFile, Notice, normalizePath } from 'obsidian';
import { VaultDatabase } from '../Database/DatabaseService';
import { VaultQuerySettings } from '../Settings/Settings';
import { EditPlanner } from './EditPlanner';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import { getErrorMessage, ERROR_MESSAGES, WARNING_MESSAGES, INFO_MESSAGES, CONSOLE_ERRORS } from '../utils/ErrorMessages';
import { createTableKey, parseTableKey, createCellKey } from '../utils/StringUtils';
import { EntityHandlerRegistry, type PreviewResult, type EditPlannerPreviewResult, type EntityHandlerContext, createEmptyResult, extractSql } from '../WriteSync';

import type { PreviewResult as ServicePreviewResult } from './PreviewService';
import type { EditPlan, Edit, ReplaceRangeEdit, FrontmatterEdit } from './EditPlanner';
import type { TaskRow, HeadingRow, ListItemRow, TableCellRow } from './ContentLocationService';

export class WriteOperationError extends Error {
  public constructor(message: string, public readonly operation: string, public readonly filePath?: string, public readonly cause?: Error) {
    super(message);
    this.name = 'WriteOperationError';
  }
}

export class WriteSyncService {
  private editPlanner: EditPlanner;
  private handlerRegistry: EntityHandlerRegistry;
  private handlerContext: EntityHandlerContext;

  public constructor(private app: App, private database: VaultDatabase, private settings: VaultQuerySettings) {
    this.editPlanner = new EditPlanner({
      app: this.app,
      metadataCache: this.app.metadataCache,
      readFile: this.readFileContent.bind(this),
      discoverTableRange: (content: string, tableIndex: number) => MarkdownTableUtils.findTableByIndex(content, tableIndex),
      queryListItemsByListIndex: this.queryListItemsByListIndex.bind(this)
    });

    this.handlerRegistry = new EntityHandlerRegistry();
    this.handlerContext = {
      readFileContent: this.readFileContent.bind(this),
      queryDatabase: this.queryDatabase.bind(this),
      settings: {
        allowDeleteNotes: this.settings.allowDeleteNotes
      }
    };
  }

  private async queryListItemsByListIndex(path: string, listIndex: number): Promise<Array<{ line_number: number | null; item_index: number }>> {
    const results = await this.database.all(
      'SELECT line_number, item_index FROM list_items WHERE path = ? AND list_index = ? ORDER BY item_index',
      [path, listIndex]
    );
    return results.map(row => ({
      line_number: row.line_number as number | null,
      item_index: row.item_index as number
    }));
  }

  private async queryDatabase<T>(sql: string, params?: (string | number | null)[]): Promise<T[]> {
    return await this.database.all(sql, params) as T[];
  }

  public async syncChanges(previewResult: ServicePreviewResult): Promise<string[]> {
    try {
      const editPlannerPreview = await this.convertPreviewResult(previewResult as unknown as PreviewResult);
      const editPlan = await this.editPlanner.planFromPreview(editPlannerPreview);

      if (editPlan.warnings.length > 0) {
        console.warn(`[VaultQuery] Edit plan warnings:`, editPlan.warnings);
        // eslint-disable-next-line obsidianmd/prefer-stringify-yaml -- false positive: Notice message with colon, not YAML
        new Notice(`VaultQuery: ${WARNING_MESSAGES.EDIT_PLAN_WARNINGS(editPlan.warnings.length)}`, 5000);
      }

      let affectedPaths: string[] = [];
      if (editPlan.edits.length > 0) {
        affectedPaths = await this.applyEditPlan(editPlan);
        // eslint-disable-next-line obsidianmd/prefer-stringify-yaml -- false positive: Notice message with colon, not YAML
        new Notice(`VaultQuery: ${INFO_MESSAGES.FILES_UPDATED(editPlan.stats.filesTouched)}`, 3000);
      }

      return affectedPaths;

    }

    catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.WRITE_SYNC_ERROR}:`, message);

      const contextualError = error instanceof WriteOperationError
        ? error
        : new WriteOperationError(
          ERROR_MESSAGES.WRITE_SYNC_FAILED(message),
          'syncChanges',
          undefined,
          error instanceof Error ? error : undefined
        );

      new Notice(INFO_MESSAGES.SYNC_FAILED(contextualError.message), 8000);
      throw contextualError;
    }
  }

  private async applyEditPlan(editPlan: EditPlan): Promise<string[]> {
    const editsByFile = this.groupEditsByFile(editPlan.edits);
    const affectedPaths: string[] = [];

    for (const [filePath, edits] of editsByFile) {
      await this.applyEditsToFile(filePath, edits);
      affectedPaths.push(filePath);
    }

    return affectedPaths;
  }

  private async applyEditsToFile(filePath: string, edits: Edit[]): Promise<void> {
    const deleteEdit = edits.find(e => e.type === 'deleteFile');
    if (deleteEdit) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
      if (file instanceof TFile) {
        await this.app.fileManager.trashFile(file);
      }
      return;
    }

    const createEdit = edits.find(e => e.type === 'createFile');
    const rangeEdits = edits.filter(e => e.type === 'replaceRange') as ReplaceRangeEdit[];
    const frontmatterEdits = edits.filter(e => e.type === 'frontmatter') as FrontmatterEdit[];

    if (createEdit) {
      const pathParts = createEdit.path.split('/');
      if (pathParts.length > 1) {
        const parentPath = normalizePath(pathParts.slice(0, -1).join('/'));
        const parentFolder = this.app.vault.getAbstractFileByPath(parentPath);
        if (!parentFolder) {
          try {
            await this.app.vault.createFolder(parentPath);
          }
          catch (e) {
            // Folder might already exist due to race condition, ignore
            console.warn('[VaultQuery] WriteSyncService: Folder creation failed (may already exist)', parentPath, e);
          }
        }
      }

      let finalContent = createEdit.text;
      if (rangeEdits.length > 0) {
        const sortedEdits = [...rangeEdits].sort((a, b) => b.range.start - a.range.start);
        for (const edit of sortedEdits) {
          finalContent = this.applyRangeEdit(finalContent, edit);
        }
      }

      await this.app.vault.create(normalizePath(createEdit.path), finalContent);

      if (frontmatterEdits.length > 0) {
        const newFile = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
        if (newFile instanceof TFile) {
          for (const edit of frontmatterEdits) {
            await this.applyFrontmatterEdit(newFile, edit);
          }
        }
      }
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(file instanceof TFile)) {
      throw new WriteOperationError(ERROR_MESSAGES.FILE_NOT_FOUND(filePath), 'applyEditsToFile', filePath);
    }

    for (const edit of frontmatterEdits) {
      await this.applyFrontmatterEdit(file, edit);
    }

    if (rangeEdits.length > 0) {
      // eslint-disable-next-line obsidianmd/vault/prefer-cached-read -- need fresh content for accurate range edits
      const content = await this.app.vault.read(file);

      let modifiedContent = content;
      const sortedEdits = [...rangeEdits].sort((a, b) => b.range.start - a.range.start);
      for (const edit of sortedEdits) {
        modifiedContent = this.applyRangeEdit(modifiedContent, edit);
      }

      // eslint-disable-next-line obsidianmd/prefer-editor-api -- Editor not available in write sync; using vault.modify for file updates
      await this.app.vault.modify(file, modifiedContent);
    }
  }


  private applyRangeEdit(content: string, edit: ReplaceRangeEdit): string {
    const { start, end } = edit.range;

    if (start < 0 || end < 0 || start > end || end > content.length) {
      throw new WriteOperationError(
        ERROR_MESSAGES.INVALID_EDIT_RANGE(start, end, content.length),
        'applyRangeEdit',
        edit.path
      );
    }

    return content.slice(0, start) + edit.text + content.slice(end);
  }

  private async applyFrontmatterEdit(file: TFile, edit: FrontmatterEdit): Promise<string> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      edit.mutate(frontmatter);
    });
    // eslint-disable-next-line obsidianmd/vault/prefer-cached-read -- need fresh content after frontmatter mutation
    return await this.app.vault.read(file);
  }

  private groupEditsByFile(edits: Edit[]): Map<string, Edit[]> {
    const byFile = new Map<string, Edit[]>();

    for (const edit of edits) {
      const path = edit.path;
      const existing = byFile.get(path) || [];
      existing.push(edit);
      byFile.set(path, existing);
    }

    return byFile;
  }

  private async readFileContent(path: string): Promise<string> {
    try {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(file instanceof TFile)) {
        throw new Error(ERROR_MESSAGES.FILE_NOT_FOUND(path));
      }
      // eslint-disable-next-line obsidianmd/vault/prefer-cached-read -- need fresh content for accurate edit planning
      return await this.app.vault.read(file);
    }
    catch (error: unknown) {
      console.warn(`[VaultQuery] ${WARNING_MESSAGES.FILE_READ_FAILED(path, getErrorMessage(error))}`);
      return '';
    }
  }


  private async convertPreviewResult(previewResult: PreviewResult): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'multi' && previewResult.multiResults) {
      return this.handleMultiOperation(previewResult);
    }

    const viewToTable: Record<string, string> = {
      'table_rows': 'table_cells',
      'headings_view': 'headings',
      'list_items_view': 'list_items',
      'notes_with_properties': 'notes',
      'tasks_view': 'tasks'
    };

    const syncTables = ['notes', 'properties', 'tasks', 'table_cells', 'headings', 'table_rows', 'headings_view', 'list_items', 'list_items_view', 'tags', 'links'];
    let effectiveTable = viewToTable[previewResult.table] || previewResult.table;

    const isDynamicTableView = effectiveTable.endsWith('_table') && !syncTables.includes(effectiveTable);
    if (isDynamicTableView) {
      effectiveTable = 'table_cells';
      previewResult = this.handlerRegistry.getTableCellHandler().transformDynamicViewToTableCells(previewResult);
    }

    if (!syncTables.includes(effectiveTable) && !syncTables.includes(previewResult.table)) {
      return createEmptyResult(extractSql(previewResult));
    }

    if (previewResult.op === 'insert') {
      return this.handlerRegistry.handleInsertOperation(previewResult, this.handlerContext);
    }

    return this.handlerRegistry.convertPreviewResult(previewResult, this.handlerContext);
  }

  private async handleMultiOperation(previewResult: PreviewResult): Promise<EditPlannerPreviewResult> {
    const allTasks: TaskRow[] = [];
    const allTasksToDelete: TaskRow[] = [];
    const allHeadings: HeadingRow[] = [];
    const allHeadingsToDelete: HeadingRow[] = [];
    const allListItems: ListItemRow[] = [];
    const allListItemsToDelete: ListItemRow[] = [];
    const allFilesToCreate: Array<{ path: string; content: string }> = [];
    const allFilesToDelete: string[] = [];

    const changedCellMap = new Map<string, TableCellRow>();
    const affectedTables = new Set<string>();
    const newRowsByTable = new Map<string, TableCellRow[]>();

    const tableCellHandler = this.handlerRegistry.getTableCellHandler();

    for (const result of previewResult.multiResults!) {
      if (result.table === 'table_cells') {
        for (const row of result.after) {
          const cell = tableCellHandler.convertToTableCellRow(row);
          const key = createCellKey(cell.path, cell.table_index, cell.row_index, cell.column_name);
          changedCellMap.set(key, cell);
          affectedTables.add(createTableKey(cell.path, cell.table_index));
        }
      }
      else if (result.table === 'table_rows' && result.op === 'insert') {
        await this.handleTableRowsInMulti(result, affectedTables, newRowsByTable);
      }
      else {
        const converted = await this.convertPreviewResult(result);
        allTasks.push(...(converted.tasksAfter || []));
        allTasksToDelete.push(...(converted.tasksToDelete || []));
        allHeadings.push(...(converted.headingsAfter || []));
        allHeadingsToDelete.push(...(converted.headingsToDelete || []));
        allListItems.push(...(converted.listItemsAfter || []));
        allListItemsToDelete.push(...(converted.listItemsToDelete || []));
        allFilesToCreate.push(...(converted.filesToCreate || []));
        allFilesToDelete.push(...(converted.filesToDelete || []));
      }
    }

    const allTableCells: TableCellRow[] = [];
    for (const tableKey of affectedTables) {
      const { path, tableIndex } = parseTableKey(tableKey);

      const existingCells = await this.database.all(
        'SELECT * FROM table_cells WHERE path = ? AND table_index = ? ORDER BY row_index, column_name',
        [path, tableIndex]
      );

      for (const row of existingCells) {
        const cell = tableCellHandler.convertToTableCellRow(row);
        const key = createCellKey(cell.path, cell.table_index, cell.row_index, cell.column_name);
        if (changedCellMap.has(key)) {
          allTableCells.push(changedCellMap.get(key)!);
        }
        else {
          allTableCells.push(cell);
        }
      }

      const newRows = newRowsByTable.get(tableKey);
      if (newRows) {
        allTableCells.push(...newRows);
      }
    }

    return {
      sqlToApply: previewResult.sqlToApply.map(sp => sp.sql),
      tasksAfter: allTasks,
      tasksToDelete: allTasksToDelete,
      headingsAfter: allHeadings,
      headingsToDelete: allHeadingsToDelete,
      tableCellsAfter: allTableCells,
      listItemsAfter: allListItems,
      listItemsToDelete: allListItemsToDelete,
      filesToCreate: allFilesToCreate.length > 0 ? allFilesToCreate : undefined,
      filesToDelete: allFilesToDelete.length > 0 ? allFilesToDelete : undefined
    };
  }

  private async handleTableRowsInMulti(result: PreviewResult, affectedTables: Set<string>, newRowsByTable: Map<string, TableCellRow[]>): Promise<void> {
    const tableLineNumbers = new Map<string, number | null>();

    for (let i = 0; i < result.after.length; i++) {
      const r = result.after[i];
      const path = r.path as string;
      const table_index = (r.table_index as number) ?? 0;
      const tableKey = createTableKey(path, table_index);
      affectedTables.add(tableKey);

      const tableLineNumber = r.table_line_number as number | null | undefined;
      if (!tableLineNumbers.has(tableKey) || (tableLineNumber != null && tableLineNumbers.get(tableKey) == null)) {
        tableLineNumbers.set(tableKey, tableLineNumber ?? null);
      }

      const existingMaxRows = await this.database.all(
        'SELECT COALESCE(MAX(row_index), -1) as max_row FROM table_cells WHERE path = ? AND table_index = ?',
        [path, table_index]
      );
      const baseRowIndex = ((existingMaxRows[0]?.max_row as number) ?? -1) + 1;
      const row_index = (r.row_index as number) ?? (baseRowIndex + i);

      const raw = r.row_json;
      let obj: Record<string, unknown> = {};
      try {
        if (typeof raw === 'string') obj = JSON.parse(raw);
        else if (typeof raw === 'object' && raw !== null) obj = raw as Record<string, unknown>;
      }
      catch (e) {
        console.warn('[VaultQuery] WriteSyncService: Failed to parse row_json in multi operation', e);
      }

      const tableCells = newRowsByTable.get(tableKey) || [];
      let isFirstCellForTable = tableCells.length === 0;
      for (const [column_name, v] of Object.entries(obj)) {
        const cell: TableCellRow = {
          path,
          table_index,
          row_index,
          column_name,
          cell_value: v == null ? '' : String(v),
          start_offset: null,
          end_offset: null,
        };

        if (isFirstCellForTable && tableLineNumbers.get(tableKey) != null) {
          cell.line_number = tableLineNumbers.get(tableKey);
          isFirstCellForTable = false;
        }
        tableCells.push(cell);
      }
      newRowsByTable.set(tableKey, tableCells);
    }
  }
}
