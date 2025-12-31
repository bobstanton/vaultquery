import { App, TFile, normalizePath } from 'obsidian';
import { SlickGridRenderer } from '../Renderers/SlickGridRenderer';
import type VaultQueryPlugin from '../main';

declare const activeWindow: Window;

export class IndexingStateManager {
  private indexingQueue: Set<string> = new Set();
  private indexingTimeout: number | null = null;
  private startupIndexingTimeout: number | null = null;
  private currentlyIndexingFiles: Set<string> = new Set();
  private fileModifyTimers: Map<string, number> = new Map();

  public constructor(private app: App, private plugin: VaultQueryPlugin) {}

  public isIndexing(): boolean {
    const serviceIsIndexing = this.plugin.api?.getIndexingStatus().isIndexing ?? false;
    return serviceIsIndexing || this.hasPendingFileModifications();
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
          console.error('[VaultQuery] Error indexing', filePath, error);
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
        void SlickGridRenderer.refreshAllGrids(indexedPaths);
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
      console.error(`[VaultQuery] Failed to index file ${file.path}:`, error);
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
    }, 100);

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
    if (!this.plugin.api) {
      return false;
    }

    return file instanceof TFile && file.extension === 'md' && this.plugin.api.shouldIndexFile(file);
  }

  public canProcessFiles(): boolean {
    if (!this.plugin.api) {
      return false;
    }

    const status = this.plugin.api.getIndexingStatus();
    return !status.isIndexing;
  }

  public async waitForIndexingComplete(maxWaitMs: number = 5000): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 50;

    while (this.hasPendingFileModifications()) {
      if (Date.now() - startTime > maxWaitMs) {
        console.warn('[VaultQuery] Timed out waiting for pending modifications');
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

    this.plugin.registerEvent(this.app.vault.on('create', (file) => { if (file instanceof TFile) this.handleFileCreate(file); }));
    this.plugin.registerEvent(this.app.vault.on('modify', (file) => { if (file instanceof TFile) this.handleFileModify(file); }));
    this.plugin.registerEvent(this.app.vault.on('delete', (file) => { if (file instanceof TFile) this.handleFileDelete(file); }));
    this.plugin.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (file instanceof TFile) this.handleFileRename(file, oldPath); }));
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
    if (file instanceof TFile && file.extension === 'md' && this.canProcessFiles()) {
      this.plugin.api?.removeNote(file.path);
    }
  }

  private handleFileRename(file: TFile, oldPath: string): void {
    if (file instanceof TFile && file.extension === 'md' && this.canProcessFiles()) {
      this.plugin.api?.removeNote(oldPath);
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
