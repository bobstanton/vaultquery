import { TFile } from 'obsidian';
import type { IndexingStats } from '../types';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('Performance');

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

  public startOperation(): void {
    this.operationStartTime = performance.now();
    this.currentSlowFiles = [];
  }

  public trackFile(file: TFile, totalTime: number, needsContentProcessing: boolean): void {
    if (totalTime <= PerformanceMonitor.SLOW_THRESHOLD_MS) {
      return;
    }

    const details = needsContentProcessing ? 'content+metadata' : 'metadata-only';

    this.currentSlowFiles.push({
      path: file.path,
      size: file.stat.size,
      processingTime: totalTime,
      details
    });

    if (totalTime > PerformanceMonitor.VERY_SLOW_THRESHOLD_MS) {
      this.logVerySlowFile(file, totalTime, details);
    }
  }

  public finishOperation(fileCount: number): IndexingStats {
    const totalTime = performance.now() - this.operationStartTime;

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

  public getLastStats(): IndexingStats | null {
    return this.lastStats;
  }

  private getTopSlowFiles(): IndexingStats['slowFiles'] {
    return [...this.currentSlowFiles]
      .sort((a, b) => b.processingTime - a.processingTime)
      .slice(0, PerformanceMonitor.MAX_SLOW_FILES);
  }

  private logVerySlowFile(file: TFile, totalTime: number, details: string): void {
    const sizeKB = (file.stat.size / 1024).toFixed(1);
    const timeMs = totalTime.toFixed(0);

    logger.warn(`Slow file: ${file.path} (${sizeKB}KB, ${timeMs}ms, ${details})`);
  }
}
