import initSqlJs, { Database, Statement } from 'sql.js';
import { App } from 'obsidian';
import { getDatabaseDir, getDatabasePath } from '../Settings/Settings';
import type { WasmSettings } from '../Settings/Settings';
import { PreviewService } from '../Services/PreviewService';
import { getTablesOnlySQL, getIndexesForFeatures, EnabledFeatures } from './DatabaseSchema';
import { CustomSQLFunctions } from './CustomSQLFunctions';
import { DatabaseSchemaManager } from './DatabaseSchemaManager';
import { getErrorMessage, ERROR_MESSAGES, WARNING_MESSAGES, CONSOLE_ERRORS } from '../utils/ErrorMessages';
import type { IndexNoteData, DatabaseTableCell, NoteRecord, ListItemData, TaskData } from '../types';
import type { PreviewResult } from '../Services/PreviewService';

const CDN_URL = 'https://sql.js.org/dist/sql-wasm.wasm';
const DEFAULT_WASM_FILENAME = 'sql-wasm.wasm';

export interface VaultFileAdapter {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

declare const activeWindow: Window;

export class VaultDatabase {
  private db: Database;
  private fileAdapter: VaultFileAdapter | null;
  private databasePath: string;
  private configDir: string;
  public readonly useMemoryStorage: boolean;

  private preparedStatements = new Map<string, Statement>();
  private previewService: PreviewService;
  private schemaManager: DatabaseSchemaManager;

  private txDepth = 0;

  private dbLock: Promise<void> = Promise.resolve();
  private indexesCreated = false;
  private enabledFeatures: EnabledFeatures | null = null;

  private constructor(db: Database, fileAdapter: VaultFileAdapter | null, useMemoryStorage: boolean, databasePath: string, configDir: string) {
    this.db = db;
    this.fileAdapter = fileAdapter;
    this.useMemoryStorage = useMemoryStorage;
    this.databasePath = databasePath;
    this.configDir = configDir;
    this.previewService = new PreviewService(db);
    this.schemaManager = new DatabaseSchemaManager(db);
  }

  /**
   * Load WASM binary based on settings
   * @returns Object with wasmBinary (or undefined) and whether it came from CDN
   */
  private static async loadWasmBinary(
    adapter: VaultFileAdapter | null,
    pluginDir: string | undefined,
    wasmSettings?: WasmSettings
  ): Promise<{ wasmBinary: ArrayBuffer | undefined; fromCdn: boolean }> {
    const source = wasmSettings?.source ?? 'auto';
    const customPath = wasmSettings?.customPath;

    // Determine the local path to try
    const getLocalPath = (): string | null => {
      if (customPath) return customPath;
      if (pluginDir) return `${pluginDir}/${DEFAULT_WASM_FILENAME}`;
      return null;
    };

    // Try to load from local file
    const tryLoadLocal = async (): Promise<ArrayBuffer | null> => {
      const localPath = getLocalPath();
      if (!localPath || !adapter) return null;

      try {
        return await adapter.readBinary(localPath);
      }
      catch {
        return null;
      }
    };

    // Load from CDN
    const loadFromCdn = async (): Promise<ArrayBuffer> => {
      const response = await fetch(CDN_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM from CDN: ${response.status} ${response.statusText}`);
      }
      return await response.arrayBuffer();
    };

    switch (source) {
      case 'local': {
        const localBinary = await tryLoadLocal();
        if (!localBinary) {
          const localPath = getLocalPath();
          throw new Error(`WASM source is set to 'local' but file not found at: ${localPath || '(no path configured)'}`);
        }
        return { wasmBinary: localBinary, fromCdn: false };
      }

      case 'cdn': {
        const cdnBinary = await loadFromCdn();
        return { wasmBinary: cdnBinary, fromCdn: true };
      }

      case 'auto':
      default: {
        // Try local first, then fall back to CDN
        const localBinary = await tryLoadLocal();
        if (localBinary) {
          return { wasmBinary: localBinary, fromCdn: false };
        }

        // Fall back to CDN - fetch ourselves so we can cache it
        try {
          const cdnBinary = await loadFromCdn();
          return { wasmBinary: cdnBinary, fromCdn: true };
        }
        catch {
          // If CDN fetch fails, return undefined and let initSqlJs try its own mechanism
          return { wasmBinary: undefined, fromCdn: false };
        }
      }
    }
  }

  public static async create(app: App, configDir: string, fileAdapter: VaultFileAdapter | null = null, useMemoryStorage: boolean = true, databasePath?: string, pluginDir?: string, wasmAdapter?: VaultFileAdapter, wasmSettings?: WasmSettings): Promise<VaultDatabase> {
    const actualDatabasePath = databasePath || getDatabasePath(configDir);
    const adapter = wasmAdapter || fileAdapter;

    const { wasmBinary, fromCdn } = await VaultDatabase.loadWasmBinary(
      adapter,
      pluginDir,
      wasmSettings
    );

    // Cache the WASM locally if it was loaded from CDN and caching is enabled
    if (fromCdn && wasmBinary && wasmSettings?.cacheLocally && adapter && pluginDir) {
      try {
        const cachePath = `${pluginDir}/${DEFAULT_WASM_FILENAME}`;
        await adapter.writeBinary(cachePath, wasmBinary);
        console.debug('[VaultQuery] Cached WASM binary to:', cachePath);
      }
      catch (error) {
        console.warn('[VaultQuery] Failed to cache WASM binary:', getErrorMessage(error));
      }
    }

    const sqlJs = await initSqlJs({
      wasmBinary,
      locateFile: wasmBinary ? undefined : (() => CDN_URL)
    });

    let db: Database;

    if (useMemoryStorage || !(fileAdapter && await fileAdapter.exists(actualDatabasePath))) {
      db = new sqlJs.Database();
    }
    else {
      try {
        const data = await fileAdapter.readBinary(actualDatabasePath);
        db = new sqlJs.Database(new Uint8Array(data));
      }
      catch (error) {
        throw new Error(ERROR_MESSAGES.DATABASE_READ_FAILED(actualDatabasePath, error instanceof Error ? error.message : 'Unknown error'));
      }
    }

    const instance = new VaultDatabase(db, fileAdapter, useMemoryStorage, actualDatabasePath, configDir);

    instance.runPragmaStatements();
    CustomSQLFunctions.register(db, app);
    instance.createSchema();

    try {
      instance.db.run('PRAGMA optimize');
    }
    catch (error) {
      console.warn(`[VaultQuery] ${WARNING_MESSAGES.PRAGMA_OPTIMIZE_UNAVAILABLE}:`, error);
    }

    return instance;
  }
  
  public async saveToDisk(): Promise<void> {
    if (this.useMemoryStorage || !this.fileAdapter) return;

    try {
      const array = this.db.export();
      const databaseDir = getDatabaseDir(this.configDir);
      if (!(await this.fileAdapter.exists(databaseDir))) {
        await this.fileAdapter.mkdir(databaseDir);
      }
      
      const ab = array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength);
      await this.fileAdapter.writeBinary(this.databasePath, ab as ArrayBuffer);
    }
    catch (error) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.DATABASE_SAVE_FAILED}:`, error);
    }
  }
  
  
  private runPragmaStatements(): void {
    try {
      this.db.run('PRAGMA journal_mode = MEMORY');
      this.db.run('PRAGMA synchronous = OFF');
      this.db.run('PRAGMA cache_size = -64000');  // 64MB cache (negative = KB)
      this.db.run('PRAGMA temp_store = MEMORY');
      this.db.run('PRAGMA locking_mode = EXCLUSIVE');
      this.db.run('PRAGMA page_size = 4096');
      this.db.run('PRAGMA mmap_size = 268435456');  // 256MB memory-mapped I/O
    }
    catch (error) {
      console.warn(`[VaultQuery] ${WARNING_MESSAGES.DATABASE_OPTIMIZATIONS_UNAVAILABLE}:`, error);
    }
  }

  public async acquireDbLock(): Promise<() => void> {
    let releaseLock: () => void;
    const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
    const previousLock = this.dbLock;
    this.dbLock = lockPromise;
    await previousLock;
    return releaseLock!;
  }

  public async withTx<T>(fn: () => T | Promise<T>, opts: { deferFK?: boolean } = {}): Promise<T> {
    const needsLock = this.txDepth === 0;
    let releaseLock: (() => void) | undefined;

    if (needsLock) {
      releaseLock = await this.acquireDbLock();
    }

    const nested = this.txDepth > 0;
    const sp = `sp_${this.txDepth + 1}`;

    this.txDepth++;
    try {
      if (!nested) {
        this.db.run('BEGIN TRANSACTION');
        if (opts.deferFK) {
          this.db.exec('PRAGMA defer_foreign_keys = ON');
        }
      }
      else {
        this.db.exec(`SAVEPOINT ${sp}`);
      }

      const result = await fn();

      if (!nested) {
        if (opts.deferFK) {
          this.db.exec('PRAGMA defer_foreign_keys = OFF');
        }
        this.db.run('COMMIT');
      }
      else {
        this.db.exec(`RELEASE ${sp}`);
      }

      return result;
    }
    catch (error) {
      if (!nested) {
        try {
          this.db.run('ROLLBACK');
        }
        catch (rollbackError) {
          console.error(`[VaultQuery] ${CONSOLE_ERRORS.DATABASE_ROLLBACK_FAILED}:`, rollbackError);
        }
      }
      else {
        try {
          this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        }
        catch (rollbackError) {
          console.error(`[VaultQuery] ${CONSOLE_ERRORS.DATABASE_SAVEPOINT_ROLLBACK_FAILED}:`, rollbackError);
        }
      }
      throw error;
    } finally {
      this.txDepth--;
      if (releaseLock) {
        releaseLock();
      }
    }
  }

  private getPreparedStatement(sql: string): Statement {
    if (!this.preparedStatements.has(sql)) {
      try {
        const stmt = this.db.prepare(sql);
        this.preparedStatements.set(sql, stmt);
      }
      catch (error: unknown) {
        throw new Error(getErrorMessage(error) || ERROR_MESSAGES.SQL_PREPARE_FAILED);
      }
    }

    const stmt = this.preparedStatements.get(sql);
    if (!stmt) {
      throw new Error(ERROR_MESSAGES.SQL_STATEMENT_NOT_FOUND);
    }
    return stmt;
  }

  private cleanupPreparedStatements(): void {
    for (const [, stmt] of this.preparedStatements) {
      try {
        stmt.free();
      }
      catch (error) {
        console.warn(`[VaultQuery] ${WARNING_MESSAGES.STATEMENT_FREE_ERROR}:`, error);
      }
    }
    this.preparedStatements.clear();
  }

  private execSchemaBundle(sql: string): void {
    this.db.run('BEGIN');
    try {
      this.db.run('PRAGMA foreign_keys = ON;');
      this.db.exec(sql);
      this.db.run('COMMIT');
    }
    catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  private createSchema(): void {
    this.execSchemaBundle(getTablesOnlySQL());
    this.indexesCreated = false;
  }

  public createIndexes(features?: EnabledFeatures): void {
    if (features) {
      this.enabledFeatures = features;
    }

    if (this.indexesCreated) return;

    try {
      const effectiveFeatures = this.enabledFeatures ?? {
        indexContent: true,
        indexFrontmatter: true,
        indexTables: true,
        indexTasks: true,
        indexHeadings: true,
        indexLinks: true,
        indexTags: true,
        indexListItems: true
      };
      this.execSchemaBundle(getIndexesForFeatures(effectiveFeatures));
      this.indexesCreated = true;
    }
    catch (error) {
      console.warn('[VaultQuery] Error creating indexes (may already exist):', error);
      this.indexesCreated = true; 
    }
  }

  public async indexNote(data: IndexNoteData): Promise<void> {
    this.createIndexes();
    return this.withTx(() => this.performIndexingOperations(data, false));
  }

  private performIndexingOperations = (data: IndexNoteData, skipDeletes: boolean): void => {
    const { note, frontmatterData, tables, tableCells, tasks, headings, links, tags, listItems, userViews, userFunctions } = data;

    this.insertNote(note);

    if (frontmatterData !== undefined) {
      this.replaceProperties(note.path, frontmatterData, skipDeletes);
    }
    if (tables !== undefined) {
      this.replaceTables(note.path, tables, skipDeletes);
    }
    if (tableCells !== undefined) {
      this.replaceTableCells(note.path, tableCells, skipDeletes);
    }
    if (tasks !== undefined) {
      this.replaceTasks(note.path, tasks, skipDeletes);
    }
    if (headings !== undefined) {
      this.replaceHeadings(note.path, headings, skipDeletes);
    }
    if (links !== undefined) {
      this.replaceLinks(note.path, links, skipDeletes);
    }
    if (tags !== undefined) {
      this.replaceTags(note.path, tags, skipDeletes);
    }
    if (listItems !== undefined) {
      this.replaceListItems(note.path, listItems, skipDeletes);
    }

    this.replaceUserViews(note.path, userViews, skipDeletes);
    this.replaceUserFunctions(note.path, userFunctions, skipDeletes);
  };

  private insertNote = (note: NoteRecord): void => {
    const insertNoteSQL = 'INSERT OR REPLACE INTO notes (path, title, content, created, modified, size) VALUES (?, ?, ?, ?, ?, ?)';
    this.runWithPreparedStatement(insertNoteSQL, [note.path, note.title, note.content, note.created, note.modified, note.size]);
  };

  private replaceProperties = (path: string, propertiesData?: Array<{key: string; value: string; valueType: string; arrayIndex: number | null}>, skipDeletes: boolean = false): void => {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM properties WHERE path = ?', [path]);
    }

    if (propertiesData?.length) {
      const insertSQL = 'INSERT INTO properties (path, key, value, value_type, array_index) VALUES (?, ?, ?, ?, ?)';
      for (const property of propertiesData) {
        try {
          this.runWithPreparedStatement(insertSQL, [
            path,
            property.key,
            property.value,
            property.valueType,
            property.arrayIndex
          ]);
        }
        catch (error: unknown) {
          console.warn(`[VaultQuery] ${WARNING_MESSAGES.DUPLICATE_PROPERTY_SKIPPED(path, property.key, property.arrayIndex)}`, getErrorMessage(error));
        }
      }
    }
  };

  private replaceTableCells = (path: string, tableCells?: DatabaseTableCell[], skipDeletes: boolean = false): void => {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM table_cells WHERE path = ?', [path]);
    }

    if (tableCells?.length) {
      const rows = tableCells.map(cell => [path, cell.tableIndex, cell.tableName, cell.rowIndex, cell.columnName, cell.cellValue, 'string', cell.lineNumber]);
      this.runMultiRowInsert('INSERT INTO table_cells (path, table_index, table_name, row_index, column_name, cell_value, value_type, line_number) VALUES ', 8, rows);
    }
  };


  private replaceLinks = (path: string, links?: Array<{link_text: string; link_target: string; link_target_path: string | null; link_type: string; line_number: number}>, skipDeletes: boolean = false): void => {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM links WHERE path = ?', [path]);
    }

    if (links?.length) {
      const rows = links.map(link => [path, link.link_text, link.link_target, link.link_target_path, link.link_type, link.line_number]);
      this.runMultiRowInsert('INSERT INTO links (path, link_text, link_target, link_target_path, link_type, line_number) VALUES ', 6, rows);
    }
  };

  private replaceTags = (path: string, tags?: Array<{tag_name: string; line_number: number}>, skipDeletes: boolean = false): void => {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM tags WHERE path = ?', [path]);
    }

    if (tags?.length) {
      const rows = tags.map(tag => [path, tag.tag_name, tag.line_number]);
      this.runMultiRowInsert('INSERT INTO tags (path, tag_name, line_number) VALUES ', 3, rows);
    }
  };

  public run(sql: string, params: (string | number | null)[] = []): number {
    this.db.run(sql, params);
    return this.db.getRowsModified();
  }

  public registerCustomFunction(name: string, source: string): void {
    const fn = new Function(`return (${source})`)();

    if (typeof fn !== 'function') {
      throw new Error(`Invalid function definition: expected a function, got ${typeof fn}`);
    }

    this.db.create_function(name, fn);
  }

  public async all(sql: string, params: (string | number | null)[] = []): Promise<Record<string, unknown>[]> {
    try {
      const stmt = this.getPreparedStatement(sql);

      try {
        if (params.length > 0) {
          stmt.bind(params);
        }

        const results: Record<string, unknown>[] = [];
        const columnNames = stmt.getColumnNames();

        while (stmt.step()) {
          // Use custom object building instead of getAsObject() to handle duplicate column names
          // With "first wins" behavior - important for LEFT JOINs where left table columns come first
          const values = stmt.get();
          const row: Record<string, unknown> = {};
          for (let i = 0; i < columnNames.length; i++) {
            const colName = columnNames[i];
            // Only set if this column name hasn't been seen yet (first wins)
            if (!(colName in row)) {
              row[colName] = values[i];
            }
          }
          results.push(row);
        }
        stmt.reset();

        if (results.length > 1000) {
          await new Promise(resolve => activeWindow.setTimeout(resolve, 0));
        }

        return results;
      }
      catch (error) {
        try {
          stmt.reset();
        }
        catch (resetError) {
          console.warn(`[VaultQuery] ${WARNING_MESSAGES.STATEMENT_RESET_ERROR}:`, resetError);
        }
        throw error;
      }
    }
    catch (error: unknown) {
      throw new Error(ERROR_MESSAGES.SQL_QUERY_FAILED(getErrorMessage(error)));
    }
  }

  public runWithPreparedStatement(sql: string, params: (string | number | null)[] = []): void {
    try {
      const stmt = this.getPreparedStatement(sql);

      try {
        if (params.length > 0) {
          stmt.bind(params);
        }
        stmt.step();
        stmt.reset();
      }
      catch (error) {
        try {
          stmt.reset();
        }
        catch (resetError) {
          console.warn(`[VaultQuery] ${WARNING_MESSAGES.STATEMENT_RESET_ERROR}:`, resetError);
        }
        throw error;
      }
    }
    catch (error: unknown) {
      throw new Error(ERROR_MESSAGES.SQL_RUN_FAILED(getErrorMessage(error)));
    }
  }

  private runMultiRowInsert(baseSQL: string, columnsCount: number, rows: (string | number | null)[][], maxRowsPerBatch: number = 100): void {
    if (rows.length === 0) return;

    const placeholder = `(${Array(columnsCount).fill('?').join(', ')})`;

    for (let i = 0; i < rows.length; i += maxRowsPerBatch) {
      const batch = rows.slice(i, i + maxRowsPerBatch);
      const values = Array(batch.length).fill(placeholder).join(', ');
      const sql = baseSQL + values;
      const params = batch.flat();

      this.db.run(sql, params);
    }
  }

  public async indexNotesBatch(notesData: IndexNoteData[], isInitialIndexing: boolean = false, skipDiskSave: boolean = false): Promise<void> {
    if (notesData.length === 0) return;

    if (isInitialIndexing) {
      this.db.run('PRAGMA foreign_keys = OFF');
    }

    try {
      await this.withTx(() => this.performBatchIndexing(notesData, isInitialIndexing));
    } finally {
      if (isInitialIndexing) {
        this.db.run('PRAGMA foreign_keys = ON');
      }
    }

    if (isInitialIndexing) {
      try {
        this.db.run('ANALYZE');
      }
      catch (error) {
        console.warn('[VaultQuery] ANALYZE failed after batch indexing:', error);
      }
    }

    if (!skipDiskSave) {
      await this.saveToDisk();
    }
  }

  private performBatchIndexing = (notesData: IndexNoteData[], skipDeletes: boolean = false): void => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const data of notesData) {
      if (seen.has(data.note.path)) {
        duplicates.push(data.note.path);
      }
      else {
        seen.add(data.note.path);
      }
    }

    if (duplicates.length > 0) {
      console.warn(`[VaultQuery] ${WARNING_MESSAGES.DUPLICATE_NOTES_IN_BATCH(duplicates.length, duplicates)}`);
    }

    notesData.forEach(data => this.performIndexingOperations(data, skipDeletes));
  };

  public async previewDML(sql: string, params: unknown[] = []): Promise<PreviewResult> {
    const releaseLock = await this.acquireDbLock();
    try {
      return this.previewService.previewDmlFromSql(sql, params);
    } finally {
      releaseLock();
    }
  }

  public async applyDML(previewResult: PreviewResult): Promise<void> {
    return this.withTx(() => {
      this.applyDMLWithoutTransaction(previewResult);
    });
  }

  private applyDMLWithoutTransaction(previewResult: PreviewResult): void {
    for (const { sql, params } of previewResult.sqlToApply) {
      const stmt = this.db.prepare(sql);
      try {
        stmt.run(params as (string | number | null)[] || []);
      } finally {
        stmt.free();
      }
    }
  }

  public async close(): Promise<boolean> {
    try {
      await this.saveToDisk();

      this.cleanupPreparedStatements();

      if (typeof this.db.close === 'function') {
        this.db.close();
      }

      return true;
    }
    catch (error) {
      console.error(`[VaultQuery] ${CONSOLE_ERRORS.DATABASE_CLOSE_ERROR}:`, error);
      return false;
    }
  }

  private replaceTables(path: string, tables: Array<{ table_index: number; table_name?: string; block_id?: string; start_offset: number; end_offset: number }>, skipDeletes: boolean = false): void {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM tables WHERE path = ?', [path]);
    }

    if (tables?.length) {
      const rows = tables.map(table => [path, table.table_index, table.table_name || null, table.block_id || null, table.start_offset, table.end_offset]);
      this.runMultiRowInsert('INSERT INTO tables (path, table_index, table_name, block_id, start_offset, end_offset) VALUES ', 6, rows);
    }
  }

  private replaceTasks(path: string, tasks: TaskData[], skipDeletes: boolean = false): void {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM tasks WHERE path = ?', [path]);
    }

    if (tasks?.length) {
      const rows = tasks.map(task => [
        path,
        task.task_text,
        task.status || 'TODO',
        task.priority || null,
        task.due_date || null,
        task.scheduled_date || null,
        task.start_date || null,
        task.created_date || null,
        task.done_date || null,
        task.cancelled_date ?? null,
        task.recurrence ?? null,
        task.on_completion ?? null,
        task.task_id ?? null,
        task.depends_on ?? null,
        task.tags ?? null,
        task.line_number,
        task.block_id ?? null,
        task.start_offset ?? null,
        task.end_offset ?? null,
        task.anchor_hash ?? null,
        task.section_heading ?? null
      ]);
      this.runMultiRowInsert('INSERT INTO tasks (path, task_text, status, priority, due_date, scheduled_date, start_date, created_date, done_date, cancelled_date, recurrence, on_completion, task_id, depends_on, tags, line_number, block_id, start_offset, end_offset, anchor_hash, section_heading) VALUES ', 21, rows);
    }
  }

  private replaceHeadings(path: string, headings: Array<{ level: number; heading_text: string; line_number: number; block_id?: string; start_offset?: number; end_offset?: number; anchor_hash?: string }>, skipDeletes: boolean = false): void {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM headings WHERE path = ?', [path]);
    }

    if (headings?.length) {
      const rows = headings.map(heading => [
        path,
        heading.level,
        heading.heading_text,
        heading.line_number,
        heading.block_id ?? null,
        heading.start_offset ?? null,
        heading.end_offset ?? null,
        heading.anchor_hash ?? null
      ]);
      this.runMultiRowInsert('INSERT INTO headings (path, level, heading_text, line_number, block_id, start_offset, end_offset, anchor_hash) VALUES ', 8, rows);
    }
  }

  private replaceListItems(path: string, listItems: ListItemData[], skipDeletes: boolean = false): void {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM list_items WHERE path = ?', [path]);
    }

    if (listItems?.length) {
      const rows = listItems.map(item => [
        path,
        item.list_index,
        item.item_index,
        item.parent_index,
        item.content,
        item.list_type,
        item.indent_level,
        item.line_number,
        item.block_id ?? null,
        item.start_offset,
        item.end_offset,
        item.anchor_hash ?? null
      ]);
      this.runMultiRowInsert('INSERT INTO list_items (path, list_index, item_index, parent_index, content, list_type, indent_level, line_number, block_id, start_offset, end_offset, anchor_hash) VALUES ', 12, rows);
    }
  }

  private replaceUserViews(path: string, userViews?: Array<{view_name: string; sql: string}>, skipDeletes: boolean = false): void {
    if (!skipDeletes) {
      const existingViews = this.getViewsForPath(path);

      this.runWithPreparedStatement('DELETE FROM _user_views WHERE path = ?', [path]);

      for (const viewName of existingViews) {
        try {
          this.db.run(`DROP VIEW IF EXISTS "${viewName}"`);
        }
        catch (error) {
          console.warn(`[VaultQuery] Failed to drop view "${viewName}":`, error);
        }
      }
    }

    if (userViews?.length) {
      const insertSQL = 'INSERT OR REPLACE INTO _user_views (view_name, path, sql) VALUES (?, ?, ?)';
      for (const view of userViews) {
        this.runWithPreparedStatement(insertSQL, [view.view_name, path, view.sql]);
      }

      for (const { view_name, sql } of userViews) {
        try {
          this.db.run(`DROP VIEW IF EXISTS "${view_name}"`);
          this.db.run(sql);
        }
        catch (error) {
          console.error(`[VaultQuery] Failed to create view "${view_name}":`, error);
        }
      }
    }
  }

  private getViewsForPath(path: string): string[] {
    try {
      const results = this.db.exec('SELECT view_name FROM _user_views WHERE path = ?', [path]);
      if (results.length === 0 || !results[0].values) return [];
      return results[0].values.map(row => row[0] as string);
    }
    catch (e) {
      console.warn('[VaultQuery] DatabaseService.getViewsForPath: Query failed', path, e);
      return [];
    }
  }

  private replaceUserFunctions(path: string, userFunctions?: Array<{function_name: string; source: string}>, skipDeletes: boolean = false): void {
    if (!skipDeletes) {
      this.runWithPreparedStatement('DELETE FROM _user_functions WHERE path = ?', [path]);
    }

    if (userFunctions?.length) {
      const insertSQL = 'INSERT OR REPLACE INTO _user_functions (function_name, path, source) VALUES (?, ?, ?)';
      for (const func of userFunctions) {
        this.runWithPreparedStatement(insertSQL, [func.function_name, path, func.source]);
      }

      for (const { function_name, source } of userFunctions) {
        try {
          this.registerCustomFunction(function_name, source);
        }
        catch (error) {
          console.error(`[VaultQuery] Failed to register function "${function_name}":`, error);
        }
      }
    }
  }

  public getAllUserViews(): Array<{view_name: string; path: string; sql: string}> {
    try {
      const results = this.db.exec('SELECT view_name, path, sql FROM _user_views');
      if (results.length === 0 || !results[0].values) return [];
      return results[0].values.map(row => ({
        view_name: row[0] as string,
        path: row[1] as string,
        sql: row[2] as string
      }));
    }
    catch (e) {
      console.warn('[VaultQuery] DatabaseService.getAllUserViews: Query failed', e);
      return [];
    }
  }

  public getAllUserFunctions(): Array<{function_name: string; path: string; source: string}> {
    try {
      const results = this.db.exec('SELECT function_name, path, source FROM _user_functions');
      if (results.length === 0 || !results[0].values) return [];
      return results[0].values.map(row => ({
        function_name: row[0] as string,
        path: row[1] as string,
        source: row[2] as string
      }));
    }
    catch (e) {
      console.warn('[VaultQuery] DatabaseService.getAllUserFunctions: Query failed', e);
      return [];
    }
  }

  public getAllPropertyKeys(): string[] {
    return this.schemaManager.getAllPropertyKeys();
  }

  public getViewNames(): string[] {
    return this.schemaManager.getViewNames();
  }

  public getViewColumns(viewName: string): string[] {
    return this.schemaManager.getViewColumns(viewName);
  }

  public rebuildPropertiesView(): void {
    this.schemaManager.rebuildPropertiesView();
  }

  public discoverTableStructures(): import('./DatabaseSchema').TableStructure[] {
    return this.schemaManager.discoverTableStructures();
  }

  public rebuildTableViews(enableDynamicTableViews: boolean): void {
    this.schemaManager.rebuildTableViews(enableDynamicTableViews);
  }
}