import { App, TFile, Notice, normalizePath } from 'obsidian';
import { VaultDatabase } from '../Database/DatabaseService';
import { WorkerDatabase } from '../Database/WorkerDatabaseService';
import { VaultQuerySettings } from '../Settings/Settings';
import { getErrorMessage, ERROR_MESSAGES, WARNING_MESSAGES, INFO_MESSAGES, CONSOLE_ERRORS } from '../utils/ErrorMessages';
import type { PreviewResult } from '../WriteSync';
import { ObsidianEditApplier } from '../WriteSync/ObsidianEditApplier';
import { createDirectlyApplicableIntents } from '../WriteSync/ObsidianEditIntentFactory';
import { expandListItemViewDeletes } from '../WriteSync/ListItemDescendants';
import { transformDynamicViewToTableCells, transformDynamicViewToTableRows } from '../WriteSync/DynamicTableViewTransform';
import { logger as rootLogger } from '../utils/logger';

import type { PreviewResult as ServicePreviewResult } from './PreviewService';

const logger = rootLogger.scope('WriteSync');

class WriteOperationError extends Error {
  public constructor(message: string, public readonly operation: string, public readonly filePath?: string, public readonly cause?: Error) {
    super(message);
    this.name = 'WriteOperationError';
  }
}

export class WriteSyncService {
  private intentApplier: ObsidianEditApplier;

  public constructor(private app: App, private database: VaultDatabase | WorkerDatabase, private settings: VaultQuerySettings) {
    this.intentApplier = new ObsidianEditApplier(this.app, this.queryListItemsByListIndex.bind(this));
  }

  public setDatabase(database: VaultDatabase | WorkerDatabase): void {
    this.database = database;
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

  private async queryListItemDescendants(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    return await expandListItemViewDeletes(rows, this.queryDatabase.bind(this));
  }

  public async syncChanges(previewResult: ServicePreviewResult): Promise<string[]> {
    try {
      const directPreviewResult = this.normalizeDirectPreviewResult(previewResult);
      const directIntents = await createDirectlyApplicableIntents(
        directPreviewResult,
        this.settings.allowDeleteNotes,
        this.queryListItemDescendants.bind(this),
        this.queryDatabase.bind(this),
        this.readFileContent.bind(this)
      );

      if (!directIntents) {
        throw new WriteOperationError(`Unsupported write target: ${previewResult.table}`, 'syncChanges');
      }

      const affectedPaths = await this.intentApplier.applyIntents(directIntents);
      if (affectedPaths.length > 0) {
        new Notice("VaultQuery: " + INFO_MESSAGES.FILES_UPDATED(affectedPaths.length), 3000);
      }
      return affectedPaths;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.error(CONSOLE_ERRORS.WRITE_SYNC_ERROR, message);

      const contextualError = error instanceof WriteOperationError
        ? error
        : new WriteOperationError(
          ERROR_MESSAGES.WRITE_SYNC_FAILED(message),
          'syncChanges',
          undefined,
          error instanceof Error ? error : undefined
        );

      const noticeMessage = INFO_MESSAGES.SYNC_FAILED(contextualError.message);
      logger.error('Write sync notice', noticeMessage);
      new Notice(noticeMessage, 8000);
      throw contextualError;
    }
  }

  private normalizeDirectPreviewResult(previewResult: PreviewResult): PreviewResult {
    if (previewResult.op === 'multi') {
      return {
        ...previewResult,
        multiResults: previewResult.multiResults?.map(result => this.normalizeDirectPreviewResult(result))
      };
    }

    const syncTables = ['notes', 'properties', 'tasks', 'table_cells', 'headings', 'table_rows', 'headings_view', 'list_items', 'list_items_view', 'tags', 'links'];
    const isDynamicTableView = previewResult.table.endsWith('_table') && !syncTables.includes(previewResult.table);
    if (!isDynamicTableView) {
      return previewResult;
    }

    return previewResult.op === 'insert'
      ? transformDynamicViewToTableRows(previewResult)
      : transformDynamicViewToTableCells(previewResult);
  }

  private async readFileContent(path: string): Promise<string | null> {
    try {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(file instanceof TFile)) {
        throw new Error(ERROR_MESSAGES.FILE_NOT_FOUND(path));
      }
      return await this.app.vault.read(file);
    }
    catch (error: unknown) {
      logger.warn(WARNING_MESSAGES.FILE_READ_FAILED(path, getErrorMessage(error)));
      return null;
    }
  }
}
