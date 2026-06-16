import { App, TFile, normalizePath, type TAbstractFile } from 'obsidian';
import { QueryRefreshRegistry } from '../Renderers/QueryRefreshRegistry';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { logger as rootLogger } from '../utils/logger';
import { waitForVaultQueryIndexing } from '../utils/IndexingUtils';

/** Debounce time for file modifications (ms) - balances responsiveness vs redundant indexing */
const FILE_MODIFY_DEBOUNCE_MS = 300;
/**
 * Idle delay before persisting the database after realtime index updates (ms).
 * saveToDisk() exports the entire database, so saving once per editing pause
 * instead of once per drain matters on large vaults. Crash safety is not
 * affected: an unsaved index is rebuilt incrementally from file mtimes on the
 * next start, and plugin unload still saves via api.close().
 */
const DISK_SAVE_IDLE_MS = 5000;
const logger = rootLogger.scope('Indexing');

function isVaultFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile;
}

export class IndexingStateManager {
  private indexingQueue: Set<string> = new Set();
  private removalQueue: Set<string> = new Set();
  private indexingTimeout: number | null = null;
  private diskSaveTimeout: number | null = null;
  private startupIndexingTimeout: number | null = null;
  private currentlyIndexingFiles: Set<string> = new Set();
  private fileModifyTimers: Map<string, number> = new Map();

  public constructor(private app: App, private plugin: VaultQueryPluginContext) {}

  public isIndexing(): boolean {
    return (this.plugin.api?.getIndexingStatus().isIndexing ?? false) || this.hasPendingFileModifications();
  }

  public hasPendingFileModifications(): boolean {
    return this.fileModifyTimers.size > 0 || this.indexingQueue.size > 0 || this.removalQueue.size > 0 || this.indexingTimeout !== null;
  }

  public queueIndexing(filePath: string): void {
    this.indexingQueue.add(filePath);
    this.scheduleQueueProcessing();
  }

  public queueRemoval(filePath: string): void {
    this.removalQueue.add(filePath);
    this.indexingQueue.delete(filePath);
    this.scheduleQueueProcessing();
  }

  private scheduleQueueProcessing(delayMs: number = 200): void {
    if (this.indexingTimeout) {
      window.clearTimeout(this.indexingTimeout);
    }

    this.indexingTimeout = window.setTimeout(() => {
      this.indexingTimeout = null;

      if (!this.plugin.api) return;
      void this.processIndexingQueue();
    }, delayMs);
  }

  private async processIndexingQueue(): Promise<void> {
    if (this.indexingQueue.size === 0 && this.removalQueue.size === 0) {
      return;
    }

    // A vault reindex is running; retry shortly instead of dropping the queued
    // work (deletes during a reindex would otherwise leave stale rows).
    if (this.plugin.api?.getIndexingStatus().isIndexing) {
      this.scheduleQueueProcessing(500);
      return;
    }

    const pathsToRemove = Array.from(this.removalQueue);
    this.removalQueue.clear();

    for (const pathToRemove of pathsToRemove) {
      try {
        await this.plugin.api?.removeNote(pathToRemove);
      }
      catch (error) {
        logger.error('Error removing note from index', pathToRemove, error);
      }
    }

    const filesToIndex = Array.from(this.indexingQueue);
    this.indexingQueue.clear();

    let indexedFileCount = 0;

    for (const filePath of filesToIndex) {
      if (this.currentlyIndexingFiles.has(filePath)) {
        continue;
      }

      const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
      if (file && file instanceof TFile && file.extension === 'md') {
        try {
          this.currentlyIndexingFiles.add(filePath);
          await this.indexFile(file);
          indexedFileCount++;
        }
        catch (error) {
          logger.error('Error indexing', filePath, error);
        } finally {
          this.currentlyIndexingFiles.delete(filePath);
        }
      }
    }

    if ((indexedFileCount > 0 || pathsToRemove.length > 0) && this.plugin.api) {
      this.scheduleDiskSave();

      if (this.plugin.settings.enableDynamicTableViews) {
        this.plugin.api.rebuildTableViews();
      }

      // Deliberately unscoped: a single note save rewrites rows in essentially
      // every feature table for that file (notes, properties, tasks, headings,
      // tags, ...), so intersecting refresh entries with "changed tables"
      // would match almost everything while adding view-expansion complexity
      // and false-negative risk for user views and provider tables.
      void QueryRefreshRegistry.refreshAll();
    }
  }

  /**
   * Persist the database once the editing burst goes idle, rather than after
   * every drain. saveToDisk() is a no-op in memory-storage mode.
   */
  private scheduleDiskSave(): void {
    if (this.diskSaveTimeout) {
      window.clearTimeout(this.diskSaveTimeout);
    }

    this.diskSaveTimeout = window.setTimeout(() => {
      this.diskSaveTimeout = null;
      void this.plugin.api?.saveToDisk();
    }, DISK_SAVE_IDLE_MS);
  }

  private async indexFile(file: TFile): Promise<void> {
    if (!this.plugin.api) {
      return;
    }

    try {
      await this.plugin.api.indexNote(file);
    }
    catch (error) {
      logger.error(`Failed to index file ${file.path}`, error);
    }
  }

  public queueFileModification(file: TFile): void {
    const existingTimer = this.fileModifyTimers.get(file.path);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      if (!this.plugin.api) return;
      this.queueIndexing(file.path);
      this.fileModifyTimers.delete(file.path);
    }, FILE_MODIFY_DEBOUNCE_MS);

    this.fileModifyTimers.set(file.path, timer);
  }

  public setStartupIndexingTimeout(timeout: number): void {
    this.startupIndexingTimeout = timeout;
  }

  public clearStartupIndexingTimeout(): void {
    if (this.startupIndexingTimeout) {
      window.clearTimeout(this.startupIndexingTimeout);
      this.startupIndexingTimeout = null;
    }
  }

  public isFileBeingIndexed(filePath: string): boolean {
    return this.currentlyIndexingFiles.has(filePath);
  }

  public shouldProcessFile(file: TFile): boolean {
    return !!this.plugin.api && file.extension === 'md' && this.plugin.api.shouldIndexFile(file);
  }

  public async waitForIndexingComplete(maxWaitMs: number = 5000): Promise<void> {
    await waitForVaultQueryIndexing({
      getApi: () => this.plugin.api ?? null,
      hasPendingFileModifications: () => this.hasPendingFileModifications(),
      timeoutMs: maxWaitMs,
      onPendingTimeout: () => logger.warn('Timed out waiting for pending modifications'),
    });
  }

  public setupFileWatchers(): void {
    if (this.plugin.settings.indexingInterval !== 'realtime') {
      return;
    }

    this.plugin.registerEvent(this.app.vault.on('create', (file) => { if (isVaultFile(file)) this.handleFileCreate(file); }));
    this.plugin.registerEvent(this.app.vault.on('modify', (file) => { if (isVaultFile(file)) this.handleFileModify(file); }));
    this.plugin.registerEvent(this.app.vault.on('delete', (file) => { if (isVaultFile(file)) this.handleFileDelete(file); }));
    this.plugin.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (isVaultFile(file)) this.handleFileRename(file, oldPath); }));
  }

  // Events that arrive while a vault reindex is running are queued, not
  // dropped: processIndexingQueue defers itself until indexing is idle.
  private handleFileCreate(file: TFile): void {
    if (this.shouldProcessFile(file)) {
      this.queueIndexing(file.path);
    }
  }

  private handleFileModify(file: TFile): void {
    if (!this.shouldProcessFile(file)) {
      return;
    }

    this.queueFileModification(file);
  }

  private handleFileDelete(file: TFile): void {
    if (file.extension === 'md') {
      this.queueRemoval(file.path);
    }
  }

  private handleFileRename(file: TFile, oldPath: string): void {
    if (file.extension === 'md') {
      this.queueRemoval(oldPath);
      if (this.plugin.api?.shouldIndexFile(file)) {
        this.queueIndexing(file.path);
      }
    }
  }

  public cleanup(): void {
    if (this.indexingTimeout) {
      window.clearTimeout(this.indexingTimeout);
      this.indexingTimeout = null;
    }

    // No flush needed: plugin unload saves via api.close().
    if (this.diskSaveTimeout) {
      window.clearTimeout(this.diskSaveTimeout);
      this.diskSaveTimeout = null;
    }

    this.clearStartupIndexingTimeout();

    for (const timer of this.fileModifyTimers.values()) {
      window.clearTimeout(timer);
    }
    this.fileModifyTimers.clear();

    this.indexingQueue.clear();
    this.removalQueue.clear();

    this.currentlyIndexingFiles.clear();
  }
}
