import { App, TFile, CachedMetadata, HeadingCache, LinkCache, TagCache, ListItemCache, normalizePath } from 'obsidian';
import { VaultDatabase } from '../Database/DatabaseService';
import { VaultQuerySettings } from '../Settings/Settings';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import { ContentLocationService } from './ContentLocationService';
import { PerformanceMonitor, IndexingTimings } from './PerformanceMonitor';
import { ERROR_MESSAGES, WARNING_MESSAGES, CONSOLE_ERRORS } from '../utils/ErrorMessages';
import type { IndexNoteData, NoteRecord, IndexingStats, IndexingProgress, IndexingStatus, TableCellData, TaskData, ListItemData, UserViewData, UserFunctionData } from '../types';

declare const activeWindow: Window;

export interface IndexingEventEmitter {
  emitFileIndexed: (path: string, isUpdate: boolean) => void;
  emitFileRemoved: (path: string) => void;
  emitVaultIndexed: (filesIndexed: number, filesRemoved: number, isForced: boolean) => void;
}

export class IndexingService {
  private performanceMonitor: PerformanceMonitor;

  private indexingProgress: IndexingProgress = { current: 0, total: 0, currentFile: '' };
  private isIndexing = false;
  private indexingCallbacks: Array<() => void> = [];

  private readonly BATCH_SIZE = 200;
  private excludeRegexps: RegExp[] = [];

  private eventEmitter: IndexingEventEmitter | null = null;

  public constructor(private app: App, private database: VaultDatabase, private settings: VaultQuerySettings) {
    this.performanceMonitor = new PerformanceMonitor();
    this.updateExcludePatterns();
  }

  public setEventEmitter(emitter: IndexingEventEmitter): void {
    this.eventEmitter = emitter;
  }

  private updateExcludePatterns(): void {
    this.excludeRegexps = this.settings.excludePatterns.map(p => new RegExp(p));
  }
  
  private needsContentProcessing(): boolean {
    return this.settings.enabledFeatures.indexContent ||
         this.settings.enabledFeatures.indexTables ||
         this.settings.enabledFeatures.indexTasks ||
         this.settings.enabledFeatures.indexListItems;
  }

  private shouldProcessFileContent(file: TFile): boolean {
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
    this.performanceMonitor.startOperation();
    this.setIndexingStatus(true);

    let filesIndexed = 0;
    let filesRemoved = 0;

    try {
      let toIndex: TFile[];
      let toRemove: string[] = [];

      if (force) {
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
          this.eventEmitter?.emitVaultIndexed(0, filesRemoved, force);
          return;
        }
      }

      await this.processFilesInBatches(toIndex, force);
      filesIndexed = toIndex.length;

      this.database.createIndexes(this.settings.enabledFeatures);

      await this.database.saveToDisk();

      this.database.rebuildPropertiesView();
      this.database.rebuildTableViews(this.settings.enableDynamicTableViews);

      this.setIndexingProgress(toIndex.length, toIndex.length, 'Complete');

      this.performanceMonitor.finishOperation(toIndex.length);

      this.eventEmitter?.emitVaultIndexed(filesIndexed, filesRemoved, force);
    } finally {
      this.setIndexingStatus(false);
    }
  }

  public async reindexNote(notePath: string): Promise<void> {
    const file = this.validateMarkdownFile(notePath);

    const content = this.needsContentProcessing() ? await this.app.vault.cachedRead(file) : '';
    const indexData = await this.prepareNoteForIndexing(file, content);
    await this.database.indexNote(indexData);

    this.eventEmitter?.emitFileIndexed(file.path, true);
  }

  public async indexNote(file: TFile, content?: string): Promise<void> {
    const existingResults = await this.database.all('SELECT 1 FROM notes WHERE path = ? LIMIT 1', [file.path]);
    const isUpdate = existingResults.length > 0;

    let actualContent = content;
    if (!actualContent && this.shouldProcessFileContent(file)) {
      actualContent = await this.app.vault.cachedRead(file);
    }
    else if (!actualContent) {
      actualContent = '';
    }

    const indexData = await this.prepareNoteForIndexing(file, actualContent);

    await this.database.indexNote(indexData);

    this.eventEmitter?.emitFileIndexed(file.path, isUpdate);
  }

  public getIndexingStatus(): IndexingStatus {
    return {
      isIndexing: this.isIndexing,
      progress: this.isIndexing ? { ...this.indexingProgress } : undefined
    };
  }

  public waitForIndexing(timeoutMs?: number): Promise<void> {
    if (!this.isIndexing) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let timeoutId: number | undefined;

      const callback = () => {
        if (timeoutId !== undefined) {
          activeWindow.clearTimeout(timeoutId);
        }
        resolve();
      };

      this.indexingCallbacks.push(callback);

      if (timeoutMs !== undefined) {
        timeoutId = activeWindow.setTimeout(() => {
          const index = this.indexingCallbacks.indexOf(callback);
          if (index !== -1) {
            this.indexingCallbacks.splice(index, 1);
          }
          console.warn('[VaultQuery] Timed out waiting for indexing to complete');
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

  public removeNote(notePath: string): void {
    this.database.runWithPreparedStatement('DELETE FROM notes WHERE path = ?', [notePath]);
    this.eventEmitter?.emitFileRemoved(notePath);
  }

  public clearAllNotes(): void {
    this.database.run('DELETE FROM notes');
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
    indexedFiles.forEach(indexedFile => {
      indexedFileMap.set(indexedFile.path, indexedFile.modified);
    });
    
    const filesToIndex: TFile[] = [];
    for (const file of files) {
      if (this.shouldIndexFile(file)) {
        const indexedModified = indexedFileMap.get(file.path);
        if (indexedModified === undefined || file.stat.mtime !== indexedModified) {
          filesToIndex.push(file);
        }
      }
    }

    const currentFilePaths = new Set(files.map(f => f.path));
    const filesToRemove: string[] = [];
    for (const indexedFile of indexedFiles) {
      if (!currentFilePaths.has(indexedFile.path)) {
        filesToRemove.push(indexedFile.path);
      }
    }
    
    return { toIndex: filesToIndex, toRemove: filesToRemove };
  }

  private async getIndexedFiles(): Promise<Array<{ path: string; modified: number }>> {
    try {
      const results = await this.database.all('SELECT path, modified FROM notes');
      return results.map(row => ({
        path: row.path as string,
        modified: row.modified as number
      }));
    }
    catch (error) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.INDEXED_FILES_ERROR}:`, error);
      return [];
    }
  }

  private removeDeletedFiles(filePaths: string[]): void {
    for (const pathToRemove of filePaths) {
      this.removeNote(pathToRemove);
    }
  }

  private async processFilesInBatches(files: TFile[], isInitialIndexing: boolean = false): Promise<void> {
    this.detectDuplicateFiles(files);

    const totalToIndex = files.length;
    let indexed = 0;

    this.setIndexingProgress(0, totalToIndex, 'Starting...');

    for (let i = 0; i < files.length; i += this.BATCH_SIZE) {
      const batch = files.slice(i, i + this.BATCH_SIZE);

      indexed = await this.processSingleBatch(batch, indexed, totalToIndex, isInitialIndexing);

      this.updateProgressAfterBatch(indexed, totalToIndex);

      await this.delayBetweenBatches(i, files.length);
    }
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
      console.warn(`[VaultQuery] ${WARNING_MESSAGES.DUPLICATE_FILES_IN_INPUT(duplicates)}`);
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
    console.warn(`[VaultQuery] ${WARNING_MESSAGES.DUPLICATE_FILES_IN_BATCH}`);

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
    return await Promise.all(
      batch.map(async (file) => {
        this.setIndexingProgress(currentIndexed + 1, totalToIndex, file.path);

        const content = this.shouldProcessFileContent(file)
          ? await this.app.vault.cachedRead(file)
          : '';

        return await this.prepareNoteForIndexing(file, content);
      })
    );
  }

  private updateProgressAfterBatch(indexed: number, totalToIndex: number): void {
    if (indexed >= totalToIndex) {
      this.setIndexingProgress(indexed, totalToIndex, 'Complete');
    }
  }

  private async delayBetweenBatches(currentIndex: number, totalFiles: number): Promise<void> {
    if (currentIndex + this.BATCH_SIZE < totalFiles) {
      await new Promise(resolve => activeWindow.setTimeout(resolve, 0));
    }
  }

  private prepareNoteForIndexing(file: TFile, content: string): IndexNoteData {
    const startTime = performance.now();
    const cache = this.app.metadataCache.getFileCache(file);

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
    const trimmedOffset = frontmatterOffset > 0 ?
      content.substring(frontmatterOffset).length - content.substring(frontmatterOffset).trimStart().length : 0;
    const contentOffset = frontmatterOffset + trimmedOffset;

    const fullLines = content ? content.split('\n') : [];
    const contentLines = contentWithoutFrontmatter ? contentWithoutFrontmatter.split('\n') : [];

    let lineOffset = 0;
    if (contentOffset > 0 && fullLines.length > 0) {
      let charCount = 0;
      for (let i = 0; i < fullLines.length; i++) {
        charCount += fullLines[i].length + 1; // +1 for newline
        if (charCount >= contentOffset) {
          lineOffset = i + 1;
          break;
        }
      }
    }

    const { tables, tableCells, time: tablesTime } = this.processTablesFeature(
      contentWithoutFrontmatter,
      contentOffset,
      lineOffset,
      cache,
      file.basename
    );
    timings.tablesTime = tablesTime;

    const { tasks, time: tasksTime } = this.processTasksFeature(
      content,
      fullLines,
      contentLines,
      contentOffset,
      lineOffset,
      cache
    );
    timings.tasksTime = tasksTime;

    const { headings, time: headingsTime } = this.processHeadingsFeature(content, fullLines, cache);
    timings.headingsTime = headingsTime;

    const { links, time: linksTime } = this.processLinksFeature(cache, file.path);
    timings.linksTime = linksTime;

    const { tags, time: tagsTime } = this.processTagsFeature(cache);
    timings.tagsTime = tagsTime;

    const { listItems, time: listItemsTime } = this.processListItemsFeature(content, fullLines, cache);
    timings.listItemsTime = listItemsTime;

    const userViews = this.extractUserViews(content);
    const userFunctions = this.extractUserFunctions(content);

    return {
      results: {
        tables,
        tableCells,
        tasks,
        headings,
        links,
        tags,
        listItems,
        userViews: userViews.length > 0 ? userViews : undefined,
        userFunctions: userFunctions.length > 0 ? userFunctions : undefined
      },
      timings
    };
  }

  private processTablesFeature(contentWithoutFrontmatter: string, contentOffset: number, lineOffset: number, cache: CachedMetadata | null, noteTitle: string): {
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
    const tableCells = this.parseAndIndexTables(contentWithoutFrontmatter, lineOffset, contentOffset, tables ?? []);
    const time = performance.now() - startTime;

    return { tables, tableCells, time };
  }

  private processTasksFeature(fullContent: string, fullLines: string[], contentLines: string[], contentOffset: number, lineOffset: number, cache: CachedMetadata | null): {
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
    const tasks = this.parseTasksFromCache(fullContent, fullLines, contentLines, lineOffset, taskItems, cache);
    const time = performance.now() - startTime;

    return { tasks, time };
  }

  private processHeadingsFeature(content: string, lines: string[], cache: CachedMetadata | null): {
    headings: IndexNoteData['headings'];
    time: number;
  } {
    if (!this.settings.enabledFeatures.indexHeadings) {
      return { headings: undefined, time: 0 };
    }

    const startTime = performance.now();

    const headings = cache?.headings?.map((heading: HeadingCache) => {
      const lineIndex = heading.position.start.line;
      const { start, end } = ContentLocationService.getLineOffsets(content, lineIndex);
      const anchorHash = ContentLocationService.computeAnchorHash(content, lineIndex, lines);

      let blockId: string | undefined;
      if (lineIndex < lines.length - 1) {
        const nextLineBlockMatch = lines[lineIndex + 1]?.match(/^\s*\^([\w-]+)\s*$/);
        if (nextLineBlockMatch) {
          blockId = nextLineBlockMatch[1];
        }
      }

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
      tag_name: tag.tag,
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

    let currentListIndex = 0;
    let lastRootLineNumber = -1;

    const lineNumberToItemIndex = new Map<number, number>();

    const nonTaskItems = cacheListItems
      .map((item, index) => ({ item, cacheIndex: index }))
      .filter(({ item }) => item.task === undefined);

    nonTaskItems.forEach(({ item, cacheIndex: _cacheIndex }, _arrayIndex) => {
      const lineIndex = item.position.start.line;
      const line = lines[lineIndex] || '';

      const isRootItem = item.parent < 0;

      if (isRootItem && lastRootLineNumber >= 0 && lineIndex - lastRootLineNumber > 1) {
        currentListIndex++;
      }
      if (isRootItem) {
        lastRootLineNumber = lineIndex;
      }

      const bulletMatch = line.match(/^(\s*)[-*+]\s/);
      const numberMatch = line.match(/^(\s*)\d+[.)]\s/);
      const listType: 'bullet' | 'number' = numberMatch ? 'number' : 'bullet';

      const leadingWhitespace = bulletMatch?.[1] || numberMatch?.[1] || '';
      let indentLevel = 0;
      for (const char of leadingWhitespace) {
        if (char === '\t') {
          indentLevel += 1;
        }
        else if (char === ' ') {
          // Accumulate spaces - every 2 spaces = 1 indent level
        }
      }
      // Add space-based indentation (2 spaces per level)
      const spaceCount = (leadingWhitespace.match(/ /g) || []).length;
      indentLevel += Math.floor(spaceCount / 2);

      let itemContent = '';
      if (bulletMatch) {
        itemContent = line.substring(line.indexOf(bulletMatch[0]) + bulletMatch[0].length);
      }
      else if (numberMatch) {
        itemContent = line.substring(line.indexOf(numberMatch[0]) + numberMatch[0].length);
      }
      else {
        const genericMatch = line.match(/^\s*(?:[-*+]|\d+[.)])\s*(.*)/);
        itemContent = genericMatch?.[1] || line.trim();
      }

      let blockId: string | undefined;
      const blockMatch = line.match(/\^([\w-]+)\s*$/);
      if (blockMatch) {
        blockId = blockMatch[1];
        itemContent = itemContent.replace(/\s*\^[\w-]+\s*$/, '');
      }
      else if (lineIndex < lines.length - 1) {
        const nextLineBlockMatch = lines[lineIndex + 1].match(/^\s*\^([\w-]+)\s*$/);
        if (nextLineBlockMatch) {
          blockId = nextLineBlockMatch[1];
        }
      }

      const startOffset = item.position.start.offset;
      const endOffset = item.position.end.offset;

      const anchorHash = ContentLocationService.computeAnchorHash(content, lineIndex, lines);

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

      // Map this item's line number to its index for child lookups
      lineNumberToItemIndex.set(lineIndex, listItems.length);

      const listItemData: ListItemData = {
        list_index: currentListIndex,
        item_index: listItems.length,
        parent_index: parentIndex,
        content: itemContent.trim(),
        list_type: listType,
        indent_level: indentLevel,
        line_number: lineIndex + 1, // 1-based
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
    const results: Array<{ 
      key: string; 
      value: string; 
      valueType: string; 
      arrayIndex: number | null 
    }> = [];
    
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = keyPrefix ? `${keyPrefix}.${key}` : key;
      
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          const valueType = typeof item;
          const valueString = item === null || item === undefined ? '' : 
                     typeof item === 'string' ? item : JSON.stringify(item);
          
          results.push({
            key: fullKey,
            value: valueString,
            valueType,
            arrayIndex: index
          });
        });
      }
      else if (typeof value === 'object' && value !== null) {
        results.push(...this.processFrontmatterProperties(value as Record<string, unknown>, fullKey));
      }
      else {
        const valueType = value === null || value === undefined ? 'null' : typeof value;
        const valueString = value === null || value === undefined ? '' : 
                   typeof value === 'string' ? value : JSON.stringify(value);
        
        results.push({
          key: fullKey,
          value: valueString,
          valueType,
          arrayIndex: null
        });
      }
    }
    
    return results;
  }

  private parseAndIndexTables(content: string, lineOffset: number, contentOffset: number, detectedTables: Array<{ table_index: number; table_name?: string; block_id?: string; start_offset: number; end_offset: number }>): TableCellData[] {
    const tableCells: TableCellData[] = [];
    const lines = content.split('\n');
    let fallbackTableIdx = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.includes('|') && line.split('|').length > 2) {
        const tableData = this.parseTableAt(lines, i);

        if (tableData.headers.length > 0 && tableData.rows.length > 0) {
          const tableStartOffset = ContentLocationService.getLineStartOffset(content, i) + contentOffset;

          const detectedTable = detectedTables.find(dt => Math.abs(dt.start_offset - tableStartOffset) < 10);

          const tableIndex = detectedTable?.table_index ?? fallbackTableIdx;
          fallbackTableIdx++;

          // table_name already resolved by MarkdownTableUtils (block_id > heading > noteTitle)
          const tableName = detectedTable?.table_name ?? null;

          tableData.rows.forEach((row, rowIndex) => {
            const dataRowLineNumber = i + 2 + rowIndex + lineOffset + 1;

            tableData.headers.forEach((columnName, columnIndex) => {
              const cellValue = row[columnIndex] || '';

              const cellData: TableCellData = {
                tableIndex,
                tableName,
                rowIndex,
                columnName,
                cellValue,
                lineNumber: dataRowLineNumber
              };

              tableCells.push(cellData);
            });
          });

          i += tableData.totalLines - 1;
        }
      }
    }

    return tableCells;
  }


  private parseTableAt(lines: string[], startIndex: number): { headers: string[], rows: string[][], totalLines: number } {
    const tableLines: string[] = [];
    let currentIndex = startIndex;
    
    while (currentIndex < lines.length) {
      const line = lines[currentIndex];
      if (line.includes('|') && line.split('|').length > 2) {
        tableLines.push(line);
        currentIndex++;
      }
      else {
        break;
      }
    }
    
    if (tableLines.length < 2) {
      return { headers: [], rows: [], totalLines: 0 };
    }
    
    let headerLineIndex = -1;
    let separatorLineIndex = -1;
    
    for (let i = 0; i < Math.min(3, tableLines.length); i++) {
      const line = tableLines[i];
      const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell !== '');
      
      const isSeparator = cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell));
      
      if (isSeparator) {
        separatorLineIndex = i;
      }
      else if (headerLineIndex === -1 && cells.length > 0) {
        headerLineIndex = i;
      }
    }
    
    if (headerLineIndex === -1) {
      return { headers: [], rows: [], totalLines: 0 };
    }
    
    const headers = tableLines[headerLineIndex].split('|')
      .map(cell => cell.trim())
      .filter(cell => cell !== '');
    
    const rows: string[][] = [];
    for (let i = 0; i < tableLines.length; i++) {
      if (i === headerLineIndex || i === separatorLineIndex) {
        continue;
      }
      
      const cells = tableLines[i].split('|')
        .map(cell => cell.trim())
        .filter(cell => cell !== '');
      
      const isSeparator = cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell));
      if (isSeparator) {
        continue;
      }
      
      if (cells.length > 0) {
        while (cells.length < headers.length) {
          cells.push('');
        }
        if (cells.length > headers.length) {
          cells.splice(headers.length);
        }
        rows.push(cells);
      }
    }
    
    return {
      headers,
      rows,
      totalLines: tableLines.length
    };
  }

  private parseTasksFromCache(fullContent: string, fullLines: string[], contentLines: string[], lineOffset: number, taskItems: ListItemCache[], cache: CachedMetadata | null): TaskData[] {
    const tasks: TaskData[] = [];

    const headingsByLine = new Map<number, string>();
    if (cache?.headings) {
      for (const heading of cache.headings) {
        headingsByLine.set(heading.position.start.line, heading.heading);
      }
    }

    const findSectionHeading = (lineIndex: number): string | undefined => {
      let lastHeading: string | undefined;
      for (const [headingLine, headingText] of headingsByLine) {
        if (headingLine < lineIndex) {
          lastHeading = headingText;
        }
        else {
          break;
        }
      }
      return lastHeading;
    };

    for (const item of taskItems) {
      const lineIndex = item.position.start.line;
      const line = fullLines[lineIndex] || '';
      const checkbox = item.task || ' ';

      let completed: boolean;
      let status: string;
      switch (checkbox.toLowerCase()) {
        case 'x':
          completed = true;
          status = 'DONE';
          break;
        case '/':
          completed = false;
          status = 'IN_PROGRESS';
          break;
        case '-':
          completed = false;
          status = 'CANCELLED';
          break;
        default:
          completed = false;
          status = 'TODO';
      }

      const taskTextMatch = line.match(/^\s*[-*+]\s*\[.\]\s*(.*)$/);
      const taskText = taskTextMatch ? taskTextMatch[1] : line;

      const { start, end } = ContentLocationService.getLineOffsets(fullContent, lineIndex);
      const anchorHash = ContentLocationService.computeAnchorHash(fullContent, lineIndex, fullLines);

      let blockId: string | undefined;
      const blockMatch = line.match(/\^([\w-]+)\s*$/);
      if (blockMatch) {
        blockId = blockMatch[1];
      }
      else if (lineIndex < fullLines.length - 1) {
        const nextLineBlockMatch = fullLines[lineIndex + 1]?.match(/^\s*\^([\w-]+)\s*$/);
        if (nextLineBlockMatch) {
          blockId = nextLineBlockMatch[1];
        }
      }

      const metadata = this.extractTaskMetadata(taskText);

      const taskData: TaskData = {
        line_number: lineIndex + 1, 
        task_text: taskText.trim(),
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
        section_heading: findSectionHeading(lineIndex)
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

    const recurrenceMatch = taskText.match(/🔁\s*([^📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🆔⛔🏁#]+)/);
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
    if (basename && basename !== '') {
      return basename;
    }
    
    if (path.includes('/')) {
      return path.substring(path.lastIndexOf('/') + 1).replace('.md', '');
    }
    else {
      return path.replace('.md', '');
    }
  }
  
  private deriveSize(statSize: number, content: string): number {
    if (statSize && statSize > 0) {
      return statSize;
    }

    return content ? content.length : 0;
  }

  private extractUserViews(content: string): UserViewData[] {
    const views: UserViewData[] = [];
    const viewBlockRegex = /```vaultquery-view\s*\n([\s\S]*?)```/g;
    let match;

    while ((match = viewBlockRegex.exec(content)) !== null) {
      const sql = match[1].trim();
      const viewNameMatch = sql.match(/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+AS/i);
      if (viewNameMatch) {
        views.push({
          view_name: viewNameMatch[1],
          sql: sql
        });
      }
    }

    return views;
  }

  private extractUserFunctions(content: string): UserFunctionData[] {
    const functions: UserFunctionData[] = [];
    const functionBlockRegex = /```vaultquery-function\s*\n([\s\S]*?)```/g;
    let match;

    while ((match = functionBlockRegex.exec(content)) !== null) {
      const blockContent = match[1].trim();
      const separatorIndex = blockContent.indexOf('\n---');
      
      if (separatorIndex > 0) {
        const functionName = blockContent.substring(0, separatorIndex).trim();
        const source = blockContent.substring(separatorIndex + 4).trim();
        if (functionName && source) {
          functions.push({
            function_name: functionName,
            source: source
          });
        }
      }
    }

    return functions;
  }

}