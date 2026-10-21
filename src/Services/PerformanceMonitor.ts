import type { IndexingStats } from '../types';

export interface FilePreparationTiming {
  path: string;
  bytes: number;
  totalMs: number;
  readWaitMs: number;
  providerWaitMs: number;
  frontmatterMs: number;
  featuresMs: number;
}

type SlowFileEntry = IndexingStats['slowFiles'][number];

export class PerformanceMonitor {
  public static readonly SLOW_THRESHOLD_MS = 25;
  private static readonly MAX_SLOW_FILES = 10;

  private lastStats: IndexingStats | null = null;
  private currentSlowFiles: SlowFileEntry[] = [];
  private operationStartTime: number = 0;

  public startOperation(): void {
    this.operationStartTime = performance.now();
    this.currentSlowFiles = [];
  }

  public trackFile(timing: FilePreparationTiming): void {
    if (timing.totalMs <= PerformanceMonitor.SLOW_THRESHOLD_MS) return;

    this.currentSlowFiles.push({
      path: timing.path, size: timing.bytes, processingTime: timing.totalMs,
      details: `Read wait ${Math.round(timing.readWaitMs)}ms; provider wait ${Math.round(timing.providerWaitMs)}ms; frontmatter ${Math.round(timing.frontmatterMs)}ms; features ${Math.round(timing.featuresMs)}ms`,
    });

    this.currentSlowFiles.sort((a, b) => b.processingTime - a.processingTime);
    this.currentSlowFiles.length = Math.min(this.currentSlowFiles.length, PerformanceMonitor.MAX_SLOW_FILES);
  }

  public finishOperation(fileCount: number): IndexingStats {
    const totalTime = performance.now() - this.operationStartTime;

    this.lastStats = {
      timestamp: Date.now(),
      totalFiles: fileCount,
      totalTime,
      avgTimePerFile: fileCount > 0 ? totalTime / fileCount : 0,
      filesPerSecond: fileCount > 0 ? (fileCount / totalTime) * 1000 : 0,
      slowFiles: [...this.currentSlowFiles]
    };

    return this.lastStats;
  }

  public getLastStats(): IndexingStats | null {
    return this.lastStats;
  }
}
