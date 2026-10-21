import { isDataFilePath } from '../Tabular/TabularTableOwnership';
import { App, TFile, TFolder, Vault, normalizePath } from 'obsidian';
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
 * next start. Plugin unload starts a best-effort save via api.close().
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
  private newlyAvailableLinkTargets: Set<string> = new Set();
  private staleLinkTargets: Set<string> = new Set();
  private drainInProgress = false;
  private disposed = false;
  private watchersRegistered = false;
  private idleWaiters: Array<() => void> = [];

  public constructor(private app: App, private plugin: VaultQueryPluginContext) {}

  public isIndexing(): boolean {
    return (this.plugin.api?.getIndexingStatus().isIndexing ?? false) || this.hasPendingFileModifications();
  }

  public hasPendingFileModifications(): boolean {
    return !this.disposed && (this.indexingQueue.size > 0
      || this.removalQueue.size > 0
      || this.staleLinkTargets.size > 0
      || this.indexingTimeout !== null
      || this.drainInProgress);
  }

  private invalidateSource(path: string): void {
    this.plugin.api?.invalidateFileSnapshots(path);
    if (isDataFilePath(path)) this.plugin.api?.invalidateDataFile(path, () => this.waitForIndexingComplete());
    else if (/\.md$/.test(path)) this.plugin.api?.invalidateProviderDefinitions(path);
  }

  public queueIndexing(filePath: string): void {
    if (this.disposed) return;
    this.invalidateSource(filePath);
    this.removalQueue.delete(filePath);
    this.indexingQueue.add(filePath);
    this.scheduleQueueProcessing();
  }

  public queueRemoval(filePath: string): void {
    if (this.disposed) return;
    this.invalidateSource(filePath);
    this.removalQueue.add(filePath);
    this.indexingQueue.delete(filePath);
    this.scheduleQueueProcessing();
  }

  private scheduleQueueProcessing(delayMs: number = 200): void {
    if (this.disposed) return;
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
    if (this.disposed) return;
    if (this.indexingQueue.size === 0 && this.removalQueue.size === 0 && this.staleLinkTargets.size === 0) {
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
      await this.queueSourcesLinkingToPendingTargets();
      if (this.disposed) return;

      const pathsToRemove = Array.from(this.removalQueue);
      this.removalQueue.clear();

      const filesToIndex = Array.from(this.indexingQueue);
      this.indexingQueue.clear();

      const candidateFiles: TFile[] = [];

      for (const filePath of filesToIndex) {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));

        if (file instanceof TFile && (file.extension === 'md' || isDataFilePath(file.path) || this.plugin.api?.shouldIndexOtherFile(file.path)
          || this.plugin.api?.shouldIndexImage(file.path))) {
          candidateFiles.push(file);
        }
      }

      let filesIndexed = 0;
      let filesRemoved = 0;

      try {
        const candidates = new Set(candidateFiles.map(file => file.path));
        const result = await this.plugin.api?.processRealtimeIndexBatch(pathsToRemove.filter(path => !candidates.has(path)), candidateFiles, true);
        if (this.disposed) return;
        filesIndexed = result?.filesIndexed ?? 0;
        filesRemoved = result?.filesRemoved ?? 0;

        for (const path of result?.failedPaths ?? []) {
          this.indexingQueue.add(path);
        }

        for (const path of result?.failedRemovalPaths ?? []) {
          this.removalQueue.add(path);
        }

        if (result?.failedPaths.length || result?.failedRemovalPaths.length) {
          this.scheduleQueueProcessing(5000);
        }
      }
      catch (error) {
        if (this.disposed) return;
        for (const path of filesToIndex) {
          this.indexingQueue.add(path);
        }

        for (const path of pathsToRemove) {
          this.removalQueue.add(path);
        }

        this.scheduleQueueProcessing(5000);
        this.scheduleDiskSave();
        QueryRefreshRegistry.scheduleAutoRefresh();

        logger.error('Error processing realtime index batch', {
          candidates: candidateFiles.length,
          removals: pathsToRemove.length,
          error,
        });
      }
      if ((filesIndexed > 0 || filesRemoved > 0) && this.plugin.api) {
        this.scheduleDiskSave();

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
    if (this.disposed) return;
    if (this.diskSaveTimeout) {
      window.clearTimeout(this.diskSaveTimeout);
    }

    this.diskSaveTimeout = window.setTimeout(() => {
      this.diskSaveTimeout = null;
      void this.plugin.api?.saveToDisk();
    }, DISK_SAVE_IDLE_MS);
  }

  public setStartupIndexingTimeout(timeout: number): void {
    if (this.disposed) window.clearTimeout(timeout);
    else this.startupIndexingTimeout = timeout;
  }

  public clearStartupIndexingTimeout(): void {
    if (this.startupIndexingTimeout) {
      window.clearTimeout(this.startupIndexingTimeout);
      this.startupIndexingTimeout = null;
    }
  }

  public shouldProcessFile(file: TFile): boolean {
    return !!this.plugin.api && (this.plugin.api.shouldIndexOtherFile(file.path) || this.plugin.api.shouldIndexImage(file.path)
      || ((file.extension === 'md' || isDataFilePath(file.path)) && this.plugin.api.shouldIndexFile(file)));
  }

  public async waitForIndexingComplete(maxWaitMs: number = 5000): Promise<void> {
    const startedAt = Date.now();
    await this.waitForPipelineIdle(maxWaitMs);

    const remaining = maxWaitMs - (Date.now() - startedAt);

    if (!this.disposed && (this.plugin.settings.indexingInterval !== 'manual' || this.plugin.api?.getIndexingStatus().isIndexing)) {
      await this.plugin.api?.waitForIndexing(Math.max(0, remaining));
    }
  }

  private waitForPipelineIdle(timeoutMs: number): Promise<void> {
    if (!this.hasPendingFileModifications()) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
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

        reject(new Error('Timed out waiting for pending modifications'));
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

  private get realtime(): boolean {
    return !this.disposed && this.plugin.settings.indexingInterval === 'realtime';
  }

  public setupFileWatchers(): void {
    if (this.disposed || this.watchersRegistered) return;
    this.watchersRegistered = true;

    this.plugin.registerEvent(this.app.vault.on('modify', file => {
      if (this.disposed) return;
      if (this.realtime && isVaultFile(file) && file.extension !== 'md' && this.shouldProcessFile(file)) this.queueIndexing(file.path);
      else if (this.realtime) this.invalidateSource(file.path);
      else this.plugin.api?.invalidateFileSnapshots(file.path);
    }));

    this.plugin.registerEvent(this.app.vault.on('delete', file => {
      if (this.disposed) return;
      if (!this.realtime) this.plugin.api?.invalidateFileSnapshots(file.path, file instanceof TFolder);
      else if (isVaultFile(file)) this.removeSource(file.path);
      else if (file instanceof TFolder) this.handleFolderDelete(file);
    }));

    this.plugin.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.disposed) return;
      if (!this.realtime) this.plugin.api?.invalidateFileSnapshots(oldPath, file instanceof TFolder);
      else if (isVaultFile(file)) this.handleFileRename(file, oldPath);
      else if (file instanceof TFolder) this.handleFolderRename(file, oldPath);
    }));

    this.plugin.registerEvent(this.app.metadataCache.on('changed', file => {
      if (this.realtime) this.handleFileChanged(file);
    }));
    this.plugin.registerEvent(this.app.metadataCache.on('resolved', () => {
      if (this.realtime) this.queueNewlyResolvableSources();
    }));

    this.plugin.registerEvent(this.app.vault.on('create', file => {
      if (!this.realtime || !isVaultFile(file)) return;
      if (file.extension !== 'md') this.handleFileChanged(file);
      else this.markLinkTargetAvailable(file.path);
    }));
  }

  private handleFileChanged(file: TFile): void {
    if (this.shouldProcessFile(file)) this.queueIndexing(file.path);
  }

  private removeSource(path: string): void {
    const markdown = /\.md$/.test(path);

    if (markdown || isDataFilePath(path) || this.plugin.api?.hasOtherFileIndexEntry(path) || this.plugin.api?.hasImageIndexEntry(path)) {
      this.queueRemoval(path);
    }
    else this.plugin.api?.invalidateFileSnapshots(path);

    if (markdown) this.queueSourcesLinkingTo(path);
  }

  private markLinkTargetAvailable(path: string): void {
    this.newlyAvailableLinkTargets.add(path);
    this.scheduleLinkResolutionCheck();
  }

  private handleFileRename(file: TFile, oldPath: string, relocate = true): void {
    const eligible = this.shouldProcessFile(file);

    if (file.extension === 'md') {
      this.markLinkTargetAvailable(file.path);
      if (!/\.md$/.test(oldPath)) this.queueSourcesLinkingTo(oldPath);
      if (relocate && this.plugin.api?.shouldIndexFile(file)) this.plugin.api.renameProviderDefinitions(oldPath, file.path);
    }

    this.removeSource(oldPath);
    if (eligible) this.queueIndexing(file.path);
  }

  private handleFolderDelete(folder: TFolder): void {
    if (!this.plugin.api) return;
    const paths = this.plugin.api.getIndexedDataPaths(folder.path);

    for (const path of paths) {
      this.removeSource(path);
    }

    const prefix = `${folder.path}/`;
    const escaped = escapeSqlString(prefix.replace(/([\\%_])/g, '\\$1'));

    void this.plugin.api.query(`SELECT path FROM notes WHERE path LIKE '${escaped}%' ESCAPE '\\'`)
      .then(rows => {
        if (this.disposed) return;
        for (const row of rows) {
          const path = stringColumn(row, 'path');
          if (path && !paths.has(path)) { paths.add(path); this.removeSource(path); }
        }
      })
      .catch((error: unknown) => logger.error('Folder delete cleanup failed', { folder: folder.path, error }));
  }

  private handleFolderRename(folder: TFolder, oldPath: string): void {
    const paths = this.plugin.api?.getIndexedDataPaths(oldPath) ?? new Set<string>();

    for (const path of this.plugin.api?.renameProviderDefinitions(oldPath, folder.path) ?? []) {
      paths.add(path);
    }

    Vault.recurseChildren(folder, file => {
      if (!(file instanceof TFile)) return;
      const previous = oldPath + file.path.slice(folder.path.length);
      paths.delete(previous);
      this.handleFileRename(file, previous, false);
    });

    for (const path of paths) {
      this.removeSource(path);
    }
  }

  private queueNewlyResolvableSources(): void {
    if (!this.realtime || !this.plugin.settings.enabledFeatures.indexLinks || this.newlyAvailableLinkTargets.size === 0) {
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
    if (this.disposed) return;
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

    this.staleLinkTargets.add(oldPath);
    this.scheduleQueueProcessing();
  }

  private async queueSourcesLinkingToPendingTargets(): Promise<void> {
    if (!this.plugin.settings.enabledFeatures.indexLinks || !this.plugin.api || this.staleLinkTargets.size === 0) {
      this.staleLinkTargets.clear();

      return;
    }

    const targets = Array.from(this.staleLinkTargets);
    this.staleLinkTargets.clear();
    const targetSet = new Set(targets);
    const affectedSources = new Set<string>();
    const chunkSize = 400;

    for (let index = 0; index < targets.length; index += chunkSize) {
      const chunk = targets.slice(index, index + chunkSize);
      const targetList = chunk.map(path => `'${escapeSqlString(path)}'`).join(',');

      try {
        const rows = await this.plugin.api.query(`SELECT DISTINCT path FROM links WHERE link_target_path IN (${targetList})`);
        if (this.disposed) return;

        for (const row of rows) {
          const source = stringColumn(row, 'path');

          if (source && !targetSet.has(source)) {
            affectedSources.add(source);
          }
        }
      }
      catch (error) {
        logger.debug('Stale link-target batch check failed', { targets: chunk.length, error });
      }
    }

    if (this.disposed) return;

    for (const source of affectedSources) {
      this.indexingQueue.add(source);
    }

    logger.debug('Stale link-target batch checked', {
      targets: targets.length,
      affectedSources: affectedSources.size,
    });
  }

  public cleanup(): void {
    this.disposed = true;
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

    this.newlyAvailableLinkTargets.clear();
    this.staleLinkTargets.clear();
    this.notifyIfPipelineIdle();
  }
}
