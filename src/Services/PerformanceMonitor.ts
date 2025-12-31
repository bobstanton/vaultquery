import { TFile } from 'obsidian';
import { PERFORMANCE_MESSAGES } from '../utils/ErrorMessages';
import type { IndexingStats } from '../types';

export interface IndexingTimings {
  fmTime: number;
  frontmatterTime: number;
  tablesTime: number;
  tasksTime: number;
  headingsTime: number;
  linksTime: number;
  tagsTime: number;
  listItemsTime: number;
}

interface SlowFileEntry {
  path: string;
  size: number;
  processingTime: number;
  details: string;
}

export class PerformanceMonitor {
  private static readonly SLOW_THRESHOLD_MS = 25;
  private static readonly VERY_SLOW_THRESHOLD_MS = 100;
  private static readonly MAX_SLOW_FILES = 10;

  private lastStats: IndexingStats | null = null;
  private currentSlowFiles: SlowFileEntry[] = [];
  private operationStartTime: number = 0;
  private totalFilesProcessed: number = 0;

  public startOperation(): void {
    this.operationStartTime = performance.now();
    this.currentSlowFiles = [];
    this.totalFilesProcessed = 0;
  }

  public trackFile(file: TFile, startTime: number, timings: IndexingTimings, needsContentProcessing: boolean): void {
    const totalTime = performance.now() - startTime;
    this.totalFilesProcessed++;

    if (totalTime <= PerformanceMonitor.SLOW_THRESHOLD_MS) {
      return;
    }

    const detailedInfo = this.buildDetailedInfo(timings, needsContentProcessing);

    this.currentSlowFiles.push({
      path: file.path,
      size: file.stat.size,
      processingTime: totalTime,
      details: detailedInfo
    });

    if (totalTime > PerformanceMonitor.VERY_SLOW_THRESHOLD_MS) {
      this.logVerySlowFile(file, totalTime, needsContentProcessing);
    }
  }

  public finishOperation(totalFilesProcessed?: number): IndexingStats {
    const totalTime = performance.now() - this.operationStartTime;
    const fileCount = totalFilesProcessed ?? this.totalFilesProcessed;

    this.lastStats = {
      timestamp: Date.now(),
      totalFiles: fileCount,
      totalTime,
      avgTimePerFile: fileCount > 0 ? totalTime / fileCount : 0,
      filesPerSecond: fileCount > 0 ? (fileCount / totalTime) * 1000 : 0,
      slowFiles: this.getTopSlowFiles()
    };

    return this.lastStats;
  }

  public reset(): void {
    this.currentSlowFiles = [];
    this.totalFilesProcessed = 0;
    this.operationStartTime = 0;
  }

  public getLastStats(): IndexingStats | null {
    return this.lastStats;
  }

  public isSlowFile(processingTimeMs: number): boolean {
    return processingTimeMs > PerformanceMonitor.SLOW_THRESHOLD_MS;
  }

  public getSlowThreshold(): number {
    return PerformanceMonitor.SLOW_THRESHOLD_MS;
  }

  public getVerySlowThreshold(): number {
    return PerformanceMonitor.VERY_SLOW_THRESHOLD_MS;
  }

  private buildDetailedInfo(timings: IndexingTimings, needsContentProcessing: boolean): string {
    if (!needsContentProcessing) {
      return 'metadata-only';
    }

    return `content+metadata (fm: ${timings.fmTime.toFixed(1)}ms, frontmatter: ${timings.frontmatterTime.toFixed(1)}ms, tables: ${timings.tablesTime.toFixed(1)}ms, tasks: ${timings.tasksTime.toFixed(1)}ms, headings: ${timings.headingsTime.toFixed(1)}ms, links: ${timings.linksTime.toFixed(1)}ms, tags: ${timings.tagsTime.toFixed(1)}ms, listItems: ${timings.listItemsTime.toFixed(1)}ms)`;
  }

  private getTopSlowFiles(): IndexingStats['slowFiles'] {
    return [...this.currentSlowFiles]
      .sort((a, b) => b.processingTime - a.processingTime)
      .slice(0, PerformanceMonitor.MAX_SLOW_FILES);
  }

  private logVerySlowFile(file: TFile, totalTime: number, needsContentProcessing: boolean): void {
    const sizeKB = (file.stat.size / 1024).toFixed(1);
    const timeMs = totalTime.toFixed(0);
    const details = needsContentProcessing ? 'content+metadata' : 'metadata-only';

    console.warn(
      `🐌 [VaultQuery] ${PERFORMANCE_MESSAGES.SLOW_FILE(file.path, sizeKB, timeMs, details)}`
    );
  }
}
