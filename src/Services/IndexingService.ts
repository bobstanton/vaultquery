import { PathExclusions } from '../utils/PathExclusions';
import { mapWithConcurrency } from '../utils/Concurrent';
import { App, TFile, CachedMetadata, HeadingCache, LinkCache, TagCache, ListItemCache, BlockCache, ReferenceCache, type Pos, normalizePath, getFrontMatterInfo, parseYaml } from 'obsidian';
import { VaultDatabase } from '../Database/DatabaseService';
import { WorkerDatabase } from '../Database/WorkerDatabaseService';
import { VaultQuerySettings } from '../Settings/Settings';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import { ContentLocationService } from './ContentLocationService';
import { PerformanceMonitor } from './PerformanceMonitor';
import type { FilePreparationTiming } from './PerformanceMonitor';
import { ERROR_MESSAGES } from '../utils/ErrorMessages';
import { getIndexedFilesFromDatabase } from '../Database/IndexedFiles';
import { INDEXING_SQL } from '../Database/IndexingQueries';
import { extractTaskMetadata } from '../utils/TaskMetadataParser';
import { extractAllCodeBlocks, parseSQLObjectName, parseFunctionName } from '../utils/SQLParsingUtils';
import { logger as rootLogger } from '../utils/logger';
import type { IndexNoteData, NoteRecord, IndexingStats, IndexingProgress, IndexingStatus, TableCellData, TaskData, ListItemData, UserViewData, UserFunctionData, UserTriggerData } from '../types';

const logger = rootLogger.scope('Indexing');

/** Sticky regex to measure a whitespace run without copying the string. */
const WHITESPACE_RUN = /\s*/y;

interface IndexingEventEmitter {
  emitFileIndexed: (path: string, isUpdate: boolean) => void;
  emitFileRemoved: (path: string) => void;
  emitVaultIndexed: (filesIndexed: number, filesRemoved: number, isForced: boolean) => void;
  onBeforeVaultIndexed?: (force: boolean) => Promise<void>;
}

interface ProviderDefinitionBlockHandler {
  hasProviderDefinitionDiscovery(): boolean;
  setRefreshDeferred(deferred: boolean): void;
  refreshStaleDefinitions(): Promise<void>;
  indexProviderDefinitionBlocks(path: string, content: string): Promise<void>;
  removeProviderDefinitionBlocks(path: string): void;
  clearProviderDefinitionBlocks(): void;
}

export interface RealtimeIndexBatchResult {
  filesIndexed: number;
  filesRemoved: number;
  failedPaths: string[];
  failedRemovalPaths: string[];
  unavailablePaths?: string[];
}

export class IndexingService {
  private performanceMonitor: PerformanceMonitor;
  private static reindexSequence = 0;

  private indexingProgress: IndexingProgress = { current: 0, total: 0, currentFile: '' };
  private isIndexing = false;
  /** Reindexes and realtime batches can overlap; the status clears only when the last one ends. */
  private activeIndexing = 0;
  private refreshDeferrals = 0;
  private realtimePropertiesRebuildPending = false;
  private readonly indexingListeners = new Set<() => void>();

  private readonly BATCH_SIZE_FILES = 200;
  /** Maximum total file size per batch (10MB) - prevents memory issues with large files */
  private readonly BATCH_SIZE_BYTES = 10 * 1024 * 1024;
  private readonly PREPARE_CONCURRENCY = 24;
  private exclusions = new PathExclusions();

  private eventEmitter: IndexingEventEmitter | null = null;
  private providerDefinitionBlockHandler: ProviderDefinitionBlockHandler | null = null;

  // After initial indexing completes, we don't need to extract views/functions/triggers
  // from file content anymore - they're only registered when code blocks render.
  // Also used by waitForIndexing() to wait for first indexing on startup.
  private initialIndexingComplete = false;

  public constructor(private app: App, private database: VaultDatabase | WorkerDatabase, private settings: VaultQuerySettings) {
    this.performanceMonitor = new PerformanceMonitor();
  }

  public setEventEmitter(emitter: IndexingEventEmitter): void {
    this.eventEmitter = emitter;
  }

  public setProviderDefinitionBlockHandler(handler: ProviderDefinitionBlockHandler): void {
    this.providerDefinitionBlockHandler = handler;
  }

  public setDatabase(database: VaultDatabase | WorkerDatabase): void {
    this.database = database;
  }

  private needsContentProcessing(): boolean {
    return Boolean(this.providerDefinitionBlockHandler?.hasProviderDefinitionDiscovery()) ||
         !this.initialIndexingComplete ||
         this.settings.enabledFeatures.indexContent ||
         this.settings.enabledFeatures.indexTables ||
         this.settings.enabledFeatures.indexTasks ||
         this.settings.enabledFeatures.indexListItems;
  }

  private shouldProcessNoteContent(file: TFile): boolean {
    if (this.providerDefinitionBlockHandler?.hasProviderDefinitionDiscovery()) return true;

    if (!this.initialIndexingComplete) return true;

    if (this.settings.enabledFeatures.indexContent) return true;

    const cache = this.app.metadataCache.getFileCache(file);

    if (this.settings.enabledFeatures.indexFrontmatter && !cache) return true;

    if (this.settings.enabledFeatures.indexTables && cache?.sections?.length) return true;

    if (this.settings.enabledFeatures.indexTasks && cache?.listItems?.some(item => item.task !== undefined)) return true;
    if (this.settings.enabledFeatures.indexListItems && cache?.listItems?.some(item => item.task === undefined)) return true;

    if (this.settings.enabledFeatures.indexHeadings && cache?.headings?.length) return true;
    if (this.settings.enabledFeatures.indexLinks && (cache?.links?.length || cache?.frontmatterLinks?.length)) return true;
    if (this.settings.enabledFeatures.indexEmbeds && cache?.embeds?.length) return true;
    if (this.settings.enabledFeatures.indexTags && cache?.tags?.length) return true;
    if (this.settings.enabledFeatures.indexBlocks && cache?.blocks) return true;

    return false;
  }

  public async reindexVault(): Promise<void> {
    return this.performReindex(false);
  }

  public async forceReindexVault(): Promise<void> {
    return this.performReindex(true);
  }

  private async performReindex(force: boolean): Promise<void> {
    const reindexId = ++IndexingService.reindexSequence;
    // Settings may have changed since construction (e.g. exclude patterns edited
    // in the settings tab, which schedules this reindex).
    this.performanceMonitor.startOperation();
    this.beginIndexing();
    const releaseDeferral = this.holdRefreshDeferral();

    let filesIndexed = 0;
    let filesRemoved = 0;

    logger.info('Vault reindex started', {
      reindexId,
      force,
      initialIndexingComplete: this.initialIndexingComplete,
      indexFrontmatter: this.settings.enabledFeatures.indexFrontmatter,
    });

    try {
      let toIndex: TFile[];
      let toRemove: string[] = [];

      if (force) {
        this.initialIndexingComplete = false;
        await this.clearAllNotes();
        toIndex = this.app.vault.getMarkdownFiles().filter(file => this.shouldIndexFile(file));
      }
      else {
        const result = await this.getFilesToProcess();
        toIndex = result.toIndex;
        toRemove = result.toRemove;

        if (toRemove.length > 0) {
          await this.removeDeletedFiles(toRemove);
          filesRemoved = toRemove.length;
        }

        if (toIndex.length === 0) {
          if (filesRemoved > 0 || await this.isNotePropertiesBootstrapShape()) {
            await this.rebuildDerivedDatabaseStructures(filesRemoved > 0 ? 'deleted-files' : 'bootstrap-note-properties');
          }

          await this.finalizeIndexing(force, releaseDeferral);
          this.setIndexingProgress(filesIndexed, filesIndexed, 'Complete');
          this.performanceMonitor.finishOperation(filesIndexed);
          this.eventEmitter?.emitVaultIndexed(filesIndexed, filesRemoved, force);

          logger.info('Vault reindex completed', {
            reindexId,
            force,
            filesIndexed,
            filesRemoved,
            initialIndexingComplete: this.initialIndexingComplete,
            noChanges: filesIndexed === 0 && filesRemoved === 0,
          });

          return;
        }
      }

      await this.processFilesInBatches(toIndex, force);
      filesIndexed = toIndex.length;

      await this.rebuildDerivedDatabaseStructures(force ? 'force-reindex' : 'indexed-files');

      await this.finalizeIndexing(force, releaseDeferral);
      this.setIndexingProgress(filesIndexed, filesIndexed, 'Complete');
      this.performanceMonitor.finishOperation(filesIndexed);
      this.eventEmitter?.emitVaultIndexed(filesIndexed, filesRemoved, force);

      logger.info('Vault reindex completed', {
        reindexId,
        force,
        filesIndexed,
        filesRemoved,
        initialIndexingComplete: this.initialIndexingComplete,
      });
    } finally {
      releaseDeferral();
      this.endIndexing();
    }
  }

  private async finalizeIndexing(force: boolean, releaseDeferral: () => void): Promise<void> {
    if (this.eventEmitter?.onBeforeVaultIndexed) {
      await this.eventEmitter.onBeforeVaultIndexed(force);
    }

    // Provider fetches discovered during the reindex may now run against the
    // final main-thread database without extending individual file timings.
    releaseDeferral();

    // After this point realtime indexing skips extracting views/functions/
    // triggers from content - they are registered when code blocks render.
    this.initialIndexingComplete = true;

    this.notifyIndexingChange();
  }

  private async rebuildDerivedDatabaseStructures(reason: string): Promise<void> {
    await this.database.createIndexes(this.settings.enabledFeatures);
    await this.yieldToUI();
    await this.database.schema.rebuildPropertiesView();
    await this.yieldToUI();
    await this.database.schema.rebuildTableViews(this.settings.enableDynamicTableViews);
    await this.yieldToUI();

    try {
      await this.database.run('ANALYZE');
    }
    catch (error) {
      logger.warn('ANALYZE failed after vault indexing', error);
    }

    await this.yieldToUI();
    await this.database.saveToDisk();

    logger.debug('Derived database structures rebuilt', {
      reason,
      dynamicTableViews: this.settings.enableDynamicTableViews,
    });
  }

  private async isNotePropertiesBootstrapShape(): Promise<boolean> {
    if (!this.settings.enabledFeatures.indexFrontmatter) {
      return false;
    }

    const columns = await this.database.schema.getViewColumns('note_properties');

    return columns.includes('key') && columns.includes('value') && columns.includes('value_type');
  }

  /**
   * Scalar property keys for a single note. Used to detect whether an index
   * operation could have changed the global key set: the global set can only
   * change through this note's keys, so comparing the note-scoped set avoids
   * two vault-wide DISTINCT scans per file save.
   */
  private async getNotePropertyKeySet(path: string): Promise<Set<string>> {
    if (!this.settings.enabledFeatures.indexFrontmatter) {
      return new Set();
    }

    const rows = await this.database.all(INDEXING_SQL.SELECT_NOTE_PROPERTY_KEYS, [path]);

    return new Set(rows.map(row => row.key as string));
  }

  private async getPropertyKeyCounts(paths: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!this.settings.enabledFeatures.indexFrontmatter) return counts;

    for (let offset = 0; offset < paths.length; offset += 500) {
      const chunk = paths.slice(offset, offset + 500);
      const rows = await this.database.all(`SELECT key, count(DISTINCT path) AS occurrences FROM properties WHERE path IN (${chunk.map(() => '?').join(',')}) GROUP BY key`, chunk);

      for (const row of rows) {
        counts.set(String(row.key), (counts.get(String(row.key)) ?? 0) + Number(row.occurrences));
      }
    }

    return counts;
  }

  private async countTableRows(paths: readonly string[]): Promise<number> {
    if (!this.settings.enabledFeatures.indexTables || paths.length === 0) return 0;
    let total = 0;

    for (let offset = 0; offset < paths.length; offset += 500) {
      const chunk = paths.slice(offset, offset + 500);
      const rows = await this.database.all(`SELECT count(*) AS occurrences FROM table_cells WHERE path IN (${chunk.map(() => '?').join(',')})`, chunk);
      total += Number(rows[0]?.occurrences ?? 0);
    }

    return total;
  }

  private async globalPropertyKeysChanged(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): Promise<boolean> {
    const changed = [...before.keys()].filter(key => !after.has(key))
      .concat([...after.keys()].filter(key => !before.has(key)));

    for (let offset = 0; offset < changed.length; offset += 500) {
      const keys = changed.slice(offset, offset + 500);
      const rows = await this.database.all(`SELECT key, count(DISTINCT path) AS occurrences FROM properties WHERE key IN (${keys.map(() => '?').join(',')}) GROUP BY key`, keys);
      const global = new Map(rows.map(row => [String(row.key), Number(row.occurrences)]));

      for (const key of keys) {
        if (!after.has(key) ? !global.has(key) : global.get(key) === after.get(key)) return true;
      }
    }

    return false;
  }

  private async getIndexedModifiedByPath(paths: readonly string[]): Promise<Map<string, number>> {
    const uniquePaths = Array.from(new Set(paths));
    const modifiedByPath = new Map<string, number>();
    const chunkSize = 500;

    for (let index = 0; index < uniquePaths.length; index += chunkSize) {
      const chunk = uniquePaths.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await this.database.all(`SELECT path, modified FROM notes WHERE path IN (${placeholders})`, chunk);

      for (const row of rows) {
        modifiedByPath.set(row.path as string, row.modified as number);
      }
    }

    return modifiedByPath;
  }

  private propertyKeySetsEqual(before: Set<string>, after: Set<string>): boolean {
    if (before.size !== after.size) {
      return false;
    }

    for (const key of before) {
      if (!after.has(key)) {
        return false;
      }
    }

    return true;
  }

  private async rebuildPropertiesViewIfNoteKeysChanged(path: string, before: Set<string>): Promise<void> {
    if (!this.settings.enabledFeatures.indexFrontmatter) {
      return;
    }

    const after = await this.getNotePropertyKeySet(path);

    if (!this.propertyKeySetsEqual(before, after)) {
      // The note's keys changed, so the global key set may have changed.
      // Rebuilding unconditionally is fine here: this branch only runs when a
      // note's frontmatter keys actually change, and a redundant rebuild just
      // recreates an identical view.
      await this.database.schema.rebuildPropertiesView();
    }
  }

  public async reindexNote(notePath: string): Promise<void> {
    await this.indexSingleNote(this.validateMarkdownFile(notePath), true);
  }

  public async indexNote(file: TFile, content?: string): Promise<void> {
    const existingResults = await this.database.all(INDEXING_SQL.CHECK_NOTE_EXISTS, [file.path]);
    await this.indexSingleNote(file, existingResults.length > 0, content);
  }

  private async indexSingleNote(file: TFile, isUpdate: boolean, content?: string): Promise<void> {
    const indexData = await this.prepareNoteForIndexing(file, content);
    const propertyKeysBefore = await this.getNotePropertyKeySet(file.path);

    await this.database.indexNote(indexData);
    await this.rebuildPropertiesViewIfNoteKeysChanged(file.path, propertyKeysBefore);

    this.eventEmitter?.emitFileIndexed(file.path, isUpdate);
  }

  public async processRealtimeBatch(filePathsToRemove: readonly string[], candidateFiles: readonly TFile[], force = false): Promise<RealtimeIndexBatchResult> {
    const startedAt = performance.now();
    this.beginIndexing();
    const releaseDeferral = this.holdRefreshDeferral();

    try {
      const pathsToRemove = Array.from(new Set(filePathsToRemove));
      const removalPaths = new Set(pathsToRemove);
      const indexedModifiedByPath = await this.getIndexedModifiedByPath(candidateFiles.map(file => file.path));
      const seenFiles = new Set<string>();
      const filesToIndex: TFile[] = [];
      const updateState = new Map<string, boolean>();

      for (const file of candidateFiles) {
        if (seenFiles.has(file.path) || !this.shouldIndexFile(file)) {
          continue;
        }

        seenFiles.add(file.path);

        const indexedModified = indexedModifiedByPath.get(file.path);

        if (!force && !removalPaths.has(file.path) && indexedModified !== undefined && indexedModified === file.stat.mtime) {
          continue;
        }

        filesToIndex.push(file);
        updateState.set(file.path, indexedModified !== undefined && !removalPaths.has(file.path));
      }

      if (pathsToRemove.length === 0 && filesToIndex.length === 0 && !this.realtimePropertiesRebuildPending) {
        return { filesIndexed: 0, filesRemoved: 0, failedPaths: [], failedRemovalPaths: [] };
      }

      const affectedPaths = [...new Set([...pathsToRemove, ...filesToIndex.map(file => file.path)])];
      const propertyKeysBefore = await this.getPropertyKeyCounts(affectedPaths);
      const tableRowsBefore = await this.countTableRows(affectedPaths);

      const removedPaths: string[] = [];
      const failedRemovalPaths: string[] = [];

      for (let index = 0; index < pathsToRemove.length; index += 500) {
        const chunk = pathsToRemove.slice(index, index + 500);

        try {
          await this.removeDeletedFiles(chunk, false);
          removedPaths.push(...chunk);
        }
        catch (error) {
          logger.error('Realtime note removal failed', { paths: chunk, error });
          failedRemovalPaths.push(...chunk);
        }
      }

      const failedRemovals = new Set(failedRemovalPaths);
      const { indexedFiles, failedPaths } = await this.processRealtimeFiles(filesToIndex.filter(file => !failedRemovals.has(file.path)));
      failedPaths.push(...filesToIndex.filter(file => failedRemovals.has(file.path)).map(file => file.path));

      const propertyKeysAfter = await this.getPropertyKeyCounts(affectedPaths);
      const propertyKeysChanged = await this.globalPropertyKeysChanged(propertyKeysBefore, propertyKeysAfter);
      this.realtimePropertiesRebuildPending ||= propertyKeysChanged;

      if (this.realtimePropertiesRebuildPending) {
        await this.database.schema.rebuildPropertiesView();
        this.realtimePropertiesRebuildPending = false;
      }

      const tableRowsTouched = tableRowsBefore > 0 || await this.countTableRows(affectedPaths) > 0;

      const tableViewsRebuilt = (removedPaths.length > 0 || indexedFiles.length > 0)
        && this.settings.enableDynamicTableViews && tableRowsTouched
        && await this.database.schema.rebuildTableViews(true);

      for (const path of removedPaths) {
        this.eventEmitter?.emitFileRemoved(path);
      }

      for (const file of indexedFiles) {
        this.eventEmitter?.emitFileIndexed(file.path, updateState.get(file.path) ?? false);
      }

      logger.debug('Realtime index batch complete', {
        candidates: candidateFiles.length,
        filesIndexed: indexedFiles.length,
        filesRemoved: removedPaths.length,
        propertyKeysChanged,
        tableViewsRebuilt,
        elapsedMs: Math.round(performance.now() - startedAt),
      });

      return {
        filesIndexed: indexedFiles.length,
        filesRemoved: removedPaths.length,
        failedPaths,
        failedRemovalPaths,
      };
    }
    finally {
      releaseDeferral();

      try {
        await this.providerDefinitionBlockHandler?.refreshStaleDefinitions();
      }
      catch (error) {
        logger.error('Provider refresh failed after realtime indexing', error);
      }
      finally {
        this.endIndexing();
      }
    }
  }

  private async processRealtimeFiles(files: TFile[]): Promise<{ indexedFiles: TFile[]; failedPaths: string[] }> {
    const indexedFiles: TFile[] = [];
    const failedPaths: string[] = [];

    for (const batch of this.createMemoryAwareBatches(files)) {
      const prepared = await mapWithConcurrency(batch, this.PREPARE_CONCURRENCY, async file => {
        try {
          return { file, data: await this.prepareNoteForIndexing(file) };
        }
        catch (error) {
          logger.error('Could not prepare note for realtime indexing', { path: file.path, error });
          failedPaths.push(file.path);

          return null;
        }
      });

      const ready = prepared.filter(entry => entry !== null);
      if (ready.length === 0) continue;

      try {
        await this.database.indexNotesBatch(ready.map(entry => entry.data), false, true, true);
        indexedFiles.push(...ready.map(entry => entry.file));
      }
      catch (error) {
        logger.error('Could not commit realtime index batch', error);
        failedPaths.push(...ready.map(entry => entry.file.path));
      }
    }

    return { indexedFiles, failedPaths };
  }

  public getIndexingStatus(): IndexingStatus {
    return {
      isIndexing: this.isIndexing,
      progress: this.isIndexing ? { ...this.indexingProgress } : undefined
    };
  }

  public isIndexReady(): boolean {
    return !this.isIndexing && (this.initialIndexingComplete || this.settings.indexingInterval === 'manual');
  }

  public onIndexingChange(callback: () => void): () => void {
    this.indexingListeners.add(callback);

    return () => { this.indexingListeners.delete(callback); };
  }

  private notifyIndexingChange(): void {
    for (const callback of this.indexingListeners) callback();
  }

  public waitForIndexing(timeoutMs?: number): Promise<void> {
    if (this.isIndexReady()) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let timeoutId: number | undefined;
      const unsubscribe = this.onIndexingChange(() => {
        if (!this.isIndexReady()) return;
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        unsubscribe();
        resolve();
      });

      if (timeoutMs !== undefined) {
        timeoutId = window.setTimeout(() => {
          unsubscribe();
          reject(new Error('Timed out waiting for indexing to complete'));
        }, timeoutMs);
      }
    });
  }

  public getPerformanceStats(): IndexingStats | null {
    return this.performanceMonitor.getLastStats();
  }

  public setIndexingStatus(isIndexing: boolean): void {
    this.activeIndexing = isIndexing ? Math.max(1, this.activeIndexing) : 0;
    this.isIndexing = isIndexing;

    this.notifyIndexingChange();
  }

  private beginIndexing(): void {
    this.activeIndexing++;
    this.isIndexing = true;
    this.notifyIndexingChange();
  }

  private endIndexing(): void {
    this.activeIndexing = Math.max(0, this.activeIndexing - 1);
    if (this.activeIndexing === 0) this.setIndexingStatus(false);
  }

  private holdRefreshDeferral(): () => void {
    if (this.refreshDeferrals++ === 0) this.providerDefinitionBlockHandler?.setRefreshDeferred(true);
    let held = true;

    return () => {
      if (!held) return;
      held = false;
      if (--this.refreshDeferrals === 0) this.providerDefinitionBlockHandler?.setRefreshDeferred(false);
    };
  }

  private setIndexingProgress(current: number, total: number, currentFile: string): void {
    this.indexingProgress = { current, total, currentFile };
  }

  public async deindex(notePath: string): Promise<void> {
    this.providerDefinitionBlockHandler?.removeProviderDefinitionBlocks(notePath);
    const propertyKeysBefore = await this.getNotePropertyKeySet(notePath);

    await this.database.run(INDEXING_SQL.DELETE_NOTE, [notePath]);
    await this.rebuildPropertiesViewIfNoteKeysChanged(notePath, propertyKeysBefore);

    this.eventEmitter?.emitFileRemoved(notePath);
  }

  public async clearAllNotes(): Promise<void> {
    this.providerDefinitionBlockHandler?.clearProviderDefinitionBlocks();

    if (!(this.database instanceof VaultDatabase)) {
      await this.database.run('DELETE FROM notes');

      return;
    }

    const paths = (await this.database.all('SELECT path FROM notes')).map(row => String(row.path));
    let lastYield = performance.now();

    for (let offset = 0; offset < paths.length; offset += this.BATCH_SIZE_FILES) {
      const batch = paths.slice(offset, offset + this.BATCH_SIZE_FILES);
      const placeholders = batch.map(() => '?').join(',');
      await this.database.run(`${INDEXING_SQL.DELETE_NOTES_BY_PATH_IN}(${placeholders})`, batch);

      if (performance.now() - lastYield >= 8 || offset + batch.length === paths.length) {
        await this.yieldToUI();
        lastYield = performance.now();
      }
    }
  }

  private async yieldToUI(): Promise<void> {
    if (this.database instanceof VaultDatabase) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }

  public shouldIndexFile(file: TFile): boolean {
    if (file.stat.size > this.settings.maxFileSizeKB * 1024) {
      return false;
    }

    return !this.exclusions.matches(file.path, this.settings.excludePatterns);
  }

  private validateMarkdownFile(filePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));

    if (!(file instanceof TFile) || file.extension !== 'md') {
      throw new Error(ERROR_MESSAGES.FILE_NOT_MARKDOWN(filePath));
    }

    return file;
  }

  private async getFilesToProcess(): Promise<{ toIndex: TFile[], toRemove: string[] }> {
    const files = this.app.vault.getMarkdownFiles();
    const indexedFiles = await getIndexedFilesFromDatabase(this.database);

    const indexedFileMap = new Map<string, number>();

    for (const indexedFile of indexedFiles) {
      indexedFileMap.set(indexedFile.path, indexedFile.modified);
    }

    const currentFilePaths = new Set<string>();
    const filesToIndex: TFile[] = [];

    for (const file of files) {
      currentFilePaths.add(file.path);

      if (this.shouldIndexFile(file)) {
        const indexedModified = indexedFileMap.get(file.path);

        if (indexedModified === undefined || file.stat.mtime !== indexedModified) {
          filesToIndex.push(file);
        }
      }
    }

    const filesToRemove: string[] = [];

    for (const indexedFile of indexedFiles) {
      if (!currentFilePaths.has(indexedFile.path)) {
        filesToRemove.push(indexedFile.path);
      }
    }

    return { toIndex: filesToIndex, toRemove: filesToRemove };
  }

  private async removeDeletedFiles(filePaths: string[], emitEvents: boolean = true): Promise<void> {
    if (filePaths.length === 0) return;

    // Batch delete in chunks to avoid SQLite parameter limits (max ~999)
    const CHUNK_SIZE = 500;

    for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      await this.database.run(`${INDEXING_SQL.DELETE_NOTES_BY_PATH_IN}(${placeholders})`, chunk);
    }

    for (const pathToRemove of filePaths) {
      this.providerDefinitionBlockHandler?.removeProviderDefinitionBlocks(pathToRemove);

      if (emitEvents) {
        this.eventEmitter?.emitFileRemoved(pathToRemove);
      }
    }
  }

  private async processFilesInBatches(files: TFile[], isInitialIndexing: boolean = false): Promise<void> {
    this.detectDuplicateFiles(files);

    const totalToIndex = files.length;
    let indexed = 0;

    this.setIndexingProgress(0, totalToIndex, 'Starting...');

    const batches = this.createMemoryAwareBatches(files);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      indexed = await this.processSingleBatch(batch, indexed, totalToIndex, isInitialIndexing);

      if (indexed >= totalToIndex) {
        this.setIndexingProgress(indexed, totalToIndex, 'Complete');
      }

      if (batchIndex + 1 < batches.length) {
        await this.yieldToUI();
      }
    }
  }

  /**
   * Creates batches that respect both file count and total size limits.
   * Keeps memory bounded when processing many large files.
   */
  private createMemoryAwareBatches(files: TFile[]): TFile[][] {
    const batches: TFile[][] = [];
    let currentBatch: TFile[] = [];
    let currentBatchSize = 0;

    for (const file of files) {
      const fileSize = file.stat.size;

      if (currentBatch.length >= this.BATCH_SIZE_FILES ||
          (currentBatchSize + fileSize > this.BATCH_SIZE_BYTES && currentBatch.length > 0)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchSize = 0;
      }

      currentBatch.push(file);
      currentBatchSize += fileSize;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private detectDuplicateFiles(files: TFile[]): void {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const file of files) {
      if (seen.has(file.path)) {
        duplicates.push(file.path);
      }
      else {
        seen.add(file.path);
      }
    }

    if (duplicates.length > 0) {
      logger.warn(`Duplicate files detected in input: ${duplicates.join(', ')}`);
    }
  }

  private async processSingleBatch(batch: TFile[], currentIndexed: number, totalToIndex: number, isInitialIndexing: boolean): Promise<number> {
    if (this.batchHasDuplicates(batch)) {
      return await this.processBatchIndividually(batch, currentIndexed, totalToIndex);
    }

    const fileTimings: FilePreparationTiming[] = [];
    const prepareStartedAt = performance.now();
    const batchData = await this.prepareBatchData(batch, currentIndexed, totalToIndex, fileTimings);
    const prepareMs = performance.now() - prepareStartedAt;

    const databaseStartedAt = performance.now();
    await this.database.indexNotesBatch(batchData, isInitialIndexing, true);
    const databaseMs = performance.now() - databaseStartedAt;
    const batchBytes = batch.reduce((total, file) => total + file.stat.size, 0);

    const featureRows = batchData.reduce((total, data) => total
      + (data.frontmatterData?.length ?? 0)
      + (data.tables?.length ?? 0)
      + (data.tableCells?.length ?? 0)
      + (data.tasks?.length ?? 0)
      + (data.headings?.length ?? 0)
      + (data.links?.length ?? 0)
      + (data.unresolvedLinks?.length ?? 0)
      + (data.embeds?.length ?? 0)
      + (data.tags?.length ?? 0)
      + (data.listItems?.length ?? 0)
      + (data.blocks?.length ?? 0)
      + (data.userViews?.length ?? 0)
      + (data.userFunctions?.length ?? 0)
      + (data.userTriggers?.length ?? 0), 0);

    const fileTimeTotalsMs = { readWait: 0, providerWait: 0, frontmatter: 0, features: 0 };

    for (const timing of fileTimings) {
      fileTimeTotalsMs.readWait += timing.readWaitMs;
      fileTimeTotalsMs.providerWait += timing.providerWaitMs;
      fileTimeTotalsMs.frontmatter += timing.frontmatterMs;
      fileTimeTotalsMs.features += timing.featuresMs;
    }

    const slowFiles = fileTimings.filter(timing => timing.totalMs > PerformanceMonitor.SLOW_THRESHOLD_MS)
      .sort((a, b) => b.totalMs - a.totalMs).slice(0, 3);

    logger.debug('Index batch phases', {
      startIndex: currentIndexed,
      files: batch.length,
      bytes: batchBytes,
      featureRows,
      prepareMs: Math.round(prepareMs),
      databaseMs: Math.round(databaseMs),
      fileTimeTotalsMs: Object.fromEntries(Object.entries(fileTimeTotalsMs).map(([key, value]) => [key, Math.round(value)])),
      slowFiles: slowFiles.map(timing => ({ ...timing,
        totalMs: Math.round(timing.totalMs), readWaitMs: Math.round(timing.readWaitMs),
        providerWaitMs: Math.round(timing.providerWaitMs), frontmatterMs: Math.round(timing.frontmatterMs),
        featuresMs: Math.round(timing.featuresMs),
      })),
    });

    return currentIndexed + batch.length;
  }

  private batchHasDuplicates(batch: TFile[]): boolean {
    const batchPaths = new Set(batch.map(f => f.path));

    return batchPaths.size !== batch.length;
  }

  private async processBatchIndividually(batch: TFile[], currentIndexed: number, totalToIndex: number): Promise<number> {
    logger.warn('Duplicate files detected in batch, processing individually');

    let indexed = currentIndexed;

    for (const file of batch) {
      const indexData = await this.prepareNoteForIndexing(file);
      await this.database.indexNote(indexData);

      indexed++;
      this.setIndexingProgress(indexed, totalToIndex, file.path);
    }

    return indexed;
  }

  private async prepareBatchData(batch: TFile[], currentIndexed: number, totalToIndex: number, timings: FilePreparationTiming[]): Promise<IndexNoteData[]> {
    let completed = 0;

    return await mapWithConcurrency(batch, this.PREPARE_CONCURRENCY, async (file) => {
      const indexData = await this.prepareNoteForIndexing(file, undefined, timings);

      completed++;
      this.setIndexingProgress(currentIndexed + completed, totalToIndex, file.path);

      return indexData;
    });
  }

  private async prepareNoteForIndexing(file: TFile, content?: string, timings?: FilePreparationTiming[]): Promise<IndexNoteData> {
    const startTime = performance.now();
    let readWaitMs = 0;

    const contentAvailable = content !== undefined || this.shouldProcessNoteContent(file);

    if (content === undefined) {
      if (contentAvailable) {
        const readStartedAt = performance.now();
        content = await this.app.vault.cachedRead(file);
        readWaitMs = performance.now() - readStartedAt;
      } else content = '';
    }

    const cache = this.app.metadataCache.getFileCache(file);

    let providerWaitMs = 0;

    if (this.providerDefinitionBlockHandler?.hasProviderDefinitionDiscovery()) {
      const providerStartedAt = performance.now();
      await this.providerDefinitionBlockHandler.indexProviderDefinitionBlocks(file.path, content);
      providerWaitMs = performance.now() - providerStartedAt;
    }

    const frontmatterStartedAt = performance.now();
    const info = getFrontMatterInfo(content);
    const contentWithoutFrontmatter = this.extractContentWithoutFrontmatter(content);
    const note = this.createNoteRecord(file, contentWithoutFrontmatter);
    let frontmatter: unknown = cache?.frontmatter;

    if (contentAvailable) {
      try {
        frontmatter = info.exists ? parseYaml(info.frontmatter) : undefined;
      }
      catch {
        frontmatter = undefined;
      } // Match Obsidian's absent properties for invalid YAML.
    }

    const frontmatterData = this.processFrontmatter(frontmatter);
    const featuresStartedAt = performance.now();
    const features = this.processFeatures(file, content, contentWithoutFrontmatter, cache, contentAvailable);

    const finishedAt = performance.now();

    const timing: FilePreparationTiming = {
      path: file.path, bytes: file.stat.size, totalMs: finishedAt - startTime,
      readWaitMs, providerWaitMs, frontmatterMs: featuresStartedAt - frontmatterStartedAt,
      featuresMs: finishedAt - featuresStartedAt,
    };

    timings?.push(timing);
    this.performanceMonitor.trackFile(timing);

    return {
      note,
      frontmatterData,
      ...features
    };
  }

  private extractContentWithoutFrontmatter(content: string): string {
    if (!this.needsContentProcessing()) {
      return '';
    }

    const info = getFrontMatterInfo(content);

    return info.exists ? content.slice(info.contentStart).trim() : content;
  }

  private createNoteRecord(file: TFile, contentWithoutFrontmatter: string): NoteRecord {
    const now = Date.now();
    const minValidTimestamp = 946684800000; // 2000-01-01 in ms - any file should be newer than this

    let created = file.stat.ctime;
    let modified = file.stat.mtime;

    if (!modified || modified < minValidTimestamp) {
      modified = now;
    }

    if (!created || created < minValidTimestamp) {
      created = modified;
    }

    return {
      path: file.path,
      title: file.basename,
      content: this.settings.enabledFeatures.indexContent ? contentWithoutFrontmatter : '',
      content_status: this.settings.enabledFeatures.indexContent ? 'ready' : 'not_indexed',
      created,
      modified,
      size: file.stat.size
    };
  }

  private processFrontmatter(frontmatter: unknown): IndexNoteData['frontmatterData'] {
    if (!this.settings.enabledFeatures.indexFrontmatter || !frontmatter || typeof frontmatter !== 'object') {
      return [];
    }

    const prototype: unknown = Object.getPrototypeOf(frontmatter);
    if (prototype !== Object.prototype && prototype !== null) return [];

    return this.processFrontmatterProperties(frontmatter as Record<string, unknown>);
  }

  private cachePositionsMatchContent(cache: CachedMetadata, lines: string[], lineStartOffsets: number[]): boolean {
    const matches = ({ line, col, offset }: Pos['start']): boolean => lines[line] !== undefined && col >= 0 && col <= lines[line].length && lineStartOffsets[line] + col === offset;

    const positionMatches = ({ start, end }: Pos): boolean => start.offset <= end.offset && matches(start) && matches(end);

    for (const entries of [cache.sections, cache.listItems, cache.headings, cache.links, cache.embeds, cache.tags]) {
      if (entries?.some(entry => !positionMatches(entry.position))) return false;
    }

    if (cache.blocks && Object.values(cache.blocks).some(block => !positionMatches(block.position))) return false;

    return !cache.frontmatterPosition || positionMatches(cache.frontmatterPosition);
  }

  private processFeatures(file: TFile, content: string, contentWithoutFrontmatter: string, cache: CachedMetadata | null, contentAvailable = true): Omit<IndexNoteData, 'note' | 'frontmatterData'> {
    const frontmatterOffset = getFrontMatterInfo(content).contentStart;
    // Count leading whitespace in place; substring().trimStart() here would
    // allocate two copies of the note body just to measure it.
    let trimmedOffset = 0;

    if (frontmatterOffset > 0) {
      WHITESPACE_RUN.lastIndex = frontmatterOffset;
      trimmedOffset = WHITESPACE_RUN.exec(content)?.[0].length ?? 0;
    }

    const contentOffset = frontmatterOffset + trimmedOffset;

    const fullLines = content ? content.split('\n') : [];
    const lineStartOffsets = this.buildLineStartOffsets(fullLines);

    // A trigger can write frontmatter and request a reindex before Obsidian has
    // updated its metadata. Never use those old positions against the new text.
    // The metadata-changed event will index these features once the cache catches up.
    if (cache && contentAvailable && !this.cachePositionsMatchContent(cache, fullLines, lineStartOffsets)) {
      logger.debug('Metadata positions do not match content; retaining indexed features until metadata refresh', { path: file.path });
      cache = null;
    }

    let contentLines: string[];

    if (contentOffset > 0 && fullLines.length > 0) {
      let charCount = 0;
      let firstContentLine = 0;

      for (let i = 0; i < fullLines.length; i++) {
        charCount += fullLines[i].length + 1;

        if (charCount >= contentOffset) {
          firstContentLine = i + 1;
          break;
        }
      }

      contentLines = fullLines.slice(firstContentLine);
    } else {
      contentLines = fullLines;
    }

    const lineOffset = fullLines.length - contentLines.length;

    const { tables, tableCells } = this.processTablesFeature(
      contentWithoutFrontmatter,
      contentLines,
      contentOffset,
      lineOffset,
      cache,
      file.basename
    );

    const tasks = this.processTasksFeature(content, fullLines, lineStartOffsets, cache);
    const headings = this.processHeadingsFeature(content, fullLines, lineStartOffsets, cache);
    const links = this.processLinksFeature(cache, file.path);
    const unresolvedLinks = this.processUnresolvedLinksFeature(file.path);
    const embeds = this.processEmbedsFeature(cache, file.path);
    const tags = this.processTagsFeature(cache);
    const listItems = this.processListItemsFeature(fullLines, cache);
    const blocks = this.processBlocksFeature(cache);

    let userViews: UserViewData[] | undefined;
    let userFunctions: UserFunctionData[] | undefined;
    let userTriggers: UserTriggerData[] | undefined;

    if (!this.initialIndexingComplete) {
      const { views, functions, triggers } = this.extractAllUserDefinedObjects(content);

      userViews = views.length > 0 ? views : undefined;
      userFunctions = this.settings.enableJavaScriptFunctions && functions.length > 0 ? functions : undefined;
      userTriggers = triggers.length > 0 ? triggers : undefined;
    }

    const features: Omit<IndexNoteData, 'note' | 'frontmatterData'> = {
      tables,
      tableCells,
      tasks,
      headings,
      links,
      unresolvedLinks,
      embeds,
      tags,
      listItems,
      blocks,
      userViews,
      userFunctions,
      userTriggers
    };

    if (!cache) {
      for (const key of ['tasks', 'headings', 'links', 'unresolvedLinks', 'embeds', 'tags', 'listItems', 'blocks'] as const) {
        features[key] = undefined;
      }
    }

    return features;
  }

  private processTablesFeature(contentWithoutFrontmatter: string, contentLines: string[], contentOffset: number, lineOffset: number, cache: CachedMetadata | null, noteTitle: string): {
    tables: IndexNoteData['tables'];
    tableCells: IndexNoteData['tableCells'];
  } {
    if (!this.settings.enabledFeatures.indexTables || !contentWithoutFrontmatter) {
      return { tables: undefined, tableCells: undefined };
    }

    const hasSections = cache?.sections && cache.sections.length > 0;

    if (!hasSections) {
      return { tables: undefined, tableCells: undefined };
    }

    const tables = MarkdownTableUtils.detectAllTables(contentWithoutFrontmatter, contentOffset, noteTitle);
    const tableCells = this.parseAndIndexTables(contentLines, lineOffset, contentOffset, tables ?? []);

    return { tables, tableCells };
  }

  private processTasksFeature(fullContent: string, fullLines: string[], lineStartOffsets: number[], cache: CachedMetadata | null): IndexNoteData['tasks'] {
    if (!this.settings.enabledFeatures.indexTasks) {
      return undefined;
    }

    const taskItems = cache?.listItems?.filter(item => item.task !== undefined);

    if (!taskItems || taskItems.length === 0) {
      return undefined;
    }

    return this.parseTasksFromCache(fullContent, fullLines, lineStartOffsets, taskItems, cache);
  }

  private processHeadingsFeature(content: string, lines: string[], lineStartOffsets: number[], cache: CachedMetadata | null): IndexNoteData['headings'] {
    if (!this.settings.enabledFeatures.indexHeadings) {
      return undefined;
    }

    const contextOccurrences = new Map<string, number>();

    const headings = cache?.headings?.map((heading: HeadingCache) => {
      const lineIndex = heading.position.start.line;
      const { start, end } = this.getLineRange(content, lines, lineStartOffsets, lineIndex);

      const occurrence = this.getNextContextOccurrence(contextOccurrences, lineIndex, lines);
      const anchorHash = ContentLocationService.computeAnchorHash(lineIndex, lines, occurrence);
      const blockId = ContentLocationService.extractBlockId(lines, lineIndex);

      return {
        level: heading.level,
        heading_text: heading.heading,
        line_number: heading.position.start.line + 1,
        block_id: blockId,
        start_offset: start,
        end_offset: end,
        anchor_hash: anchorHash
      };
    }) || [];

    return headings;
  }

  private processLinksFeature(cache: CachedMetadata | null, sourcePath: string): IndexNoteData['links'] {
    if (!this.settings.enabledFeatures.indexLinks) {
      return undefined;
    }

    const links: NonNullable<IndexNoteData['links']> = cache?.links?.map((link: LinkCache) => {
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(link.link, sourcePath);

      return {
        link_text: link.displayText || link.link,
        link_target: link.link,
        link_target_path: targetFile?.path ?? null,
        link_type: 'internal',
        line_number: link.position.start.line + 1,
        original: link.original ?? null,
        start_offset: link.position.start.offset,
        end_offset: link.position.end.offset,
        frontmatter_key: null
      };
    }) || [];

    for (const link of cache?.frontmatterLinks ?? []) {
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(link.link, sourcePath);

      links.push({
        link_text: link.displayText || link.link,
        link_target: link.link,
        link_target_path: targetFile?.path ?? null,
        link_type: 'frontmatter',
        line_number: null,
        original: link.original ?? null,
        start_offset: null,
        end_offset: null,
        frontmatter_key: link.key
      });
    }

    return links;
  }

  private processUnresolvedLinksFeature(path: string): IndexNoteData['unresolvedLinks'] {
    if (!this.settings.enabledFeatures.indexUnresolvedLinks) {
      return undefined;
    }

    const unresolvedForPath = this.app.metadataCache.unresolvedLinks[path] ?? {};

    return Object.entries(unresolvedForPath).map(([linkTarget, linkCount]) => ({
      link_target: linkTarget,
      link_count: linkCount
    }));
  }

  private processEmbedsFeature(cache: CachedMetadata | null, sourcePath: string): IndexNoteData['embeds'] {
    if (!this.settings.enabledFeatures.indexEmbeds) {
      return undefined;
    }

    const embeds = cache?.embeds?.map((embed: ReferenceCache) => {
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, sourcePath);

      return {
        embed_text: embed.displayText || embed.link,
        embed_target: embed.link,
        embed_target_path: targetFile?.path ?? null,
        line_number: embed.position.start.line + 1
      };
    }) || [];

    return embeds;
  }

  private processTagsFeature(cache: CachedMetadata | null): IndexNoteData['tags'] {
    if (!this.settings.enabledFeatures.indexTags) {
      return undefined;
    }

    return cache?.tags?.map((tag: TagCache) => ({
      // Normalize: always store tags with # prefix (Obsidian's cache may omit it for frontmatter tags)
      tag_name: tag.tag.startsWith('#') ? tag.tag : '#' + tag.tag,
      line_number: tag.position.start.line + 1
    })) || [];
  }

  private processBlocksFeature(cache: CachedMetadata | null): IndexNoteData['blocks'] {
    if (!this.settings.enabledFeatures.indexBlocks) {
      return undefined;
    }

    const blocks = cache?.blocks;

    if (!blocks) {
      return [];
    }

    return Object.values(blocks).map((block: BlockCache) => ({
      block_id: block.id,
      line_number: block.position.start.line + 1,
      start_offset: block.position.start.offset,
      end_offset: block.position.end.offset,
      section_type: this.findSectionType(cache, block.position.start.line)
    }));
  }

  private processListItemsFeature(lines: string[], cache: CachedMetadata | null): IndexNoteData['listItems'] {
    if (!this.settings.enabledFeatures.indexListItems) {
      return undefined;
    }

    const cacheListItems = cache?.listItems;

    if (!cacheListItems || cacheListItems.length === 0) {
      return undefined;
    }

    const listItems: ListItemData[] = [];
    const cacheListItemsByLine = this.buildListItemCacheByLine(cacheListItems);
    const indentLevelByLine = new Map<number, number>();

    let currentListIndex = 0;
    let lastRootLineNumber = -1;

    const lineNumberToItemIndex = new Map<number, number>();
    const contextOccurrences = new Map<string, number>();

    const nonTaskItems = cacheListItems.filter(item => item.task === undefined);

    for (const item of nonTaskItems) {
      const lineIndex = item.position.start.line;
      const line = lines[lineIndex] || '';

      if (this.isLineInSectionType(cache, lineIndex, new Set(['code', 'table', 'yaml']))) {
        continue;
      }

      const parsedListLine = this.parseMarkdownListLine(line);

      if (!parsedListLine) {
        continue;
      }

      const isRootItem = item.parent < 0;

      if (isRootItem && lastRootLineNumber >= 0 && lineIndex - lastRootLineNumber > 1) {
        currentListIndex++;
      }

      if (isRootItem) {
        lastRootLineNumber = lineIndex;
      }

      const listType = parsedListLine.listType;
      const indentLevel = this.computeListIndentLevelFromCache(item, cacheListItemsByLine, indentLevelByLine);
      let itemContent = parsedListLine.content;

      const blockMatch = line.match(/\^([\w-]+)\s*$/);
      let blockId: string | undefined;

      if (blockMatch) {
        blockId = blockMatch[1];
        itemContent = itemContent.replace(/\s*\^[\w-]+\s*$/, '');
      } else {
        blockId = ContentLocationService.extractBlockId(lines, lineIndex, line);
      }

      const startOffset = item.position.start.offset;
      const endOffset = item.position.end.offset;

      const occurrence = this.getNextContextOccurrence(contextOccurrences, lineIndex, lines);
      const anchorHash = ContentLocationService.computeAnchorHash(lineIndex, lines, occurrence);

      let parentIndex: number | null = null;

      if (item.parent >= 0) {
        const mappedParentIndex = lineNumberToItemIndex.get(item.parent);

        if (mappedParentIndex !== undefined) {
          parentIndex = mappedParentIndex;
        }
        // Parent filtered out (e.g. it was a task): the item becomes a root item.
      }

      lineNumberToItemIndex.set(lineIndex, listItems.length);

      const listItemData: ListItemData = {
        list_index: currentListIndex,
        item_index: listItems.length,
        parent_index: parentIndex,
        content: itemContent.trim(),
        list_type: listType,
        indent_level: indentLevel,
        line_number: lineIndex + 1,
        block_id: blockId,
        start_offset: startOffset,
        end_offset: endOffset,
        anchor_hash: anchorHash
      };

      listItems.push(listItemData);
    }

    return listItems.length > 0 ? listItems : undefined;
  }

  private parseMarkdownListLine(line: string): { listType: 'bullet' | 'number'; content: string; } | null {
    const withoutBlockquote = line.replace(/^(?:\s*>\s?)*/, '').replace(/\r$/, '');
    const match = withoutBlockquote.match(/^(\s*)(?:(([-*+])|(\d+[.)]))\s+)(.*)$/);

    if (!match) {
      return null;
    }

    return {
      listType: match[4] ? 'number' : 'bullet',
      content: match[5] ?? ''
    };
  }

  private buildListItemCacheByLine(cacheListItems: ListItemCache[]): Map<number, ListItemCache> {
    const byLine = new Map<number, ListItemCache>();

    for (const item of cacheListItems) {
      byLine.set(item.position.start.line, item);
    }

    return byLine;
  }

  private computeListIndentLevelFromCache(item: ListItemCache, itemsByLine: Map<number, ListItemCache>, depthByLine: Map<number, number>, seen = new Set<number>()): number {
    const line = item.position.start.line;
    const cachedDepth = depthByLine.get(line);

    if (cachedDepth !== undefined) {
      return cachedDepth;
    }

    if (item.parent < 0 || seen.has(line)) {
      depthByLine.set(line, 0);

      return 0;
    }

    const parent = itemsByLine.get(item.parent);

    if (!parent) {
      depthByLine.set(line, 0);

      return 0;
    }

    seen.add(line);
    const depth = this.computeListIndentLevelFromCache(parent, itemsByLine, depthByLine, seen) + 1;
    seen.delete(line);
    depthByLine.set(line, depth);

    return depth;
  }

  private isLineInSectionType(cache: CachedMetadata | null, lineIndex: number, sectionTypes: Set<string>): boolean {
    return cache?.sections?.some(section => sectionTypes.has(section.type) &&
      section.position.start.line <= lineIndex &&
      section.position.end.line >= lineIndex
    ) ?? false;
  }

  private findSectionType(cache: CachedMetadata | null, lineIndex: number): string | null {
    return cache?.sections?.find(section => section.position.start.line <= lineIndex &&
      section.position.end.line >= lineIndex
    )?.type ?? null;
  }

  private getNextContextOccurrence(contextOccurrences: Map<string, number>, lineIndex: number, lines: string[]): number {
    const contextKey = ContentLocationService.computeContextKey(lineIndex, lines);
    const occurrence = contextOccurrences.get(contextKey) ?? 0;
    contextOccurrences.set(contextKey, occurrence + 1);

    return occurrence;
  }

  private processFrontmatterProperties(obj: Record<string, unknown>, keyPrefix: string = ''): Array<{ key: string; value: string; valueType: string; arrayIndex: number | null }> {
    const convertValue = (val: unknown): { valueType: string; valueString: string } => {
      if (val == null) return { valueType: 'null', valueString: '' };

      return {
        valueType: typeof val,
        valueString: typeof val === 'string' ? val : JSON.stringify(val)
      };
    };

    const results: Array<{ key: string; value: string; valueType: string; arrayIndex: number | null }> = [];

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = keyPrefix ? `${keyPrefix}.${key}` : key;

      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          const { valueType, valueString } = convertValue(item);
          results.push({ key: fullKey, value: valueString, valueType, arrayIndex: index });
        });
      }
      else if (typeof value === 'object' && value !== null) {
        results.push(...this.processFrontmatterProperties(value as Record<string, unknown>, fullKey));
      }
      else {
        const { valueType, valueString } = convertValue(value);
        results.push({ key: fullKey, value: valueString, valueType, arrayIndex: null });
      }
    }

    return results;
  }

  private parseAndIndexTables(lines: string[], lineOffset: number, contentOffset: number, detectedTables: NonNullable<IndexNoteData['tables']>): TableCellData[] {
    if (detectedTables.length === 0) {
      return [];
    }

    const tableCells: TableCellData[] = [];

    const lineStartOffsets = this.buildLineStartOffsets(lines, contentOffset);

    for (const detectedTable of detectedTables) {
      const tableStartOffset = detectedTable.start_offset;
      let lineIndex = this.findLineIndexForOffset(lineStartOffsets, tableStartOffset);

      if (lineIndex < 0 || lineIndex >= lines.length) continue;

      const tableData = MarkdownTableUtils.parseMarkdownTableAt(lines, lineIndex);

      if (tableData.headers.length > 0 && tableData.rows.length > 0) {
        const tableName = detectedTable.table_name ?? null;

        tableData.rows.forEach((row, rowIndex) => {
          const dataRowLineNumber = lineIndex + tableData.dataStartLine + rowIndex + lineOffset + 1;

          tableData.headers.forEach((columnName, columnIndex) => {
            const cellValue = row[columnIndex] || '';

            const cellData: TableCellData = {
              tableIndex: detectedTable.table_index,
              tableName,
              rowIndex,
              columnName,
              cellValue,
              lineNumber: dataRowLineNumber
            };

            tableCells.push(cellData);
          });
        });
      }
    }

    return tableCells;
  }

  /** Binary search to find line index for a character offset */
  private findLineIndexForOffset(lineStartOffsets: number[], targetOffset: number): number {
    let low = 0;
    let high = lineStartOffsets.length - 1;

    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);

      if (lineStartOffsets[mid] <= targetOffset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return low;
  }

  private buildLineStartOffsets(lines: string[], startOffset = 0): number[] {
    const offsets: number[] = [];
    let offset = startOffset;

    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }

    return offsets;
  }

  private getLineRange(content: string, lines: string[], lineStartOffsets: number[], lineIndex: number): { start: number; end: number } {
    if (lineIndex < 0 || lineIndex >= lines.length) {
      return { start: 0, end: 0 };
    }

    const start = lineStartOffsets[lineIndex] ?? 0;

    const end = lineIndex + 1 < lineStartOffsets.length
      ? Math.max(start, lineStartOffsets[lineIndex + 1] - 1)
      : content.length;

    return { start, end };
  }

  private parseTasksFromCache(fullContent: string, fullLines: string[], lineStartOffsets: number[], taskItems: ListItemCache[], cache: CachedMetadata | null): TaskData[] {
    const tasks: TaskData[] = [];
    const contextOccurrences = new Map<string, number>();

    const sortedHeadings = [...(cache?.headings ?? [])]
      .sort((a, b) => a.position.start.line - b.position.start.line);

    let headingIndex = 0;
    let currentSectionHeading: string | undefined;

    for (const item of taskItems) {
      const lineIndex = item.position.start.line;

      while (
        headingIndex < sortedHeadings.length &&
        sortedHeadings[headingIndex].position.start.line < lineIndex
      ) {
        currentSectionHeading = sortedHeadings[headingIndex].heading;
        headingIndex++;
      }

      const line = fullLines[lineIndex] || '';
      const checkbox = item.task || ' ';
      const { completed, status } = ContentLocationService.getTaskStatus(checkbox);

      const lineText = line.replace(/\r$/, '');
      const taskTextMatch = lineText.match(/^\s*[-*+]\s*\[.\]\s*(.*)$/);
      const taskText = taskTextMatch ? taskTextMatch[1] : lineText;

      const { start, end } = this.getLineRange(fullContent, fullLines, lineStartOffsets, lineIndex);

      const occurrence = this.getNextContextOccurrence(contextOccurrences, lineIndex, fullLines);

      const anchorHash = ContentLocationService.computeAnchorHash(lineIndex, fullLines, occurrence);

      const blockId = ContentLocationService.extractBlockId(fullLines, lineIndex, line);

      const normalizedTaskText = taskText.replace(/\s*\^[\w-]+\s*$/, '').trim();
      const metadata = extractTaskMetadata(normalizedTaskText);

      const taskData: TaskData = {
        line_number: lineIndex + 1,
        task_text: normalizedTaskText,
        completed,
        status,
        priority: metadata.priority,
        due_date: metadata.dueDate,
        scheduled_date: metadata.scheduledDate,
        start_date: metadata.startDate,
        created_date: metadata.createdDate,
        done_date: metadata.doneDate,
        cancelled_date: metadata.cancelledDate,
        recurrence: metadata.recurrence,
        on_completion: metadata.onCompletion,
        task_id: metadata.taskId,
        depends_on: metadata.dependsOn,
        tags: metadata.tags,
        block_id: blockId,
        start_offset: start,
        end_offset: end,
        anchor_hash: anchorHash,
        section_heading: currentSectionHeading
      };

      tasks.push(taskData);
    }

    return tasks;
  }

  /**
   * Extract all user-defined objects (views, functions, triggers) in a single pass.
   * More efficient than three separate content scans.
   */
  private extractAllUserDefinedObjects(content: string): { views: UserViewData[]; functions: UserFunctionData[]; triggers: UserTriggerData[]; } {
    const blocks = extractAllCodeBlocks(content);

    const views = blocks.views
      .map(sql => {
        const viewName = parseSQLObjectName(sql, 'VIEW');

        return viewName ? { view_name: viewName, sql } : null;
      })
      .filter((v): v is UserViewData => v !== null);

    const functions = blocks.functions
      .map(source => {
        const functionName = parseFunctionName(source);

        return functionName ? { function_name: functionName, source } : null;
      })
      .filter((f): f is UserFunctionData => f !== null);

    const triggers = blocks.triggers
      .map(sql => {
        const triggerName = parseSQLObjectName(sql, 'TRIGGER');

        return triggerName ? { trigger_name: triggerName, trigger_sql: sql } : null;
      })
      .filter((t): t is UserTriggerData => t !== null);

    return { views, functions, triggers };
  }
}
