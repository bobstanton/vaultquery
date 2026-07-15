import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { TAbstractFile } from 'obsidian';
import { QueryRefreshRegistry } from '../Renderers/QueryRefreshRegistry';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { logger as rootLogger } from '../utils/logger';
import { escapeSqlString } from '../utils/SqlIdentifierUtils';

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

function stringColumn(row: unknown, column: string): string {
  const value = (row as Record<string, unknown>)[column];
  return typeof value === 'string' ? value : '';
}

export class IndexingStateManager {
  private indexingQueue: Set<string> = new Set();
  private removalQueue: Set<string> = new Set();
  private indexingTimeout: number | null = null;
  private diskSaveTimeout: number | null = null;
  private linkResolutionTimeout: number | null = null;
  private startupIndexingTimeout: number | null = null;
  private currentlyIndexingFiles: Set<string> = new Set();
  private newlyAvailableLinkTargets: Set<string> = new Set();
  private drainInProgress = false;
  private idleWaiters: Array<() => void> = [];

  public constructor(private app: App, private plugin: VaultQueryPluginContext) {}

  public isIndexing(): boolean {
    return (this.plugin.api?.getIndexingStatus().isIndexing ?? false) || this.hasPendingFileModifications();
  }

  public hasPendingFileModifications(): boolean {
    return this.indexingQueue.size > 0 || this.removalQueue.size > 0 || this.indexingTimeout !== null || this.drainInProgress;
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
      this.notifyIfPipelineIdle();
      return;
    }

    // A vault reindex is running; retry shortly instead of dropping the queued
    // work (deletes during a reindex would otherwise leave stale rows).
    if (this.plugin.api?.getIndexingStatus().isIndexing) {
      this.scheduleQueueProcessing(500);
      return;
    }

    if (this.drainInProgress) {
      this.scheduleQueueProcessing(200);
      return;
    }

    this.drainInProgress = true;
    try {
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
        if (file instanceof TFile && file.extension === 'md') {
          try {
            if (!(await this.plugin.api?.needsIndexing(file))) {
              continue;
            }
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
        QueryRefreshRegistry.scheduleAutoRefresh();
      }
    } finally {
      this.drainInProgress = false;
      this.notifyIfPipelineIdle();
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
    await this.plugin.api?.indexNote(file);
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
    const startedAt = Date.now();
    await this.waitForPipelineIdle(maxWaitMs);

    const remaining = maxWaitMs - (Date.now() - startedAt);
    if (remaining > 0) {
      await this.plugin.api?.waitForIndexing(remaining);
    }
  }

  private waitForPipelineIdle(timeoutMs: number): Promise<void> {
    if (!this.hasPendingFileModifications()) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let timeoutId: number | null = null;

      const waiter = (): void => {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        resolve();
      };

      this.idleWaiters.push(waiter);
      timeoutId = window.setTimeout(() => {
        const index = this.idleWaiters.indexOf(waiter);
        if (index !== -1) {
          this.idleWaiters.splice(index, 1);
        }
        logger.warn('Timed out waiting for pending modifications');
        resolve();
      }, timeoutMs);
    });
  }

  private notifyIfPipelineIdle(): void {
    if (this.idleWaiters.length === 0 || this.hasPendingFileModifications()) {
      return;
    }

    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  public setupFileWatchers(): void {
    if (this.plugin.settings.indexingInterval !== 'realtime') {
      return;
    }

    this.plugin.registerEvent(this.app.metadataCache.on('changed', (file) => this.handleFileChanged(file)));
    this.plugin.registerEvent(this.app.metadataCache.on('resolved', () => this.queueNewlyResolvableSources()));
    this.plugin.registerEvent(this.app.vault.on('create', (file) => {
      if (isVaultFile(file) && file.extension === 'md') {
        this.newlyAvailableLinkTargets.add(file.path);
        this.scheduleLinkResolutionCheck();
      }
    }));
    this.plugin.registerEvent(this.app.vault.on('delete', (file) => {
      if (isVaultFile(file)) this.handleFileDelete(file);
      else if (file instanceof TFolder) this.handleFolderDelete(file);
    }));
    this.plugin.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (isVaultFile(file)) this.handleFileRename(file, oldPath); }));
  }

  // Events that arrive while a vault reindex is running are queued, not
  // dropped: processIndexingQueue defers itself until indexing is idle.
  private handleFileChanged(file: TFile): void {
    if (this.shouldProcessFile(file)) {
      this.queueIndexing(file.path);
    }
  }

  private handleFileDelete(file: TFile): void {
    if (file.extension === 'md') {
      this.queueRemoval(file.path);
      this.queueSourcesLinkingTo(file.path);
    }
  }

  private handleFolderDelete(folder: TFolder): void {
    if (!this.plugin.api) {
      return;
    }

    const prefix = `${folder.path}/`;
    const escaped = escapeSqlString(prefix.replace(/([\\%_])/g, '\\$1'));
    void this.plugin.api.query(`SELECT path FROM notes WHERE path LIKE '${escaped}%' ESCAPE '\\'`)
      .then(rows => {
        for (const row of rows) {
          const path = stringColumn(row, 'path');
          if (path) {
            this.queueRemoval(path);
            this.queueSourcesLinkingTo(path);
          }
        }
      })
      .catch((error: unknown) => logger.error('Folder delete cleanup failed', { folder: folder.path, error }));
  }

  private handleFileRename(file: TFile, oldPath: string): void {
    if (file.extension === 'md') {
      this.newlyAvailableLinkTargets.add(file.path);
      this.scheduleLinkResolutionCheck();
      this.queueRemoval(oldPath);
      if (this.plugin.api?.shouldIndexFile(file)) {
        this.queueIndexing(file.path);
      }
      this.queueSourcesLinkingTo(oldPath);
    }
  }

  private queueNewlyResolvableSources(): void {
    if (!this.plugin.settings.enabledFeatures.indexLinks || this.newlyAvailableLinkTargets.size === 0) {
      return;
    }

    const targets = new Set(this.newlyAvailableLinkTargets);
    this.newlyAvailableLinkTargets.clear();
    const affected = new Set<string>();

    for (const [source, destinations] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      for (const target of targets) {
        if (destinations[target]) {
          affected.add(source);
          break;
        }
      }
    }

    for (const source of affected) {
      this.queueIndexing(source);
    }
  }

  private scheduleLinkResolutionCheck(): void {
    if (this.linkResolutionTimeout !== null) {
      window.clearTimeout(this.linkResolutionTimeout);
    }
    this.linkResolutionTimeout = window.setTimeout(() => {
      this.linkResolutionTimeout = null;
      this.queueNewlyResolvableSources();
    }, 1000);
  }

  private queueSourcesLinkingTo(oldPath: string): void {
    if (!this.plugin.settings.enabledFeatures.indexLinks || !this.plugin.api) {
      return;
    }

    const escaped = escapeSqlString(oldPath);
    void this.plugin.api.query(`SELECT DISTINCT path FROM links WHERE link_target_path = '${escaped}'`)
      .then(rows => {
        for (const row of rows) {
          const source = stringColumn(row, 'path');
          if (source && source !== oldPath) {
            this.queueIndexing(source);
          }
        }
      })
      .catch((error: unknown) => logger.debug('Stale link-target check failed', { oldPath, error }));
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

    if (this.linkResolutionTimeout !== null) {
      window.clearTimeout(this.linkResolutionTimeout);
      this.linkResolutionTimeout = null;
    }

    this.clearStartupIndexingTimeout();

    this.indexingQueue.clear();
    this.removalQueue.clear();

    this.currentlyIndexingFiles.clear();
    this.newlyAvailableLinkTargets.clear();
    this.notifyIfPipelineIdle();
  }
}
