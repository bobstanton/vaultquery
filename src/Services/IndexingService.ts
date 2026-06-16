import { App, TFile, CachedMetadata, HeadingCache, LinkCache, TagCache, ListItemCache, normalizePath } from 'obsidian';
import { VaultDatabase } from '../Database/DatabaseService';
import { WorkerDatabase } from '../Database/WorkerDatabaseService';
import { VaultQuerySettings } from '../Settings/Settings';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import { ContentLocationService } from './ContentLocationService';
import { PerformanceMonitor, IndexingTimings } from './PerformanceMonitor';
import { ERROR_MESSAGES, WARNING_MESSAGES } from '../utils/ErrorMessages';
import { getIndexedFilesFromDatabase } from '../Database/IndexedFiles';
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
  onBeforeVaultIndexed?: () => Promise<void>;
}

interface ProviderDefinitionBlockHandler {
  hasProviderDefinitionDiscovery(): boolean;
  indexProviderDefinitionBlocks(path: string, content: string): Promise<void>;
  removeProviderDefinitionBlocks(path: string): void;
  clearProviderDefinitionBlocks(): void;
}

export class IndexingService {
  private performanceMonitor: PerformanceMonitor;

  private indexingProgress: IndexingProgress = { current: 0, total: 0, currentFile: '' };
  private isIndexing = false;
  private indexingCallbacks: Array<() => void> = [];

  /** Maximum files per batch */
  private readonly BATCH_SIZE_FILES = 200;
  /** Maximum total file size per batch (10MB) - prevents memory issues with large files */
  private readonly BATCH_SIZE_BYTES = 10 * 1024 * 1024;
  /** Maximum concurrent file reads/preparations within a batch */
  private readonly PREPARE_CONCURRENCY = 24;
  private excludeRegexps: RegExp[] = [];

  private eventEmitter: IndexingEventEmitter | null = null;
  private providerDefinitionBlockHandler: ProviderDefinitionBlockHandler | null = null;

  // After initial indexing completes, we don't need to extract views/functions/triggers
  // from file content anymore - they're only registered when code blocks render.
  // Also used by waitForIndexing() to wait for first indexing on startup.
  private initialIndexingComplete = false;
  private firstIndexingCallbacks: Array<() => void> = [];

  public constructor(private app: App, private database: VaultDatabase | WorkerDatabase, private settings: VaultQuerySettings) {
    this.performanceMonitor = new PerformanceMonitor();
    this.updateExcludePatterns();
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

  private updateExcludePatterns(): void {
    this.excludeRegexps = this.settings.excludePatterns.map(p => new RegExp(p));
  }
  
  private needsContentProcessing(): boolean {
    return Boolean(this.providerDefinitionBlockHandler?.hasProviderDefinitionDiscovery()) ||
         !this.initialIndexingComplete ||
         this.settings.enabledFeatures.indexContent ||
         this.settings.enabledFeatures.indexTables ||
         this.settings.enabledFeatures.indexTasks ||
         this.settings.enabledFeatures.indexListItems;
  }

  private shouldProcessFileContent(file: TFile): boolean {
    if (this.providerDefinitionBlockHandler?.hasProviderDefinitionDiscovery()) return true;

    if (!this.initialIndexingComplete) return true;

    if (this.settings.enabledFeatures.indexContent) return true;

    const cache = this.app.metadataCache.getFileCache(file);

    if (this.settings.enabledFeatures.indexTables && cache?.sections?.length) return true;

    if (this.settings.enabledFeatures.indexTasks && cache?.listItems?.some(item => item.task !== undefined)) return true;
    if (this.settings.enabledFeatures.indexListItems && cache?.listItems?.some(item => item.task === undefined)) return true;

    if (this.settings.enabledFeatures.indexHeadings && cache?.headings?.length) return true;

    return false;
  }

  public async reindexVault(): Promise<void> {
    return this.performReindex(false);
  }

  public async forceReindexVault(): Promise<void> {
    return this.performReindex(true);
  }

  private async performReindex(force: boolean): Promise<void> {
    // Settings may have changed since construction (e.g. exclude patterns edited
    // in the settings tab, which schedules this reindex).
    this.updateExcludePatterns();
    this.performanceMonitor.startOperation();
    this.setIndexingStatus(true);

    let filesIndexed = 0;
    let filesRemoved = 0;

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
          if (filesRemoved > 0) {
            await this.rebuildDerivedDatabaseStructures();
          }

          this.setIndexingProgress(0, 0, 'Complete');
          this.performanceMonitor.finishOperation(0);
          await this.finalizeIndexing();
          this.eventEmitter?.emitVaultIndexed(0, filesRemoved, force);
          return;
        }
      }

      await this.processFilesInBatches(toIndex, force);
      filesIndexed = toIndex.length;

      await this.rebuildDerivedDatabaseStructures();

      this.setIndexingProgress(toIndex.length, toIndex.length, 'Complete');

      this.performanceMonitor.finishOperation(toIndex.length);

      await this.finalizeIndexing();
      this.eventEmitter?.emitVaultIndexed(filesIndexed, filesRemoved, force);
    } finally {
      this.setIndexingStatus(false);
    }
  }

  private async finalizeIndexing(): Promise<void> {
    if (this.eventEmitter?.onBeforeVaultIndexed) {
      await this.eventEmitter.onBeforeVaultIndexed();
    }

    // Mark initial indexing as complete - after this, we skip extracting views/functions/triggers
    // from file content during realtime indexing (they're registered when code blocks render)
    this.initialIndexingComplete = true;

    const firstCallbacks = this.firstIndexingCallbacks.splice(0);
    firstCallbacks.forEach(callback => callback());
  }

  private async rebuildDerivedDatabaseStructures(): Promise<void> {
    await this.database.createIndexes(this.settings.enabledFeatures);
    await this.database.schema.rebuildPropertiesView();
    await this.database.schema.rebuildTableViews(this.settings.enableDynamicTableViews);
    await this.database.saveToDisk();
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

    const rows = await this.database.all(
      'SELECT DISTINCT key FROM properties WHERE path = ? AND array_index IS NULL',
      [path]
    );
    return new Set(rows.map(row => row.key as string));
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
    const file = this.validateMarkdownFile(notePath);

    const content = this.needsContentProcessing() ? await this.app.vault.cachedRead(file) : '';
    const indexData = await this.prepareNoteForIndexing(file, content);
    const propertyKeysBefore = await this.getNotePropertyKeySet(file.path);

    await this.database.indexNote(indexData);
    await this.rebuildPropertiesViewIfNoteKeysChanged(file.path, propertyKeysBefore);

    this.eventEmitter?.emitFileIndexed(file.path, true);
  }

  public async indexNote(file: TFile, content?: string): Promise<void> {
    const existingResults = await this.database.all('SELECT 1 FROM notes WHERE path = ? LIMIT 1', [file.path]);
    const isUpdate = existingResults.length > 0;

    const actualContent = content ||
      (this.shouldProcessFileContent(file) ? await this.app.vault.cachedRead(file) : '');

    const indexData = await this.prepareNoteForIndexing(file, actualContent);
    const propertyKeysBefore = await this.getNotePropertyKeySet(file.path);

    await this.database.indexNote(indexData);
    await this.rebuildPropertiesViewIfNoteKeysChanged(file.path, propertyKeysBefore);

    this.eventEmitter?.emitFileIndexed(file.path, isUpdate);
  }

  public getIndexingStatus(): IndexingStatus {
    return {
      isIndexing: this.isIndexing,
      progress: this.isIndexing ? { ...this.indexingProgress } : undefined
    };
  }

  public waitForIndexing(timeoutMs?: number): Promise<void> {
    if (this.initialIndexingComplete && !this.isIndexing) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let timeoutId: number | undefined;

      const callback = () => {
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId);
        }
        resolve();
      };

      if (this.isIndexing) {
        this.indexingCallbacks.push(callback);
      }
      else if (!this.initialIndexingComplete) {
        this.firstIndexingCallbacks.push(callback);
      }

      if (timeoutMs !== undefined) {
        timeoutId = window.setTimeout(() => {
          let index = this.indexingCallbacks.indexOf(callback);
          if (index !== -1) {
            this.indexingCallbacks.splice(index, 1);
          }
          index = this.firstIndexingCallbacks.indexOf(callback);
          if (index !== -1) {
            this.firstIndexingCallbacks.splice(index, 1);
          }
          logger.warn('Timed out waiting for indexing to complete');
          resolve();
        }, timeoutMs);
      }
    });
  }

  public getPerformanceStats(): IndexingStats | null {
    return this.performanceMonitor.getLastStats();
  }

  public setIndexingStatus(isIndexing: boolean, promise?: Promise<void>): void {
    this.isIndexing = isIndexing;

    const executeCallbacks = () => {
      const callbacks = this.indexingCallbacks.splice(0);
      callbacks.forEach(callback => callback());
    };

    if (promise && isIndexing) {
      void promise.then(executeCallbacks);
    }
    else if (!isIndexing) {
      executeCallbacks();
    }
  }

  private setIndexingProgress(current: number, total: number, currentFile: string): void {
    this.indexingProgress = { current, total, currentFile };
  }

  public async removeNote(notePath: string): Promise<void> {
    this.providerDefinitionBlockHandler?.removeProviderDefinitionBlocks(notePath);
    const propertyKeysBefore = await this.getNotePropertyKeySet(notePath);

    await this.database.run('DELETE FROM notes WHERE path = ?', [notePath]);
    await this.rebuildPropertiesViewIfNoteKeysChanged(notePath, propertyKeysBefore);

    this.eventEmitter?.emitFileRemoved(notePath);
  }

  public async clearAllNotes(): Promise<void> {
    this.providerDefinitionBlockHandler?.clearProviderDefinitionBlocks();
    await this.database.run('DELETE FROM notes');
  }

  public shouldIndexFile(file: TFile): boolean {
    if (file.stat.size > this.settings.maxFileSizeKB * 1024) {
      return false;
    }

    for (const regex of this.excludeRegexps) {
      if (regex.test(file.path)) {
        return false;
      }
    }
    return true;
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
    const indexedFiles = await this.getIndexedFiles();

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

  private async getIndexedFiles(): Promise<Array<{ path: string; modified: number }>> {
    return getIndexedFilesFromDatabase(this.database);
  }

  private async removeDeletedFiles(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;

    // Batch delete in chunks to avoid SQLite parameter limits (max ~999)
    const CHUNK_SIZE = 500;
    for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      await this.database.run(`DELETE FROM notes WHERE path IN (${placeholders})`, chunk);
    }

    for (const pathToRemove of filePaths) {
      this.providerDefinitionBlockHandler?.removeProviderDefinitionBlocks(pathToRemove);
      this.eventEmitter?.emitFileRemoved(pathToRemove);
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

      this.updateProgressAfterBatch(indexed, totalToIndex);

      await this.delayBetweenBatches(batchIndex, batches.length);
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
      logger.warn(WARNING_MESSAGES.DUPLICATE_FILES_IN_INPUT(duplicates));
    }
  }

  private async processSingleBatch(batch: TFile[], currentIndexed: number, totalToIndex: number, isInitialIndexing: boolean): Promise<number> {
    if (this.batchHasDuplicates(batch)) {
      return await this.processBatchIndividually(batch, currentIndexed, totalToIndex);
    }

    const batchData = await this.prepareBatchData(batch, currentIndexed, totalToIndex);

    await this.database.indexNotesBatch(batchData, isInitialIndexing, true);

    return currentIndexed + batch.length;
  }

  private batchHasDuplicates(batch: TFile[]): boolean {
    const batchPaths = new Set(batch.map(f => f.path));
    return batchPaths.size !== batch.length;
  }

  private async processBatchIndividually(batch: TFile[], currentIndexed: number, totalToIndex: number): Promise<number> {
    logger.warn(WARNING_MESSAGES.DUPLICATE_FILES_IN_BATCH);

    let indexed = currentIndexed;

    for (const file of batch) {
      const content = this.shouldProcessFileContent(file) ? await this.app.vault.cachedRead(file) : '';
      const indexData = await this.prepareNoteForIndexing(file, content);
      await this.database.indexNote(indexData);

      indexed++;
      this.setIndexingProgress(indexed, totalToIndex, file.path);
    }

    return indexed;
  }

  private async prepareBatchData(batch: TFile[], currentIndexed: number, totalToIndex: number): Promise<IndexNoteData[]> {
    let completed = 0;

    return await this.mapWithConcurrency(batch, this.PREPARE_CONCURRENCY, async (file) => {
      const content = this.shouldProcessFileContent(file)
        ? await this.app.vault.cachedRead(file)
        : '';

      const indexData = await this.prepareNoteForIndexing(file, content);

      completed++;
      this.setIndexingProgress(currentIndexed + completed, totalToIndex, file.path);

      return indexData;
    });
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    const executing = new Set<Promise<void>>();
    const concurrencyLimit = Math.min(Math.max(1, concurrency), items.length);

    for (const [index, item] of items.entries()) {
      const task = (async () => {
        results[index] = await mapper(item, index);
      })();

      executing.add(task);
      task.then(
        () => executing.delete(task),
        () => executing.delete(task)
      );

      if (executing.size >= concurrencyLimit) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);

    return results;
  }

  private updateProgressAfterBatch(indexed: number, totalToIndex: number): void {
    if (indexed >= totalToIndex) {
      this.setIndexingProgress(indexed, totalToIndex, 'Complete');
    }
  }

  private async delayBetweenBatches(currentBatchIndex: number, totalBatches: number): Promise<void> {
    if (currentBatchIndex + 1 < totalBatches) {
      await this.yieldToEventLoop();
    }
  }

  private async yieldToEventLoop(): Promise<void> {
    // Use a macrotask yield so rendering and input can run between indexing batches.
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }

  private async prepareNoteForIndexing(file: TFile, content: string): Promise<IndexNoteData> {
    const startTime = performance.now();
    const cache = this.app.metadataCache.getFileCache(file);

    if (this.providerDefinitionBlockHandler?.hasProviderDefinitionDiscovery()) {
      await this.providerDefinitionBlockHandler.indexProviderDefinitionBlocks(file.path, content);
    }

    const { contentWithoutFrontmatter, fmTime } = this.extractContentWithoutFrontmatter(content, cache);
    const note = this.createNoteRecord(file, contentWithoutFrontmatter);
    const { frontmatterData, frontmatterTime } = this.processFrontmatter(cache);
    const featureData = this.processFeatures(file, content, contentWithoutFrontmatter, cache);

    this.trackPerformance(file, startTime, {
      fmTime,
      frontmatterTime,
      ...featureData.timings
    });

    return {
      note,
      frontmatterData,
      ...featureData.results
    };
  }

  private extractContentWithoutFrontmatter(content: string, cache: CachedMetadata | null): { contentWithoutFrontmatter: string; fmTime: number } {
    if (!this.needsContentProcessing()) {
      return { contentWithoutFrontmatter: '', fmTime: 0 };
    }

    const fmStartTime = performance.now();
    let contentWithoutFrontmatter = '';

    if (cache?.frontmatterPosition) {
      contentWithoutFrontmatter = content.substring(cache.frontmatterPosition.end.offset).trim();
    }
    else {
      contentWithoutFrontmatter = content;
    }

    const fmTime = performance.now() - fmStartTime;
    return { contentWithoutFrontmatter, fmTime };
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
      title: this.deriveTitle(file.path, file.basename),
      content: this.settings.enabledFeatures.indexContent ? contentWithoutFrontmatter : '',
      created,
      modified,
      size: this.deriveSize(file.stat.size, contentWithoutFrontmatter)
    };
  }

  private processFrontmatter(cache: CachedMetadata | null): {
    frontmatterData: Array<{
      key: string;
      value: string;
      valueType: string;
      arrayIndex: number | null;
    }>;
    frontmatterTime: number;
  } {
    if (!this.settings.enabledFeatures.indexFrontmatter || !cache?.frontmatter) {
      return { frontmatterData: [], frontmatterTime: 0 };
    }

    const frontmatterStartTime = performance.now();
    const frontmatterData = this.processFrontmatterProperties(cache.frontmatter);
    const frontmatterTime = performance.now() - frontmatterStartTime;

    return { frontmatterData, frontmatterTime };
  }

  private processFeatures(file: TFile, content: string, contentWithoutFrontmatter: string, cache: CachedMetadata | null): {
    results: {
      tables: IndexNoteData['tables'];
      tableCells: IndexNoteData['tableCells'];
      tasks: IndexNoteData['tasks'];
      headings: IndexNoteData['headings'];
      links: IndexNoteData['links'];
      tags: IndexNoteData['tags'];
      listItems: IndexNoteData['listItems'];
      userViews: IndexNoteData['userViews'];
      userFunctions: IndexNoteData['userFunctions'];
      userTriggers: IndexNoteData['userTriggers'];
    };
    timings: {
      tablesTime: number;
      tasksTime: number;
      headingsTime: number;
      linksTime: number;
      tagsTime: number;
      listItemsTime: number;
    };
  } {
    const timings = {
      tablesTime: 0,
      tasksTime: 0,
      headingsTime: 0,
      linksTime: 0,
      tagsTime: 0,
      listItemsTime: 0
    };

    const frontmatterOffset = cache?.frontmatterPosition?.end.offset ?? 0;
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

    const { tables, tableCells, time: tablesTime } = this.processTablesFeature(
      contentWithoutFrontmatter,
      contentLines,
      contentOffset,
      lineOffset,
      cache,
      file.basename
    );
    timings.tablesTime = tablesTime;

    const { tasks, time: tasksTime } = this.processTasksFeature(
      content,
      fullLines,
      lineStartOffsets,
      cache
    );
    timings.tasksTime = tasksTime;

    const { headings, time: headingsTime } = this.processHeadingsFeature(content, fullLines, lineStartOffsets, cache);
    timings.headingsTime = headingsTime;

    const { links, time: linksTime } = this.processLinksFeature(cache, file.path);
    timings.linksTime = linksTime;

    const { tags, time: tagsTime } = this.processTagsFeature(cache);
    timings.tagsTime = tagsTime;

    const { listItems, time: listItemsTime } = this.processListItemsFeature(content, fullLines, cache);
    timings.listItemsTime = listItemsTime;

    let userViews: UserViewData[] | undefined;
    let userFunctions: UserFunctionData[] | undefined;
    let userTriggers: UserTriggerData[] | undefined;

    if (!this.initialIndexingComplete) {
      const { views, functions, triggers } = this.extractAllUserDefinedObjects(content);

      userViews = views.length > 0 ? views : undefined;
      userFunctions = this.settings.enableJavaScriptFunctions && functions.length > 0 ? functions : undefined;
      userTriggers = triggers.length > 0 ? triggers : undefined;
    }

    return {
      results: {
        tables,
        tableCells,
        tasks,
        headings,
        links,
        tags,
        listItems,
        userViews,
        userFunctions,
        userTriggers
      },
      timings
    };
  }

  private processTablesFeature(contentWithoutFrontmatter: string, contentLines: string[], contentOffset: number, lineOffset: number, cache: CachedMetadata | null, noteTitle: string): {
    tables: IndexNoteData['tables'];
    tableCells: IndexNoteData['tableCells'];
    time: number;
  } {
    if (!this.settings.enabledFeatures.indexTables || !contentWithoutFrontmatter) {
      return { tables: undefined, tableCells: undefined, time: 0 };
    }

    const hasSections = cache?.sections && cache.sections.length > 0;
    if (!hasSections) {
      return { tables: undefined, tableCells: undefined, time: 0 };
    }

    const startTime = performance.now();
    const tables = MarkdownTableUtils.detectAllTables(contentWithoutFrontmatter, contentOffset, noteTitle);
    const tableCells = this.parseAndIndexTables(contentWithoutFrontmatter, contentLines, lineOffset, contentOffset, tables ?? []);
    const time = performance.now() - startTime;

    return { tables, tableCells, time };
  }

  private processTasksFeature(fullContent: string, fullLines: string[], lineStartOffsets: number[], cache: CachedMetadata | null): {
    tasks: IndexNoteData['tasks'];
    time: number;
  } {
    if (!this.settings.enabledFeatures.indexTasks) {
      return { tasks: undefined, time: 0 };
    }

    const taskItems = cache?.listItems?.filter(item => item.task !== undefined);
    if (!taskItems || taskItems.length === 0) {
      return { tasks: undefined, time: 0 };
    }

    const startTime = performance.now();
    const tasks = this.parseTasksFromCache(fullContent, fullLines, lineStartOffsets, taskItems, cache);
    const time = performance.now() - startTime;

    return { tasks, time };
  }

  private processHeadingsFeature(content: string, lines: string[], lineStartOffsets: number[], cache: CachedMetadata | null): {
    headings: IndexNoteData['headings'];
    time: number;
  } {
    if (!this.settings.enabledFeatures.indexHeadings) {
      return { headings: undefined, time: 0 };
    }

    const startTime = performance.now();

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

    const time = performance.now() - startTime;
    return { headings, time };
  }

  private processLinksFeature(cache: CachedMetadata | null, sourcePath: string): {
    links: IndexNoteData['links'];
    time: number;
  } {
    if (!this.settings.enabledFeatures.indexLinks) {
      return { links: undefined, time: 0 };
    }

    const startTime = performance.now();
    const links = cache?.links?.map((link: LinkCache) => {
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(link.link, sourcePath);
      return {
        link_text: link.displayText || link.link,
        link_target: link.link,
        link_target_path: targetFile?.path ?? null,
        link_type: 'internal',
        line_number: link.position.start.line + 1
      };
    }) || [];

    const time = performance.now() - startTime;
    return { links, time };
  }

  private processTagsFeature(cache: CachedMetadata | null): {
    tags: IndexNoteData['tags'];
    time: number;
  } {
    if (!this.settings.enabledFeatures.indexTags) {
      return { tags: undefined, time: 0 };
    }

    const startTime = performance.now();
    const tags = cache?.tags?.map((tag: TagCache) => ({
      // Normalize: always store tags with # prefix (Obsidian's cache may omit it for frontmatter tags)
      tag_name: tag.tag.startsWith('#') ? tag.tag : '#' + tag.tag,
      line_number: tag.position.start.line + 1
    })) || [];

    const time = performance.now() - startTime;
    return { tags, time };
  }

  private processListItemsFeature(content: string, lines: string[], cache: CachedMetadata | null): {
    listItems: IndexNoteData['listItems'];
    time: number;
  } {
    if (!this.settings.enabledFeatures.indexListItems) {
      return { listItems: undefined, time: 0 };
    }

    const cacheListItems = cache?.listItems;
    if (!cacheListItems || cacheListItems.length === 0) {
      return { listItems: undefined, time: 0 };
    }

    const startTime = performance.now();
    const listItems: ListItemData[] = [];
    const cacheListItemsByLine = this.buildListItemCacheByLine(cacheListItems);
    const indentLevelByLine = new Map<number, number>();

    let currentListIndex = 0;
    let lastRootLineNumber = -1;

    const lineNumberToItemIndex = new Map<number, number>();
    const contextOccurrences = new Map<string, number>();

    const nonTaskItems = cacheListItems
      .map((item, index) => ({ item, cacheIndex: index }))
      .filter(({ item }) => item.task === undefined);

    nonTaskItems.forEach(({ item, cacheIndex: _cacheIndex }, _arrayIndex) => {
      const lineIndex = item.position.start.line;
      const line = lines[lineIndex] || '';
      if (this.isLineInSectionType(cache, lineIndex, new Set(['code', 'table', 'yaml']))) {
        return;
      }

      const parsedListLine = this.parseMarkdownListLine(line);
      if (!parsedListLine) {
        return;
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
        // If parent mapping failed, check if parent was filtered out as a task
        // In that case, the list item becomes a root item (null parent)
        // This is expected behavior when tasks have non-task children
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
    });

    const time = performance.now() - startTime;
    return { listItems: listItems.length > 0 ? listItems : undefined, time };
  }

  private parseMarkdownListLine(line: string): {
    listType: 'bullet' | 'number';
    content: string;
  } | null {
    const withoutBlockquote = line.replace(/^(?:\s*>\s?)*/, '');
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
    return cache?.sections?.some(section =>
      sectionTypes.has(section.type) &&
      section.position.start.line <= lineIndex &&
      section.position.end.line >= lineIndex
    ) ?? false;
  }

  private getNextContextOccurrence(contextOccurrences: Map<string, number>, lineIndex: number, lines: string[]): number {
    const contextKey = ContentLocationService.computeContextKey(lineIndex, lines);
    const occurrence = contextOccurrences.get(contextKey) ?? 0;
    contextOccurrences.set(contextKey, occurrence + 1);
    return occurrence;
  }

  private trackPerformance(file: TFile, startTime: number, timings: IndexingTimings): void {
    this.performanceMonitor.trackFile(
      file,
      startTime,
      timings,
      this.needsContentProcessing()
    );
  }
  
  private processFrontmatterProperties(obj: Record<string, unknown>, keyPrefix: string = ''): Array<{
    key: string;
    value: string;
    valueType: string;
    arrayIndex: number | null
  }> {
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

  private parseAndIndexTables(content: string, lines: string[], lineOffset: number, contentOffset: number, detectedTables: NonNullable<IndexNoteData['tables']>): TableCellData[] {
    if (detectedTables.length === 0) {
      return [];
    }

    const tableCells: TableCellData[] = [];

    const lineStartOffsets: number[] = [];
    let currentOffset = contentOffset;
    for (let i = 0; i < lines.length; i++) {
      lineStartOffsets.push(currentOffset);
      currentOffset += lines[i].length + 1;
    }

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

  private buildLineStartOffsets(lines: string[]): number[] {
    const offsets: number[] = [];
    let offset = 0;

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

      const taskTextMatch = line.match(/^\s*[-*+]\s*\[.\]\s*(.*)$/);
      const taskText = taskTextMatch ? taskTextMatch[1] : line;

      const { start, end } = this.getLineRange(fullContent, fullLines, lineStartOffsets, lineIndex);

      const contextKey = ContentLocationService.computeContextKey(lineIndex, fullLines);
      const occurrence = contextOccurrences.get(contextKey) ?? 0;
      contextOccurrences.set(contextKey, occurrence + 1);

      const anchorHash = ContentLocationService.computeAnchorHash(lineIndex, fullLines, occurrence);

      const blockId = ContentLocationService.extractBlockId(fullLines, lineIndex, line);

      const normalizedTaskText = taskText.replace(/\s*\^[\w-]+\s*$/, '').trim();
      const metadata = this.extractTaskMetadata(normalizedTaskText);

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

  private extractTaskMetadata(taskText: string): {
    priority?: string;
    createdDate?: string;
    scheduledDate?: string;
    startDate?: string;
    dueDate?: string;
    doneDate?: string;
    cancelledDate?: string;
    recurrence?: string;
    onCompletion?: string;
    taskId?: string;
    dependsOn?: string;
    tags?: string;
  } {
    let priority: string | undefined;
    if (taskText.includes('🔺')) {
      priority = 'highest';
    }
    else if (taskText.includes('⏫')) {
      priority = 'high';
    }
    else if (taskText.includes('🔼')) {
      priority = 'medium';
    }
    else if (taskText.includes('🔽')) {
      priority = 'low';
    }
    else if (taskText.includes('⏬')) {
      priority = 'lowest';
    }

    const createdDateMatch = taskText.match(/➕\s*(\d{4}-\d{2}-\d{2})/);
    const createdDate = createdDateMatch?.[1];

    const scheduledDateMatch = taskText.match(/⏳\s*(\d{4}-\d{2}-\d{2})/);
    const scheduledDate = scheduledDateMatch?.[1];

    const startDateMatch = taskText.match(/🛫\s*(\d{4}-\d{2}-\d{2})/);
    const startDate = startDateMatch?.[1];

    const dueDateMatch = taskText.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    const dueDate = dueDateMatch?.[1];

    const doneDateMatch = taskText.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
    const doneDate = doneDateMatch?.[1];

    const cancelledDateMatch = taskText.match(/❌\s*(\d{4}-\d{2}-\d{2})/);
    const cancelledDate = cancelledDateMatch?.[1];

    const recurrenceMatch = taskText.match(/🔁\s*([^📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🆔⛔🏁#]+)/u);
    const recurrence = recurrenceMatch?.[1]?.trim();

    const onCompletionMatch = taskText.match(/🏁\s*(\w+)/);
    const onCompletion = onCompletionMatch?.[1];

    const taskIdMatch = taskText.match(/🆔\s*([\w-]+)/);
    const taskId = taskIdMatch?.[1];

    const dependsOnMatch = taskText.match(/⛔\s*([\w,-]+)/);
    const dependsOn = dependsOnMatch?.[1];

    const tagMatches = taskText.match(/#[\w-]+/g);
    const tags = tagMatches ? tagMatches.join(' ') : undefined;

    return {
      priority,
      createdDate,
      scheduledDate,
      startDate,
      dueDate,
      doneDate,
      cancelledDate,
      recurrence,
      onCompletion,
      taskId,
      dependsOn,
      tags
    };
  }

  private deriveTitle(path: string, basename: string): string {
    if (basename) return basename;
    // lastIndexOf returns -1 if not found, so substring(0) works for both cases
    return path.substring(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  }

  private deriveSize(statSize: number, content: string): number {
    return statSize > 0 ? statSize : (content?.length ?? 0);
  }

  /**
   * Extract all user-defined objects (views, functions, triggers) in a single pass.
   * More efficient than three separate content scans.
   */
  private extractAllUserDefinedObjects(content: string): {
    views: UserViewData[];
    functions: UserFunctionData[];
    triggers: UserTriggerData[];
  } {
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
