import { App, TFile, Notice, normalizePath } from 'obsidian';
import { VaultDatabase } from '../Database/DatabaseService';
import { WorkerDatabase } from '../Database/WorkerDatabaseService';
import { VaultQuerySettings } from '../Settings/Settings';
import { getErrorMessage, ERROR_MESSAGES, INFO_MESSAGES } from '../utils/ErrorMessages';
import { ObsidianEditApplier } from '../WriteSync/ObsidianEditApplier';
import { createDirectlyApplicableIntents } from '../WriteSync/ObsidianEditIntentFactory';
import { expandListItemViewDeletesAsync } from '../WriteSync/ListItemDescendants';
import { transformDynamicViewToTableCells, transformDynamicViewToTableRows } from '../WriteSync/DynamicTableViewTransform';
import { logger as rootLogger } from '../utils/logger';

import type { PreviewResult } from './PreviewService';

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
    return await expandListItemViewDeletesAsync(rows, this.queryDatabase.bind(this));
  }

  public async syncChanges(previewResult: PreviewResult): Promise<string[]> {
    try {
      const directPreviewResult = this.normalizeDirectPreviewResult(previewResult);
      const creationResult = await createDirectlyApplicableIntents(
        directPreviewResult,
        this.settings.allowDeleteNotes,
        this.queryListItemDescendants.bind(this),
        this.queryDatabase.bind(this),
        this.readFileContent.bind(this)
      );

      if (!creationResult) {
        throw new WriteOperationError(`Unsupported write target: ${previewResult.table}`, 'syncChanges');
      }

      const { affectedPaths, warnings: applyWarnings } = await this.intentApplier.applyIntents(creationResult.intents);
      const warnings = [...creationResult.warnings, ...applyWarnings];
      if (warnings.length > 0) {
        logger.warn('Write sync skipped changes', warnings);
      }

      this.showSyncNotice(affectedPaths.length, warnings.length);
      return affectedPaths;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.error('WriteSyncService error', message);

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

  private showSyncNotice(updatedFileCount: number, skippedChangeCount: number): void {
    const parts: string[] = [];
    if (updatedFileCount > 0) {
      parts.push(INFO_MESSAGES.FILES_UPDATED(updatedFileCount));
    }
    if (skippedChangeCount > 0) {
      parts.push(INFO_MESSAGES.CHANGES_SKIPPED(skippedChangeCount));
    }
    if (parts.length > 0) {
      new Notice('VaultQuery: ' + parts.join('; '), skippedChangeCount > 0 ? 8000 : 3000);
    }
  }

  private normalizeDirectPreviewResult(previewResult: PreviewResult): PreviewResult {
    if (previewResult.op === 'multi') {
      return {
        ...previewResult,
        multiResults: previewResult.multiResults?.map(result => this.normalizeDirectPreviewResult(result))
      };
    }

    if (!previewResult.table.endsWith('_table')) {
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
      logger.warn(`Could not read file ${path}: ${getErrorMessage(error)}`);
      return null;
    }
  }
}
