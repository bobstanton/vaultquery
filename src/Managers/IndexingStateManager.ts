import { App, TFile, normalizePath, type TAbstractFile } from 'obsidian';
import { QueryRefreshRegistry } from '../Renderers/QueryRefreshRegistry';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { logger as rootLogger } from '../utils/logger';

declare const activeWindow: Window;

/** Debounce time for file modifications (ms) - balances responsiveness vs redundant indexing */
const FILE_MODIFY_DEBOUNCE_MS = 300;
const logger = rootLogger.scope('Indexing');

function isVaultFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile;
}

export class IndexingStateManager {
  private indexingQueue: Set<string> = new Set();
  private indexingTimeout: number | null = null;
  private startupIndexingTimeout: number | null = null;
  private currentlyIndexingFiles: Set<string> = new Set();
  private fileModifyTimers: Map<string, number> = new Map();

  public constructor(private app: App, private plugin: VaultQueryPluginContext) {}

  public isIndexing(): boolean {
    return (this.plugin.api?.getIndexingStatus().isIndexing ?? false) || this.hasPendingFileModifications();
  }

  public hasPendingFileModifications(): boolean {
    return this.fileModifyTimers.size > 0 || this.indexingQueue.size > 0 || this.indexingTimeout !== null;
  }

  public queueIndexing(filePath: string): void {
    this.indexingQueue.add(filePath);

    if (this.indexingTimeout) {
      activeWindow.clearTimeout(this.indexingTimeout);
    }

    this.indexingTimeout = activeWindow.setTimeout(() => {
      this.indexingTimeout = null;

      if (!this.plugin.api) return;
      void this.processIndexingQueue();
    }, 200);
  }

  private async processIndexingQueue(): Promise<void> {
    if (this.indexingQueue.size === 0) {
      return;
    }

    const filesToIndex = Array.from(this.indexingQueue);
    this.indexingQueue.clear();

    const indexedPaths: string[] = [];

    for (const filePath of filesToIndex) {
      if (this.currentlyIndexingFiles.has(filePath)) {
        continue;
      }

      const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
      if (file && file instanceof TFile && file.extension === 'md') {
        try {
          this.currentlyIndexingFiles.add(filePath);
          await this.indexFile(file);
          indexedPaths.push(filePath);
        }
        catch (error) {
          logger.error('Error indexing', filePath, error);
        } finally {
          this.currentlyIndexingFiles.delete(filePath);
        }
      }
    }

    if (indexedPaths.length > 0 && this.plugin.api) {
      await this.plugin.api.saveToDisk();

      if (this.plugin.settings.enableDynamicTableViews) {
        this.plugin.api.rebuildTableViews();
      }

      if (this.plugin.settings.autoRefreshOnIndexChange) {
        void QueryRefreshRegistry.refreshAll(indexedPaths);
      }
    }
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
      activeWindow.clearTimeout(existingTimer);
    }

    const timer = activeWindow.setTimeout(() => {
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
      activeWindow.clearTimeout(this.startupIndexingTimeout);
      this.startupIndexingTimeout = null;
    }
  }

  public isFileBeingIndexed(filePath: string): boolean {
    return this.currentlyIndexingFiles.has(filePath);
  }

  public shouldProcessFile(file: TFile): boolean {
    return !!this.plugin.api && file.extension === 'md' && this.plugin.api.shouldIndexFile(file);
  }

  public canProcessFiles(): boolean {
    return !!this.plugin.api && !this.plugin.api.getIndexingStatus().isIndexing;
  }

  public async waitForIndexingComplete(maxWaitMs: number = 5000): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 50;

    while (this.hasPendingFileModifications()) {
      if (Date.now() - startTime > maxWaitMs) {
        logger.warn('Timed out waiting for pending modifications');
        return;
      }
      await new Promise(resolve => activeWindow.setTimeout(resolve, checkInterval));
    }

    const remainingTime = maxWaitMs - (Date.now() - startTime);
    if (remainingTime > 0 && this.plugin.api) {
      await this.plugin.api.waitForIndexing(remainingTime);
    }
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

  private handleFileCreate(file: TFile): void {
    if (!this.canProcessFiles()) {
      return;
    }

    if (this.shouldProcessFile(file)) {
      this.queueIndexing(file.path);
    }
  }

  private handleFileModify(file: TFile): void {
    if (!this.canProcessFiles()) {
      return;
    }

    if (!this.shouldProcessFile(file)) {
      return;
    }

    this.queueFileModification(file);
  }

  private handleFileDelete(file: TFile): void {
    if (file.extension === 'md' && this.canProcessFiles()) {
      void this.plugin.api?.removeNote(file.path);
    }
  }

  private handleFileRename(file: TFile, oldPath: string): void {
    if (file.extension === 'md' && this.canProcessFiles()) {
      void this.plugin.api?.removeNote(oldPath);
      if (this.plugin.api?.shouldIndexFile(file)) {
        this.queueIndexing(file.path);
      }
    }
  }

  public cleanup(): void {
    if (this.indexingTimeout) {
      activeWindow.clearTimeout(this.indexingTimeout);
      this.indexingTimeout = null;
    }

    this.clearStartupIndexingTimeout();

    for (const timer of this.fileModifyTimers.values()) {
      activeWindow.clearTimeout(timer);
    }
    this.fileModifyTimers.clear();

    this.indexingQueue.clear();

    this.currentlyIndexingFiles.clear();
  }
}
