import { App, TFile } from 'obsidian';
import { VaultDatabase } from './Database/DatabaseService';
import { VaultQuerySettings, EnabledFeatures } from './Settings/Settings';
import { IndexingService } from './Services/IndexingService';
import { WriteSyncService } from './Services/WriteSyncService';
import { resolveQueryTemplate } from './Services/QueryTemplator';
import { getErrorMessage, ERROR_MESSAGES, CONSOLE_ERRORS } from './utils/ErrorMessages';
import type { IndexingStats, IndexingStatus, NoteSource } from './types';
import type { PreviewResult } from './Services/PreviewService';

export interface FileIndexedEvent {
  path: string;
  isUpdate: boolean;
}

export interface FileRemovedEvent {
  path: string;
}

export interface VaultIndexedEvent {
  filesIndexed: number;
  filesRemoved: number;
  isForced: boolean;
}

const TABLE_FEATURE_CONFIG: Record<string, {
  setting: keyof EnabledFeatures;
  featureName: string;
  settingLabel: string;
}> = {
  'properties': { setting: 'indexFrontmatter', featureName: 'Property indexing', settingLabel: 'Index frontmatter' },
  'notes_with_properties': { setting: 'indexFrontmatter', featureName: 'Property indexing', settingLabel: 'Index frontmatter' },
  'note_properties': { setting: 'indexFrontmatter', featureName: 'Property indexing', settingLabel: 'Index frontmatter' },
  'table_cells': { setting: 'indexTables', featureName: 'Table indexing', settingLabel: 'Index tables' },
  'table_rows': { setting: 'indexTables', featureName: 'Table indexing', settingLabel: 'Index tables' },
  'tasks': { setting: 'indexTasks', featureName: 'Task indexing', settingLabel: 'Index tasks' },
  'tasks_view': { setting: 'indexTasks', featureName: 'Task indexing', settingLabel: 'Index tasks' },
  'headings': { setting: 'indexHeadings', featureName: 'Heading indexing', settingLabel: 'Index headings' },
  'headings_view': { setting: 'indexHeadings', featureName: 'Heading indexing', settingLabel: 'Index headings' },
  'links': { setting: 'indexLinks', featureName: 'Link indexing', settingLabel: 'Index links' },
  'tags': { setting: 'indexTags', featureName: 'Tag indexing', settingLabel: 'Index tags' },
  'list_items': { setting: 'indexListItems', featureName: 'List item indexing', settingLabel: 'Index list items' },
  'list_items_view': { setting: 'indexListItems', featureName: 'List item indexing', settingLabel: 'Index list items' }
};


interface QueryResult {
  [key: string]: string | number | boolean | null;
}

export interface IVaultQueryAPI {
  /**
   * Execute a SQL query and return results.
   * Supports SELECT queries against all indexed tables (notes, properties, tasks, etc.).
   * Uses prepared statements with caching for performance.
   *
   * @param sql - The SQL query to execute
   * @param noteSource - Optional TFile or path for `{this.*}` template variable substitution
   * @returns Array of result rows as key-value objects
   *
   * @example
   * const results = await api.query('SELECT * FROM notes WHERE title LIKE ?', ['%Daily%']);
   * const withTemplate = await api.query('SELECT * FROM tasks WHERE path = {this.path}', currentFile);
   */
  query(sql: string, noteSource?: NoteSource): Promise<QueryResult[]>;

  /**
   * Incrementally reindex the vault.
   * Compares file modification times (mtime) against indexed values to determine
   * which files need reindexing. Only processes files that have changed since
   * last indexed, and removes files that no longer exist.
   *
   * This is the standard reindex method - use forceReindexVault() to rebuild from scratch.
   */
  reindexVault(): Promise<void>;

  /**
   * Force a complete vault reindex from scratch.
   * Clears all indexed data and reindexes every markdown file in the vault.
   * Use this when the index may be corrupted or out of sync.
   *
   * Note: This is slower than reindexVault() as it doesn't use incremental updates.
   */
  forceReindexVault(): Promise<void>;

  /**
   * Reindex a single note by its path.
   * Reads the file content and updates all indexed data for that note.
   *
   * @param notePath - The vault-relative path to the note (e.g., "folder/note.md")
   * @throws Error if the file doesn't exist or isn't a markdown file
   */
  reindexNote(notePath: string): Promise<void>;

  /**
   * Get the current indexing status.
   * Returns whether indexing is in progress and the current progress if so.
   *
   * @returns Object with `isIndexing` boolean and optional `progress` with current/total/currentFile
   */
  getIndexingStatus(): IndexingStatus;

  /**
   * Wait for indexing to complete.
   * Returns immediately if indexing is not in progress.
   * Otherwise returns a promise that resolves when indexing finishes.
   *
   * Third-party plugins should call this before querying if they need
   * complete data rather than partial results during initial indexing.
   *
   * @param timeoutMs - Optional timeout in milliseconds. If provided, resolves after timeout even if indexing is still in progress.
   * @example
   * // Ensure indexing is complete before querying
   * await api.waitForIndexing();
   * const results = await api.query('SELECT * FROM notes');
   */
  waitForIndexing(timeoutMs?: number): Promise<void>;

  /**
   * Remove a note from the index without deleting the file.
   * Deletes all indexed data (properties, tasks, headings, etc.) for this note
   * from the database. The file remains on disk.
   *
   * @param notePath - Path to the note to remove from index
   */
  removeNote(notePath: string): void;

  /**
   * Get all indexed files with their modification timestamps.
   * Queries the notes table for path and modified columns.
   * The modified value is the file's mtime in milliseconds when it was last indexed.
   *
   * Useful for comparing against current file mtimes to detect stale indexes.
   *
   * @returns Array of objects with path and modified timestamp (ms since epoch)
   */
  getIndexedFiles(): Promise<Array<{ path: string; modified: number }>>;

  /**
   * Check if a file needs (re)indexing.
   * Compares the file's current modification time (file.stat.mtime) against
   * the stored modified timestamp in the database. Returns true if:
   * - The file is not in the index at all
   * - The file's mtime differs from the indexed mtime
   *
   * @param file - The TFile to check
   * @returns true if the file needs indexing, false if index is up-to-date
   */
  needsIndexing(file: TFile): Promise<boolean>;

  /**
   * Index a single note file.
   * Extracts and stores all configured data (content, frontmatter, tasks, etc.)
   * based on enabled features in settings. Uses Obsidian's MetadataCache for
   * optimal parsing when content is not provided.
   *
   * @param file - The TFile to index
   * @param content - Optional pre-read content (if not provided, reads via cachedRead)
   */
  indexNote(file: TFile, content?: string): Promise<void>;

  /**
   * Get database schema information formatted as markdown tables.
   * Returns documentation of all tables, views, columns, and their types.
   * Used by the vaultquery-schema code block processor.
   *
   * @returns Markdown string with table definitions
   */
  getSchemaInfo(): string;

  /**
   * Check if a file should be indexed based on plugin settings.
   * Returns false if:
   * - File size exceeds maxFileSizeKB setting
   * - File path matches any excludePatterns regex
   *
   * Does not check if the file is already indexed or up-to-date.
   *
   * @param file - The TFile to check
   * @returns true if the file passes all filter criteria
   */
  shouldIndexFile(file: TFile): boolean;

  /**
   * Get performance statistics from the last indexing operation.
   * Includes timing breakdowns for each feature (tasks, headings, etc.),
   * file counts, and total duration.
   *
   * @returns Statistics object or null if no indexing has occurred
   */
  getPerformanceStats(): IndexingStats | null;

  /**
   * Rebuild dynamic table views based on current table_cells data.
   * Discovers unique column structures across all indexed markdown tables
   * and creates SQL views for each structure. View names are derived from
   * table_name values (block_id > heading > note title).
   *
   * Called automatically after reindexing when enableDynamicTableViews is true.
   */
  rebuildTableViews(): void;

  /**
   * Execute a SQL statement that doesn't return results.
   * Supports DDL statements (CREATE VIEW, CREATE INDEX, DROP VIEW, etc.)
   * and DML statements (INSERT, UPDATE, DELETE) when write operations are enabled.
   *
   * Note: Standard DML should use previewQuery/applyPreview for bidirectional sync.
   *
   * @param sql - The SQL statement to execute
   * @returns Number of rows affected (0 for DDL statements)
   */
  execute(sql: string): number;

  /**
   * Get current plugin capabilities based on user settings.
   * Useful for third-party plugins to check what features are available
   * before attempting operations that require them.
   *
   * @returns Object describing enabled features and permissions
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
   * Register a custom SQL function from JavaScript source code.
   * The function becomes available in all SQL queries after registration.
   * Overwrites any existing function with the same name.
   *
   * @param name - The function name to use in SQL (case-insensitive)
   * @param source - JavaScript function source code as a string
   *
   * @example
   * api.registerCustomFunction('double', '(x) => x * 2');
   * // Then use in SQL: SELECT double(size) FROM notes
   */
  registerCustomFunction(name: string, source: string): void;

  /**
   * Preview DML operations before applying them.
   * Executes the query in a transaction, captures before/after states,
   * then rolls back. Returns a preview showing what would change.
   *
   * Use applyPreview() to actually apply the changes after user confirmation.
   *
   * @param sql - The DML query to preview (INSERT, UPDATE, DELETE)
   * @param params - Optional parameters for the query
   * @param noteSource - Optional TFile or path for `{this.*}` template variable substitution
   * @returns Preview result with before/after states and affected rows
   */
  previewQuery(sql: string, params?: unknown[], noteSource?: NoteSource): Promise<PreviewResult>;

  /**
   * Apply a previewed DML operation to the database and sync to vault files.
   * Uses the EditPlanner to generate file edits, then WriteSyncService
   * to apply them atomically. Triggers reindexing of affected files.
   *
   * @param previewResult - The preview result from previewQuery
   * @returns Array of file paths that were modified
   */
  applyPreview(previewResult: PreviewResult): Promise<string[]>;

  /**
   * Subscribe to file indexed events.
   * Fired after a file has been indexed and the database is up-to-date for that file.
   *
   * @param callback - Called with event data when a file is indexed
   * @returns EventRef to use with off() for unsubscribing
   *
   * @example
   * const ref = api.on('file-indexed', (event) => {
   *   console.log(`File indexed: ${event.path}`);
   *   // Safe to query this file's data now
   * });
   * // Later: api.off(ref);
   */
  on(event: 'file-indexed', callback: (event: FileIndexedEvent) => void): EventRef;

  /**
   * Subscribe to file removed events.
   * Fired after a file has been removed from the index.
   */
  on(event: 'file-removed', callback: (event: FileRemovedEvent) => void): EventRef;

  /**
   * Subscribe to vault indexed events.
   * Fired after a full or incremental vault reindex completes.
   */
  on(event: 'vault-indexed', callback: (event: VaultIndexedEvent) => void): EventRef;

  /**
   * Unsubscribe from an event
   * @param ref - The EventRef returned from on()
   */
  off(ref: EventRef): void;

}

/**
 * Reference to an event subscription, used to unsubscribe
 */
export interface EventRef {
  /** @internal */
  _id: number;
  /** @internal */
  _event: string;
}

export class VaultQueryAPI implements IVaultQueryAPI {
  private app: App;
  private database: VaultDatabase;
  private indexingService: IndexingService;
  private writeSyncService: WriteSyncService;

  // Event emitter state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private eventListeners: Map<string, Map<number, (event: any) => void>> = new Map();
  private nextEventId = 1;

  private constructor(app: App, private settings: VaultQuerySettings, database: VaultDatabase, indexingService: IndexingService, writeSyncService: WriteSyncService) {
    this.app = app;
    this.database = database;
    this.indexingService = indexingService;
    this.writeSyncService = writeSyncService;

    // Initialize event listener maps
    this.eventListeners.set('file-indexed', new Map());
    this.eventListeners.set('file-removed', new Map());
    this.eventListeners.set('vault-indexed', new Map());

    // Connect IndexingService events to our emitter
    this.indexingService.setEventEmitter({
      emitFileIndexed: (path: string, isUpdate: boolean) => {
        this.emit('file-indexed', { path, isUpdate });
      },
      emitFileRemoved: (path: string) => {
        this.emit('file-removed', { path });
      },
      emitVaultIndexed: (filesIndexed: number, filesRemoved: number, isForced: boolean) => {
        this.emit('vault-indexed', { filesIndexed, filesRemoved, isForced });
      }
    });
  }

  public static async create(app: App, settings: VaultQuerySettings): Promise<VaultQueryAPI> {
    const useMemoryStorage = settings.databaseStorage === 'memory';

    // File adapter for database persistence (null if memory-only)
    const fileAdapter = useMemoryStorage ? null : {
      readBinary: (path: string) => app.vault.adapter.readBinary(path),
      writeBinary: (path: string, data: ArrayBuffer) => app.vault.adapter.writeBinary(path, data),
      exists: (path: string) => app.vault.adapter.exists(path),
      mkdir: (path: string) => app.vault.adapter.mkdir(path)
    };

    // Adapter for loading WASM (always needed, even for memory mode)
    const wasmAdapter = {
      readBinary: (path: string) => app.vault.adapter.readBinary(path),
      writeBinary: (path: string, data: ArrayBuffer) => app.vault.adapter.writeBinary(path, data),
      exists: (path: string) => app.vault.adapter.exists(path),
      mkdir: (path: string) => app.vault.adapter.mkdir(path)
    };

    const pluginDir = `${app.vault.configDir}/plugins/vaultquery`;
    const database = await VaultDatabase.create(app, app.vault.configDir, fileAdapter, useMemoryStorage, undefined, pluginDir, wasmAdapter, settings.wasm);

    const indexingService = new IndexingService(app, database, settings);
    const writeSyncService = new WriteSyncService(app, database, settings);

    return new VaultQueryAPI(app, settings, database, indexingService, writeSyncService);
  }

  public async reindexVault(): Promise<void> {
    return this.indexingService.reindexVault();
  }

  public async forceReindexVault(): Promise<void> {
    return this.indexingService.forceReindexVault();
  }

  public async reindexNote(notePath: string): Promise<void> {
    return this.indexingService.reindexNote(notePath);
  }

  public async indexNote(file: TFile, content?: string): Promise<void> {
    return this.indexingService.indexNote(file, content);
  }

  public getIndexingStatus(): IndexingStatus {
    return this.indexingService.getIndexingStatus();
  }

  public async waitForIndexing(timeoutMs?: number): Promise<void> {
    return this.indexingService.waitForIndexing(timeoutMs);
  }

  public setIndexingStatus(isIndexing: boolean, promise?: Promise<void>): void {
    this.indexingService.setIndexingStatus(isIndexing, promise);
  }

  public removeNote(notePath: string): void {
    this.indexingService.removeNote(notePath);
  }

  public clearAllNotes(): void {
    this.indexingService.clearAllNotes();
  }

  public async saveToDisk(): Promise<void> {
    return this.database.saveToDisk();
  }

  public shouldIndexFile(file: TFile): boolean {
    return this.indexingService.shouldIndexFile(file);
  }

  public getPerformanceStats(): IndexingStats | null {
    return this.indexingService.getPerformanceStats();
  }

  public rebuildTableViews(): void {
    this.database.rebuildTableViews(this.settings.enableDynamicTableViews);
  }

  public execute(sql: string): number {
    // Allow DDL operations (CREATE INDEX, CREATE VIEW, etc.) through execute()
    if (this.containsBlockedSQL(sql, true)) {
      throw new Error(ERROR_MESSAGES.QUERY_UNSAFE_OPERATIONS);
    }
    return this.database.run(sql);
  }

  public getCapabilities(): {
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
  } {
    return {
      writeEnabled: this.settings.allowWriteOperations,
      fileDeleteEnabled: this.settings.allowDeleteNotes,
      indexing: {
        content: this.settings.enabledFeatures.indexContent,
        frontmatter: this.settings.enabledFeatures.indexFrontmatter,
        tables: this.settings.enabledFeatures.indexTables,
        tasks: this.settings.enabledFeatures.indexTasks,
        headings: this.settings.enabledFeatures.indexHeadings,
        links: this.settings.enabledFeatures.indexLinks,
        tags: this.settings.enabledFeatures.indexTags,
        listItems: this.settings.enabledFeatures.indexListItems,
      },
    };
  }

  public registerCustomFunction(name: string, source: string): void {
    this.database.registerCustomFunction(name, source);
  }

  /**
   * Get all user-defined views from the database.
   * These are discovered from vaultquery-view code blocks during indexing.
   */
  public getAllUserViews(): Array<{view_name: string; path: string; sql: string}> {
    return this.database.getAllUserViews();
  }

  /**
   * Get all user-defined functions from the database.
   * These are discovered from vaultquery-function code blocks during indexing.
   */
  public getAllUserFunctions(): Array<{function_name: string; path: string; source: string}> {
    return this.database.getAllUserFunctions();
  }

  public async query(sql: string, noteSource?: NoteSource): Promise<QueryResult[]> {
    if (noteSource) {
      sql = await resolveQueryTemplate(sql, this.app, noteSource);
    }

    if (this.containsBlockedSQL(sql, false)) {
      throw new Error(ERROR_MESSAGES.QUERY_UNSAFE_OPERATIONS);
    }

    const unindexedDataWarning = this.checkForUnindexedData(sql);
    if (unindexedDataWarning) {
      throw new Error(unindexedDataWarning);
    }

    // Don't wait for indexing - queries can run with partial data
    // Users see results immediately and can refresh after indexing completes

    return this.executeQuerySafely(() => this.database.all(sql), sql) as Promise<QueryResult[]>;
  }


  public async getIndexedFiles(): Promise<Array<{ path: string; modified: number }>> {
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

  public async needsIndexing(file: TFile): Promise<boolean> {
    try {
      const results = await this.database.all('SELECT modified FROM notes WHERE path = ?', [file.path]);
      if (results.length > 0) {
        const dbModified = results[0].modified as number;
        return file.stat.mtime !== dbModified;
      }
      else {
        return true;
      }
    }
    catch (error) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.NEEDS_INDEXING_CHECK_ERROR}:`, error);
      return true;
    }
  }

  public async close(): Promise<void> {
    await this.database.close();
  }

  public getSchemaInfo(): string {
    const sections: string[] = [];

    // Helper to create a markdown table with optional Default column
    const makeTable = (tableName: string, columns: Array<{ name: string; type: string; description: string; defaultVal?: string }>, isView = false): string => {
      const header = `### ${tableName}${isView ? ' (VIEW)' : ''}\n\n`;
      const hasDefaults = columns.some(c => c.defaultVal);
      const tableHeader = hasDefaults
        ? '| Column | Type | Default | Description |\n|--------|------|---------|-------------|\n'
        : '| Column | Type | Description |\n|--------|------|-------------|\n';
      const rows = columns.map(c => hasDefaults
        ? `| \`${c.name}\` | ${c.type} | ${c.defaultVal || ''} | ${c.description} |`
        : `| \`${c.name}\` | ${c.type} | ${c.description} |`
      ).join('\n');
      return header + tableHeader + rows + '\n';
    };

    // notes table (always available)
    sections.push(makeTable('notes', [
      { name: 'path', type: 'TEXT', description: 'File path (primary key)' },
      { name: 'title', type: 'TEXT', description: 'Note name (filename without extension)' },
      { name: 'content', type: 'TEXT', description: 'Full text content' },
      { name: 'created', type: 'INTEGER', description: 'Creation timestamp (ms)' },
      { name: 'modified', type: 'INTEGER', description: 'Last modified timestamp (ms)' },
      { name: 'size', type: 'INTEGER', description: 'File size in bytes' },
    ]));

    if (this.settings.enabledFeatures.indexFrontmatter) {
      sections.push(makeTable('properties', [
        { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
        { name: 'key', type: 'TEXT', description: 'Property name' },
        { name: 'value', type: 'TEXT', description: 'Property value as string' },
        { name: 'value_type', type: 'TEXT', description: 'Type: string, number, boolean, array, object' },
        { name: 'array_index', type: 'INTEGER', description: 'Array index (NULL for scalar values)' },
      ]));

      // notes_with_properties view with actual columns
      const viewColumns = this.database.getViewColumns('notes_with_properties');
      if (viewColumns.length > 0) {
        const viewCols = viewColumns.map(col => ({
          name: col,
          type: ['path', 'title', 'content'].includes(col) ? 'TEXT' :
                ['created', 'modified', 'size'].includes(col) ? 'INTEGER' : 'TEXT',
          description: ['path', 'title', 'content', 'created', 'modified', 'size'].includes(col)
            ? '(from notes)' : '(property column)',
        }));
        sections.push(makeTable('notes_with_properties', viewCols, true) +
          '\n> Supports INSERT, UPDATE, DELETE (syncs to frontmatter)\n');
      }

      // note_properties view (properties only, no notes columns)
      const notePropsColumns = this.database.getViewColumns('note_properties');
      if (notePropsColumns.length > 0) {
        const notePropsViewCols = notePropsColumns.map(col => ({
          name: col,
          type: 'TEXT',
          description: col === 'path' ? 'File path' : '(property column)',
        }));
        sections.push(makeTable('note_properties', notePropsViewCols, true) +
          '\n> Properties only (no notes columns). Supports INSERT (existing notes only), UPDATE, DELETE.\n');
      }
    }

    if (this.settings.enabledFeatures.indexTasks) {
      sections.push(makeTable('tasks', [
        { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
        { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
        { name: 'task_text', type: 'TEXT', description: 'Task content' },
        { name: 'status', type: 'TEXT', description: 'TODO, DONE, IN_PROGRESS, CANCELLED' },
        { name: 'priority', type: 'TEXT', description: 'highest, high, medium, low, lowest' },
        { name: 'due_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'scheduled_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'start_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'created_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'done_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'cancelled_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'recurrence', type: 'TEXT', description: 'Recurrence rule' },
        { name: 'on_completion', type: 'TEXT', description: 'Action on completion' },
        { name: 'task_id', type: 'TEXT', description: 'Unique task identifier' },
        { name: 'depends_on', type: 'TEXT', description: 'Task dependencies' },
        { name: 'tags', type: 'TEXT', description: 'Space-separated tags' },
        { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
        { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
        { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
        { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
        { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
        { name: 'section_heading', type: 'TEXT', description: 'Parent heading text' },
      ]));

      sections.push(makeTable('tasks_view', [
        { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
        { name: 'path', type: 'TEXT', description: 'File path' },
        { name: 'task_text', type: 'TEXT', description: 'Task content' },
        { name: 'status', type: 'TEXT', defaultVal: 'TODO', description: 'TODO, DONE, IN_PROGRESS, CANCELLED' },
        { name: 'priority', type: 'TEXT', description: 'highest, high, medium, low, lowest' },
        { name: 'due_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'scheduled_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'start_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'created_date', type: 'TEXT', defaultVal: 'today', description: 'YYYY-MM-DD format' },
        { name: 'done_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'cancelled_date', type: 'TEXT', description: 'YYYY-MM-DD format' },
        { name: 'recurrence', type: 'TEXT', description: 'Recurrence rule' },
        { name: 'on_completion', type: 'TEXT', description: 'Action on completion' },
        { name: 'task_id', type: 'TEXT', description: 'Unique task identifier' },
        { name: 'depends_on', type: 'TEXT', description: 'Task dependencies' },
        { name: 'tags', type: 'TEXT', description: 'Space-separated tags' },
        { name: 'line_number', type: 'INTEGER', defaultVal: 'auto', description: 'After last task line, or line 1 if no tasks' },
        { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
        { name: 'section_heading', type: 'TEXT', description: 'Parent heading text' },
        { name: 'status_order', type: 'INTEGER', description: 'Sort order for status (computed)' },
        { name: 'priority_order', type: 'INTEGER', description: 'Sort order for priority (computed)' },
        { name: 'is_complete', type: 'INTEGER', description: '1 if DONE/CANCELLED (computed)' },
        { name: 'is_overdue', type: 'INTEGER', description: '1 if past due (computed)' },
        { name: 'days_until_due', type: 'INTEGER', description: 'Days until due date (computed)' },
      ], true) + '\n> Supports INSERT, UPDATE, DELETE. When no tasks exist, new tasks insert at line 1 (beginning of file).\n');
    }

    if (this.settings.enabledFeatures.indexHeadings) {
      sections.push(makeTable('headings', [
        { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
        { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
        { name: 'level', type: 'INTEGER', description: 'Heading level (1-6)' },
        { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
        { name: 'heading_text', type: 'TEXT', description: 'Heading content' },
        { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
        { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
        { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
        { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
      ]));

      sections.push(makeTable('headings_view', [
        { name: 'path', type: 'TEXT', description: 'File path' },
        { name: 'level', type: 'INTEGER', defaultVal: '1', description: 'Heading level (1-6)' },
        { name: 'line_number', type: 'INTEGER', defaultVal: 'auto', description: 'After last heading line, or line 1 if no headings' },
        { name: 'heading_text', type: 'TEXT', description: 'Heading content' },
        { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
        { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
        { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
        { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
      ], true) + '\n> Supports INSERT, UPDATE, DELETE. When no headings exist, new headings insert at line 1 (beginning of file).\n');
    }

    if (this.settings.enabledFeatures.indexTags) {
      sections.push(makeTable('tags', [
        { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
        { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
        { name: 'tag_name', type: 'TEXT', description: 'Tag name (with # prefix)' },
        { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
      ]));
    }

    if (this.settings.enabledFeatures.indexLinks) {
      sections.push(makeTable('links', [
        { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
        { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
        { name: 'link_text', type: 'TEXT', description: 'Display text' },
        { name: 'link_target', type: 'TEXT', description: 'Target path or URL' },
        { name: 'link_target_path', type: 'TEXT', description: 'Resolved target file path' },
        { name: 'link_type', type: 'TEXT', description: 'internal or external' },
        { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
      ]));
    }

    if (this.settings.enabledFeatures.indexListItems) {
      sections.push(makeTable('list_items', [
        { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
        { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
        { name: 'list_index', type: 'INTEGER', description: 'List group index (0-based)' },
        { name: 'item_index', type: 'INTEGER', description: 'Item index within file' },
        { name: 'parent_index', type: 'INTEGER', description: 'Parent item index' },
        { name: 'content', type: 'TEXT', description: 'List item text' },
        { name: 'list_type', type: 'TEXT', description: 'bullet or number' },
        { name: 'indent_level', type: 'INTEGER', description: 'Nesting depth (0 = top)' },
        { name: 'line_number', type: 'INTEGER', description: 'Line number (1-based)' },
        { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
        { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
        { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
        { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
      ]));

      sections.push(makeTable('list_items_view', [
        { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
        { name: 'path', type: 'TEXT', description: 'File path' },
        { name: 'list_index', type: 'INTEGER', defaultVal: '0', description: 'List group index' },
        { name: 'item_index', type: 'INTEGER', defaultVal: 'auto', description: 'MAX(item_index)+1 or 0 if none exist' },
        { name: 'parent_index', type: 'INTEGER', description: 'Parent item index' },
        { name: 'content', type: 'TEXT', description: 'List item text' },
        { name: 'list_type', type: 'TEXT', defaultVal: 'bullet', description: 'bullet or number' },
        { name: 'indent_level', type: 'INTEGER', defaultVal: '0', description: 'Nesting depth' },
        { name: 'line_number', type: 'INTEGER', defaultVal: 'auto', description: 'After last item line, or line 1 if no items' },
        { name: 'block_id', type: 'TEXT', description: 'Block reference ID' },
        { name: 'start_offset', type: 'INTEGER', description: 'Character offset start' },
        { name: 'end_offset', type: 'INTEGER', description: 'Character offset end' },
        { name: 'anchor_hash', type: 'TEXT', description: 'Content hash for change detection' },
        { name: 'parent_content', type: 'TEXT', description: 'Parent item text (computed)' },
      ], true) + '\n> Supports INSERT, UPDATE, DELETE. When no list items exist, new items insert at line 1 (beginning of file).\n');
    }

    if (this.settings.enabledFeatures.indexTables) {
      sections.push(makeTable('table_cells', [
        { name: 'id', type: 'INTEGER', description: 'Auto-incrementing ID' },
        { name: 'path', type: 'TEXT', description: 'File path (foreign key)' },
        { name: 'table_index', type: 'INTEGER', description: 'Table index (0-based)' },
        { name: 'table_name', type: 'TEXT', description: 'Table name from heading or block ID' },
        { name: 'row_index', type: 'INTEGER', description: 'Row index (0-based)' },
        { name: 'column_name', type: 'TEXT', description: 'Column header' },
        { name: 'cell_value', type: 'TEXT', description: 'Cell content' },
        { name: 'value_type', type: 'TEXT', description: 'Value type (default: text)' },
        { name: 'line_number', type: 'INTEGER', description: 'Line number' },
      ]));

      sections.push(makeTable('table_rows', [
        { name: 'path', type: 'TEXT', description: 'File path' },
        { name: 'table_index', type: 'INTEGER', description: 'Table index' },
        { name: 'row_index', type: 'INTEGER', defaultVal: 'auto', description: 'MAX(row_index)+1 or 0 if none exist' },
        { name: 'row_json', type: 'TEXT', description: 'Row data as JSON object' },
      ], true) + '\n> Supports INSERT, UPDATE, DELETE\n');
    }

    // Dynamic views section - show each view with its columns
    const views = this.database.getViewNames();
    const builtInViews = ['notes_with_properties', 'headings_view', 'list_items_view', 'tasks_view', 'table_rows', 'table_columns', 'note_properties'];
    const dynamicViews = views.filter(v => !builtInViews.includes(v));
    if (dynamicViews.length > 0) {
      sections.push('## Dynamic Table Views\n');
      sections.push('> These views are auto-generated from markdown tables in the vault. Enable "Dynamic table views" in settings.\n');
      for (const viewName of dynamicViews) {
        const viewColumns = this.database.getViewColumns(viewName);
        if (viewColumns.length > 0) {
          const viewCols = viewColumns.map(col => ({
            name: col,
            type: ['path', 'table_name'].includes(col) ? 'TEXT' :
                  ['table_index', 'row_index'].includes(col) ? 'INTEGER' : 'TEXT',
            description: ['path', 'table_index', 'row_index', 'table_name'].includes(col)
              ? '(metadata)' : '(table column)',
          }));
          sections.push(makeTable(viewName, viewCols, true) + '\n> Supports INSERT, UPDATE, DELETE\n');
        }
      }
    }

    // Disabled features
    const disabledFeatures: string[] = [];
    if (!this.settings.enabledFeatures.indexFrontmatter) disabledFeatures.push('properties');
    if (!this.settings.enabledFeatures.indexTables) disabledFeatures.push('table_cells');
    if (!this.settings.enabledFeatures.indexTasks) disabledFeatures.push('tasks');
    if (!this.settings.enabledFeatures.indexHeadings) disabledFeatures.push('headings');
    if (!this.settings.enabledFeatures.indexLinks) disabledFeatures.push('links');
    if (!this.settings.enabledFeatures.indexTags) disabledFeatures.push('tags');
    if (!this.settings.enabledFeatures.indexListItems) disabledFeatures.push('list_items');
    if (disabledFeatures.length > 0) {
      sections.push(`\n> [!note] Disabled Tables\n> ${disabledFeatures.join(', ')} - enable in Settings → VaultQuery\n`);
    }

    return sections.join('\n');
  }

  private stripSQLComments(sql: string): string {
    return sql
      .replace(/--.*$/gm, '') 
      .replace(/\/\*[\s\S]*?\*\//g, '') 
      .trim();
  }

  private async executeQuerySafely<T>(operation: () => Promise<T>, query: string): Promise<T> {
    try {
      return await operation();
    }
    catch (error: unknown) {
      const friendlyError = this.getFriendlyErrorMessage(getErrorMessage(error), query);
      throw new Error(friendlyError);
    }
  }

  private getFriendlyErrorMessage(errorMessage: string, _query: string): string {
    if (errorMessage.includes('no such table')) {
      const tableMatch = errorMessage.match(/no such table: (\w+)/);
      if (tableMatch) {
        const tableName = tableMatch[1].toLowerCase();
        const config = TABLE_FEATURE_CONFIG[tableName];

        if (config && !this.settings.enabledFeatures[config.setting]) {
          return `${errorMessage}\n\nNote: ${config.featureName} is disabled. Enable it in Settings → VaultQuery → ${config.settingLabel}`;
        }
      }
    }

    return errorMessage;
  }

  private checkForUnindexedData(sql: string): string | null {
    const tableNames = this.getReferencedTables(sql);

    const warnings = Object.entries(TABLE_FEATURE_CONFIG)
      .filter(([table, config]) =>
        tableNames.has(table) && !this.settings.enabledFeatures[config.setting])
      .map(([table, config]) =>
        `${table.charAt(0).toUpperCase() + table.slice(1)} table is referenced but ${config.featureName.toLowerCase()} is disabled. Enable it in Settings → VaultQuery → ${config.settingLabel}`
      );

    return warnings.length > 0 ? warnings.join('\n\n') : null;
  }

  private getReferencedTables(sql: string): Set<string> {
    const tableMatches = sql.match(/(?:FROM|JOIN)\s+(\w+)/gi);
    if (!tableMatches) return new Set();

    return tableMatches
      .map(match => match.replace(/(?:FROM|JOIN)\s+/i, '').toLowerCase())
      .reduce((set, name) => set.add(name), new Set<string>());
  }

  public async previewQuery(sql: string, params: unknown[] = [], noteSource?: NoteSource): Promise<PreviewResult> {
    if (noteSource) {
      sql = await resolveQueryTemplate(sql, this.app, noteSource);
    }

    if (this.containsBlockedSQL(sql, true)) {
      throw new Error(ERROR_MESSAGES.PREVIEW_UNSAFE_OPERATIONS);
    }

    if (!this.settings.allowWriteOperations) {
      throw new Error(ERROR_MESSAGES.WRITE_OPERATIONS_DISABLED);
    }

    // Don't wait for indexing - previews are read-only (they rollback)
    // and can work with partial data

    try {
      return await this.database.previewDML(sql, params);
    }
    catch (error: unknown) {
      // Don't log syntax errors to console - they're expected during editing
      throw new Error(ERROR_MESSAGES.PREVIEW_FAILED(getErrorMessage(error)));
    }
  }

  public async applyPreview(previewResult: PreviewResult): Promise<string[]> {
    if (!this.settings.allowWriteOperations) {
      throw new Error(ERROR_MESSAGES.WRITE_OPERATIONS_DISABLED_APPLY);
    }

    // Don't wait for indexing - user clicked Apply on an already-generated preview
    // The preview data is already captured; just apply it

    let affectedPaths: string[] = [];
    try {
      affectedPaths = await this.writeSyncService.syncChanges(previewResult);
      await this.database.applyDML(previewResult);
    }
    catch (error: unknown) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.APPLY_PREVIEW_FAILED}:`, error);
      throw new Error(ERROR_MESSAGES.APPLY_FAILED(getErrorMessage(error)));
    }

    return affectedPaths;
  }

  private containsBlockedSQL(sql: string, allowWriteOperations: boolean = false): boolean {
    const sqlWithoutComments = this.stripSQLComments(sql);

    const alwaysBlocked = [
      /ATTACH\s+DATABASE/i,
      /PRAGMA/i,
      /\.load/i,
      /\.shell/i,
      /\.system/i,
      /LOAD_EXTENSION/i
    ];

    const writeOperations = [
      /DROP\s+TABLE/i,
      /ALTER\s+TABLE/i,
      /CREATE\s+TABLE/i,
      /CREATE\s+INDEX/i,
      /DROP\s+INDEX/i,
      /CREATE\s+VIEW/i,
      /DROP\s+VIEW/i
    ];

    if (alwaysBlocked.some(pattern => pattern.test(sqlWithoutComments))) {
      return true;
    }

    if (!allowWriteOperations && writeOperations.some(pattern => pattern.test(sqlWithoutComments))) {
      return true;
    }

    return false;
  }

  // Event emitter methods

  public on(event: 'file-indexed', callback: (event: FileIndexedEvent) => void): EventRef;
  public on(event: 'file-removed', callback: (event: FileRemovedEvent) => void): EventRef;
  public on(event: 'vault-indexed', callback: (event: VaultIndexedEvent) => void): EventRef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public on(event: string, callback: (event: any) => void): EventRef {
    const listeners = this.eventListeners.get(event);
    if (!listeners) {
      throw new Error(`Unknown event: ${event}`);
    }

    const id = this.nextEventId++;
    listeners.set(id, callback);

    return { _id: id, _event: event };
  }

  public off(ref: EventRef): void {
    const listeners = this.eventListeners.get(ref._event);
    if (listeners) {
      listeners.delete(ref._id);
    }
  }

  private emit(event: string, data: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const callback of listeners.values()) {
        try {
          callback(data);
        }
        catch (error) {
          console.error(`[VaultQuery] Error in event listener for '${event}':`, error);
        }
      }
    }
  }

}