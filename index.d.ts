/**
 * VaultQuery public API types for third-party plugin integration.
 *
 * Usage:
 *   npm install --save-dev github:bobstanton/vaultquery
 *
 *   import type { IVaultQueryAPI, QueryResult, PreviewResult } from 'vaultquery';
 */

import { TFile } from 'obsidian';

/**
 * Query result row - a record with string keys and SQL-compatible values.
 */
export interface QueryResult {
  [key: string]: string | number | boolean | null;
}

/**
 * Preview result from a DML operation (INSERT, UPDATE, DELETE).
 */
export interface PreviewResult {
  query: string;
  params: unknown[];
  tableName: string;
  operationType: 'INSERT' | 'UPDATE' | 'DELETE';
  beforeRows: QueryResult[];
  afterRows: QueryResult[];
  affectedRowCount: number;
}

/**
 * Event fired after a file has been indexed.
 */
export interface FileIndexedEvent {
  path: string;
  isUpdate: boolean;
}

/**
 * Event fired after a file has been removed from the index.
 */
export interface FileRemovedEvent {
  path: string;
}

/**
 * Event fired after vault indexing completes.
 */
export interface VaultIndexedEvent {
  filesIndexed: number;
  filesRemoved: number;
  isForced: boolean;
}

/**
 * Reference to an event subscription, used to unsubscribe.
 */
export interface EventRef {
  /** @internal */
  _id: number;
  /** @internal */
  _event: string;
}

/**
 * Indexing performance statistics.
 */
export interface IndexingStats {
  timestamp: number;
  totalFiles: number;
  totalTime: number;
  avgTimePerFile: number;
  filesPerSecond: number;
  slowFiles: Array<{
    path: string;
    size: number;
    processingTime: number;
    details: string;
  }>;
}

/**
 * A note can be referenced by its path (string) or by its TFile instance.
 */
export type NoteSource = string | TFile;

/**
 * The VaultQuery public API interface.
 */
export interface IVaultQueryAPI {
  /**
   * Execute a SQL query against the indexed vault.
   * @param sql - The SQL query to execute
   * @param noteSource - Optional TFile or path for {this.*} template variable substitution
   * @returns Array of query results
   */
  query(sql: string, noteSource?: NoteSource): Promise<QueryResult[]>;

  /**
   * Wait for indexing to complete.
   * Returns immediately if not indexing, otherwise resolves when done.
   */
  waitForIndexing(): Promise<void>;

  /**
   * Incremental re-indexing (only modified files).
   */
  reindexVault(): Promise<void>;

  /**
   * Full re-indexing (clears database and reindexes everything).
   */
  forceReindexVault(): Promise<void>;

  /**
   * Re-index a specific note.
   */
  reindexNote(notePath: string): Promise<void>;

  /**
   * Get current indexing status.
   */
  getIndexingStatus(): {
    isIndexing: boolean;
    progress?: { current: number; total: number; currentFile: string };
  };

  /**
   * Execute a SQL statement that doesn't return results (DDL, etc.)
   * @returns Number of rows affected
   */
  execute(sql: string): number;

  /**
   * Register a custom SQL function from JavaScript source code.
   */
  registerCustomFunction(name: string, source: string): void;

  /**
   * Preview a DML operation before applying it.
   * @param sql - The DML query (INSERT, UPDATE, DELETE)
   * @param params - Query parameters
   * @param noteSource - Optional TFile or path for template variables
   */
  previewQuery(sql: string, params?: unknown[], noteSource?: NoteSource): Promise<PreviewResult>;

  /**
   * Apply a previewed DML operation.
   * @returns Array of affected file paths
   */
  applyPreview(previewResult: PreviewResult): Promise<string[]>;

  /**
   * Get database schema as markdown.
   */
  getSchemaInfo(): string;

  /**
   * Get current plugin capabilities based on user settings.
   */
  getCapabilities(): {
    writeEnabled: boolean;
    fileDeleteEnabled: boolean;
    indexing: {
      content: boolean;
      frontmatter: boolean;
      tables: boolean;
      tasks: boolean;
      headings: boolean;
      links: boolean;
      tags: boolean;
      listItems: boolean;
    };
  };

  /**
   * Index a note (content will be read optimally using MetadataCache).
   */
  indexNote(file: TFile, content?: string): Promise<void>;

  /**
   * Remove a note from the index (does not delete the file).
   */
  removeNote(notePath: string): void;

  /**
   * Check if a file should be indexed based on settings.
   */
  shouldIndexFile(file: TFile): boolean;

  /**
   * Check if a file needs re-indexing.
   */
  needsIndexing(file: TFile): Promise<boolean>;

  /**
   * Get all indexed files with their metadata.
   */
  getIndexedFiles(): Promise<Array<{ path: string; modified: number }>>;

  /**
   * Rebuild dynamic table views.
   */
  rebuildTableViews(): void;

  /**
   * Get performance statistics from the last indexing operation.
   */
  getPerformanceStats(): IndexingStats | null;

  /**
   * Subscribe to file indexed events.
   */
  on(event: 'file-indexed', callback: (event: FileIndexedEvent) => void): EventRef;

  /**
   * Subscribe to file removed events.
   */
  on(event: 'file-removed', callback: (event: FileRemovedEvent) => void): EventRef;

  /**
   * Subscribe to vault indexed events.
   */
  on(event: 'vault-indexed', callback: (event: VaultIndexedEvent) => void): EventRef;

  /**
   * Unsubscribe from an event.
   */
  off(ref: EventRef): void;
}

/**
 * The VaultQuery plugin instance (for use with app.plugins.getPlugin).
 */
export interface VaultQueryPlugin {
  api: IVaultQueryAPI;
}
