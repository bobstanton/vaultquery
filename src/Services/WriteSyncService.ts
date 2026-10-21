import { App, Notice, normalizePath } from 'obsidian';
import { VaultDatabase } from '../Database/DatabaseService';
import { WorkerDatabase } from '../Database/WorkerDatabaseService';
import { getErrorMessage, ERROR_MESSAGES, INFO_MESSAGES } from '../utils/ErrorMessages';
import { ObsidianEditApplier } from '../WriteSync/ObsidianEditApplier';
import { FilePreviewStaleError, FileWriteApplyError } from '../WriteSync/FileWriteTypes';
import { readTextFileSource } from '../WriteSync/FileWriteOperations';
import type { TextFileSource } from '../WriteSync/FileWriteOperations';
import type { IntentCreationResult } from '../WriteSync/ObsidianEditIntentFactory';
import { createDirectlyApplicableIntents, NOTE_DELETION_DISABLED } from '../WriteSync/ObsidianEditIntentFactory';
import { expandListItemViewDeletesAsync } from '../WriteSync/ListItemDescendants';
import { transformDynamicViewToTableCells, transformDynamicViewToTableRows } from '../WriteSync/DynamicTableViewTransform';
import { logger as rootLogger } from '../utils/logger';
import type { VaultQuerySettings } from '../Settings/Settings';

import type { PreviewResult } from './PreviewService';

const logger = rootLogger.scope('WriteSync');

class WriteOperationError extends Error {
  public constructor(message: string, public readonly operation: string, public readonly filePath?: string, public readonly cause?: Error) {
    super(message);
    this.name = 'WriteOperationError';
  }
}

export interface PreparedMarkdownChanges extends IntentCreationResult {
  sources: Map<string, TextFileSource>;
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

  public async prepareChanges(previewResult: PreviewResult): Promise<PreparedMarkdownChanges> {
    const sources = new Map<string, TextFileSource>();

    const capture = async (path: string, frontmatterOnly = false): Promise<string | null> => {
      path = normalizePath(path);

      if (!sources.has(path)) {
        const source = await readTextFileSource(this.app.vault, path, frontmatterOnly);
        sources.set(path, source);
      }

      return sources.get(path)!.content;
    };

    const result = await createDirectlyApplicableIntents(this.app, this.normalizeDirectPreviewResult(previewResult), this.settings.allowDeleteNotes,
      this.queryListItemDescendants.bind(this), this.queryDatabase.bind(this), capture);

    if (!result) throw new WriteOperationError(`Unsupported write target: ${previewResult.table}`, 'preview');

    const bodyPaths = new Set(result.intents.filter(intent => intent.type !== 'setProperty' && intent.type !== 'deleteProperty')
      .map(intent => normalizePath('location' in intent ? intent.location.path : intent.path)));

    for (const intent of result.intents) {
      const path = normalizePath('location' in intent ? intent.location.path : intent.path);
      await capture(path, !bodyPaths.has(path));

      if (intent.type === 'createNote' ? sources.get(path)!.file !== null : sources.get(path)!.file === null
        && !result.intents.some(item => item.type === 'createNote' && normalizePath(item.path) === path)) {
        throw new FilePreviewStaleError(`File creation or deletion conflicts with the preview: ${path}`);
      }
    }

    return { ...result, sources };
  }

  public async syncChanges(creationResult: PreparedMarkdownChanges, assertAccess: () => void): Promise<string[]> {
    // The setting may have been turned off between preview and apply.
    if (!this.settings.allowDeleteNotes && creationResult.intents.some(intent => intent.type === 'deleteNote')) {
      throw new WriteOperationError(NOTE_DELETION_DISABLED, 'syncChanges');
    }

    try {
      const { affectedPaths, warnings: applyWarnings } = await this.intentApplier.applyIntents(creationResult.intents, creationResult.sources, assertAccess);
      const warnings = [...creationResult.warnings, ...applyWarnings];

      if (warnings.length > 0) {
        logger.warn('Write sync skipped changes', warnings);
      }

      this.showSyncNotice(affectedPaths.length, warnings.length);

      return affectedPaths;
    } catch (error: unknown) {
      if (error instanceof FilePreviewStaleError || error instanceof FileWriteApplyError) throw error;
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
}
