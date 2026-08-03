import { MarkdownPostProcessorContext } from 'obsidian';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { scanMarkdownCodeFences } from '../utils/MarkdownFenceUtils';
import { hashString } from '../utils/StringUtils';
import { logger as rootLogger } from '../utils/logger';
import { getErrorMessage } from '../utils/ErrorMessages';
import { quoteValidatedIdentifier } from '../utils/SqlIdentifierUtils';
import { formatUnknownValue } from '../utils/ResultFormatUtils';
import { insertRowsChunked, relationExists } from '../Database/SqlHelpers';
import type { VaultDatabase } from '../Database/DatabaseService';
import type { WorkerDatabase } from '../Database/WorkerDatabaseService';
import type { IndexedProviderDefinitionBlock, ProviderColumnDefinition, ProviderDefinitionBlockContext, ProviderDefinitionCompletionConfig, ProviderRefreshDefinition, ProviderRefreshResult, ProviderRowValue, ProviderTableDefinition, ProviderTablesChangedEvent, TableProviderRegistration, TableProviderStatus, VaultQueryTableProvider } from './TableProviderTypes';

const logger = rootLogger.scope('ProviderTables');
const RECENT_REFRESH_SKIP_MS = 5000;
const PROVIDER_REFRESH_CONCURRENCY = 3;

type ProviderDatabase = VaultDatabase | WorkerDatabase;
type SqlParam = string | number | null;

interface RuntimeRefreshDefinition {
  providerId: string;
  providerDisplayName: string;
  language: string;
  sourcePath: string;
  blockIndex: number;
  blockHash: string;
  definition: ProviderRefreshDefinition;
  error?: string;
}

type RuntimeTableStatus = TableProviderStatus & { definitionBlockHash?: string };

interface RenderedProviderBlock {
  language: string;
  source: string;
  sourcePath: string;
  ctx: MarkdownPostProcessorContext;
  providerId?: string;
  definitionId?: string;
}


export class TableProviderService {
  private providers = new Map<string, VaultQueryTableProvider>();
  private providersByLanguage = new Map<string, VaultQueryTableProvider>();
  private indexedBlocksByPath = new Map<string, IndexedProviderDefinitionBlock[]>();
  private definitions = new Map<string, RuntimeRefreshDefinition>();
  private duplicateDefinitionKeys = new Set<string>();
  private tableStatus = new Map<string, RuntimeTableStatus>();
  private recentRefreshes = new Map<string, { refreshedAt: number; blockHash: string }>();
  private renderedBlocks = new Map<HTMLElement, RenderedProviderBlock>();
  private registerBlockLanguage?: (language: string) => void;
  private refreshingStaleDefinitions = false;
  private refreshDeferred = false;
  private onAllQueriesRefresh?: () => Promise<void>;
  private onRefreshWaveComplete?: (tables: string[]) => Promise<void>;
  private onProviderTablesChanged?: (event: ProviderTablesChangedEvent) => void;

  public constructor(private database: ProviderDatabase, private enabled = true) {}

  public getRegisteredTableNames(): string[] {
    const names: string[] = [];
    for (const provider of this.providers.values()) {
      for (const table of provider.tables) {
        names.push(table.name);
      }
    }
    return names;
  }

  public setRefreshDeferred(deferred: boolean): void {
    if (this.refreshDeferred === deferred) return;
    this.refreshDeferred = deferred;
    logger.debug(`Provider refresh ${deferred ? 'deferred during vault indexing' : 'enabled after vault indexing'}`);
  }

  public setOnAllQueriesRefresh(callback: () => Promise<void>): void {
    this.onAllQueriesRefresh = callback;
  }

  public setOnRefreshWaveComplete(callback: (tables: string[]) => Promise<void>): void {
    this.onRefreshWaveComplete = callback;
  }

  public setOnProviderTablesChanged(callback: (event: ProviderTablesChangedEvent) => void): void {
    this.onProviderTablesChanged = callback;
  }

  public async setDatabase(database: ProviderDatabase): Promise<void> {
    this.database = database;
    if (!this.enabled) return;

    for (const provider of this.providers.values()) {
      await this.createProviderTables(provider);
    }
  }

  public setEnabled(enabled: boolean): void {
    logger.info(`Third-party provider tables ${enabled ? 'enabled' : 'disabled'}`);
    this.enabled = enabled;
    if (!enabled) {
      this.clearProviderDefinitionBlocks();
      void this.rerenderProviderBlocksWhere(() => true);
    }
  }

  public setBlockLanguageRegistrar(registerBlockLanguage: (language: string) => void): void {
    logger.info('Provider block language registrar attached');
    this.registerBlockLanguage = registerBlockLanguage;

    for (const provider of this.providers.values()) {
      logger.info(`Registering existing provider block language after registrar attach: ${provider.definitionBlock.language}`);
      registerBlockLanguage(provider.definitionBlock.language);
    }
  }

  public hasProviderDefinitionDiscovery(): boolean {
    return this.enabled;
  }

  public async registerProvider(provider: VaultQueryTableProvider): Promise<TableProviderRegistration> {
    if (!this.enabled) {
      logger.warn(`registerTableProvider rejected because feature is disabled: provider=${provider.id}`);
      throw new Error('Third-party provider tables are disabled in VaultQuery settings.');
    }

    this.validateProvider(provider);

    const existing = this.providers.get(provider.id);
    if (existing) {
      this.unregisterProvider(existing.id);
    }

    const language = provider.definitionBlock.language;
    const languageOwner = this.providersByLanguage.get(language);
    if (languageOwner && languageOwner.id !== provider.id) {
      throw new Error(`Provider definition block language is already registered: ${language}`);
    }

    await this.createProviderTables(provider);

    this.providers.set(provider.id, provider);
    this.providersByLanguage.set(language, provider);
    logger.info(`Provider registered: provider=${provider.id}, language=${language}, tables=${provider.tables.map(table => table.name).join(',')}`);
    this.registerBlockLanguage?.(language);

    await this.reprocessIndexedBlocksForLanguage(language);

    return {
      providerId: provider.id,
      tables: provider.tables.map(table => ({
        name: table.name,
      })),
    };
  }

  public unregisterProvider(providerId: string): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;

    this.providers.delete(providerId);
    this.providersByLanguage.delete(provider.definitionBlock.language);

    for (const status of this.tableStatus.values()) {
      if (status.providerId === providerId) {
        status.active = false;
      }
    }
  }

  public getStatus(providerId?: string): TableProviderStatus[] {
    if (!this.enabled) return [];

    return Array.from(this.tableStatus.values())
      .filter(status => !providerId || status.providerId === providerId)
      .map(status => ({ ...status }));
  }

  public getRegisteredProviders(): VaultQueryTableProvider[] {
    return Array.from(this.providers.values());
  }

  public getProviderDefinitionCompletions(language: string): ProviderDefinitionCompletionConfig | null {
    return this.providersByLanguage.get(language)?.definitionBlock.completions ?? null;
  }

  public getDeclaredTables(): ProviderTableDefinition[] {
    if (!this.enabled) return [];
    return Array.from(this.providers.values()).flatMap((provider) => provider.tables);
  }

  public getSchemaMarkdown(): string {
    if (!this.enabled) return '';

    const sections: string[] = [];

    for (const provider of this.providers.values()) {
      sections.push(`## Third-party provider tables: ${provider.displayName}\n`);

      for (const table of provider.tables) {
        const statusRows = this.getStatus(provider.id).filter(status => status.tableName === table.name);
        const latestRefresh = statusRows
          .map(status => status.lastRefreshAt)
          .filter((value): value is number => typeof value === 'number')
          .sort((a, b) => b - a)[0];
        const rowCount = statusRows.reduce((sum, status) => Math.max(sum, status.rowCount), 0);

        sections.push(`### ${table.name} (THIRD-PARTY PROVIDER TABLE)\n`);
        sections.push("Provider: " + provider.displayName + "\n");
        sections.push("Rows: " + rowCount + "\n");
        if (latestRefresh) {
          sections.push("Last refresh: " + new Date(latestRefresh).toLocaleString() + "\n");
        }
        if (table.defaultStaleAfterMs) {
          sections.push("TTL: " + this.formatDuration(table.defaultStaleAfterMs) + "\n");
        }
        sections.push('\n| Column | Type | Description |\n|--------|------|-------------|\n');
        for (const column of table.columns) {
          sections.push(`| \`${column.name}\` | ${column.type}${column.nullable ? ' NULL' : ''} | ${column.description ?? ''} |\n`);
        }
        sections.push('\n');
      }
    }

    return sections.join('');
  }

  public async indexProviderDefinitionBlocks(path: string, content: string): Promise<void> {
    if (!this.enabled) {
      this.removeProviderDefinitionBlocks(path);
      return;
    }

    const blocks = this.extractFencedCodeBlocks(path, content);
    this.removeRuntimeDefinitionsForPath(path);
    this.indexedBlocksByPath.set(path, blocks);
    const providerBlocks = blocks.filter(block => this.providersByLanguage.has(block.language));
    if (providerBlocks.length > 0) {
      logger.info(`Indexed provider definition block(s): path=${path}, count=${providerBlocks.length}, languages=${providerBlocks.map(block => block.language).join(',')}`);
    }
    const runtimes: RuntimeRefreshDefinition[] = [];

    for (const block of blocks) {
      const runtime = await this.processIndexedBlock(block);
      if (runtime) {
        runtimes.push(runtime);
      }
    }

    this.recomputeDuplicateDefinitions();
    await this.refreshIndexedDefinitions(runtimes);
    await this.rerenderProviderBlocksForPath(path);
  }

  public removeProviderDefinitionBlocks(path: string): void {
    this.indexedBlocksByPath.delete(path);
    this.removeRuntimeDefinitionsForPath(path);
    this.recomputeDuplicateDefinitions();
    this.removeRenderedProviderBlocksForPath(path);
  }

  public clearProviderDefinitionBlocks(): void {
    this.indexedBlocksByPath.clear();
    this.definitions.clear();
    this.duplicateDefinitionKeys.clear();
  }

  public async renderDefinitionBlock(language: string, source: string, container: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    for (const [trackedContainer, tracked] of this.renderedBlocks) {
      if (trackedContainer !== container && tracked.sourcePath === ctx.sourcePath && tracked.language === language && !trackedContainer.isConnected) {
        this.renderedBlocks.delete(trackedContainer);
      }
    }
    this.renderedBlocks.set(container, {
      language,
      source,
      sourcePath: ctx.sourcePath,
      ctx,
    });

    container.empty();
    container.addClass('vaultquery-container');
    container.removeClass('vaultquery-provider-definition-container');

    if (!this.enabled) {
      logger.warn(`Provider definition render skipped because feature is disabled: language=${language}, sourcePath=${ctx.sourcePath}`);
      this.renderProviderBlockMessage(container, 'Third-party provider tables disabled', 'Third-party provider tables are disabled in VaultQuery settings.');
      return;
    }

    const provider = this.providersByLanguage.get(language);

    if (!provider) {
      logger.warn(`Provider definition render skipped because no provider is registered: language=${language}, sourcePath=${ctx.sourcePath}`);
      this.renderProviderBlockMessage(container, 'Provider not available', `No provider is registered for \`${language}\`.`);
      return;
    }

    const blockHash = hashString(source);
    const blockIndex = this.findBlockIndex(ctx.sourcePath, language, blockHash);
    const context: ProviderDefinitionBlockContext = {
      path: ctx.sourcePath,
      blockIndex: blockIndex ?? -1,
      blockHash,
    };

    let definition: ProviderRefreshDefinition;
    try {
      definition = await provider.definitionBlock.parse(source, context);
    } catch (error) {
      logger.error(`Provider definition parse failed: provider=${provider.id}, language=${language}, sourcePath=${ctx.sourcePath}`, error);
      this.renderProviderError(container, `${provider.displayName} definition error`, error, async () => {
        await this.renderDefinitionBlock(language, source, container, ctx);
      });
      return;
    }

    const runtime = blockIndex !== null
      ? this.storeRuntimeDefinition(provider, source, context, definition)
      : this.createRuntimeDefinition(provider, source, context, definition);
    this.renderedBlocks.set(container, {
      language,
      source,
      sourcePath: ctx.sourcePath,
      ctx,
      providerId: runtime.providerId,
      definitionId: runtime.definition.id,
    });

    if (blockIndex !== null) {
      this.recomputeDuplicateDefinitions();
    }

    logger.debug(`Provider definition block rendered: provider=${runtime.providerId}, language=${language}, sourcePath=${ctx.sourcePath}, connected=${container.isConnected}`);
    this.renderRuntimeDefinition(container, runtime);
  }

  public async refreshDefinition(providerId: string, definitionId: string): Promise<string[]> {
    if (!this.enabled) {
      throw new Error('Third-party provider tables are disabled in VaultQuery settings.');
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider is not registered: ${providerId}`);
    }

    const runtime = Array.from(this.definitions.values())
      .find(definition => definition.providerId === providerId && definition.definition.id === definitionId);

    if (!runtime) {
      throw new Error(`Refresh definition not found: ${definitionId}`);
    }

    const duplicateKey = this.definitionDuplicateKey(providerId, definitionId);
    if (this.duplicateDefinitionKeys.has(duplicateKey)) {
      throw new Error(`Duplicate refresh definition id: ${definitionId}`);
    }

    const existingStatus = this.getStatus(providerId);

    try {
      const fetchStartedAt = performance.now();
      const result = await provider.refresh({
        providerId,
        definitionId,
        requestedTables: runtime.definition.requestedTables,
        request: runtime.definition.request,
        existingStatus,
      });
      const fetchMs = performance.now() - fetchStartedAt;

      const materializeStartedAt = performance.now();
      await this.materializeRefreshResult(provider, runtime, result);
      const materializeMs = performance.now() - materializeStartedAt;
      logger.debug(`Provider refresh phases: provider=${providerId}, definition=${definitionId}, fetchMs=${Math.round(fetchMs)}, materializeMs=${Math.round(materializeMs)}, tables=${Object.entries(result.tables).map(([tableName, tableRows]) => `${tableName}:${tableRows.rows.length}`).join(',')}`);
      this.recentRefreshes.set(this.definitionDuplicateKey(providerId, definitionId), {
        refreshedAt: Date.now(),
        blockHash: runtime.blockHash,
      });
      runtime.error = undefined;
      await this.rerenderProviderBlocks(providerId, definitionId);
      const changedTables = Object.keys(result.tables);
      this.onProviderTablesChanged?.({
        providerId,
        definitionId,
        tables: changedTables,
      });
      if (!this.refreshingStaleDefinitions) {
        await this.finishRefreshWave(changedTables);
      }
      return changedTables;
    } catch (error) {
      logger.error(`Provider refresh failed: provider=${providerId}, definition=${definitionId}`, error);
      const message = getErrorMessage(error);
      runtime.error = message;
      for (const table of provider.tables) {
          this.updateStatus(provider, runtime.definition.id, table, { lastError: message });
      }
      throw error;
    }
  }

  public async refreshStaleDefinitions(): Promise<void> {
    if (!this.enabled) return;
    if (this.refreshDeferred) {
      logger.debug('Provider TTL refresh deferred until vault indexing completes');
      return;
    }
    if (this.refreshingStaleDefinitions) return;

    this.refreshingStaleDefinitions = true;
    const changedTables = new Set<string>();

    try {
      const now = Date.now();

      const refreshes: Array<() => Promise<void>> = [];
      for (const runtime of this.definitions.values()) {
        const provider = this.providers.get(runtime.providerId);
        if (!provider || runtime.error) continue;

        const duplicateKey = this.definitionDuplicateKey(runtime.providerId, runtime.definition.id);
        if (this.duplicateDefinitionKeys.has(duplicateKey)) continue;

        if (!this.shouldRefreshRuntimeDefinition(provider, runtime, now)) continue;

        refreshes.push(async () => {
          try {
            const refreshedTables = await this.refreshDefinition(runtime.providerId, runtime.definition.id);
            for (const tableName of refreshedTables) changedTables.add(tableName);
          } catch (error) {
            logger.error(`Provider refresh failed for ${runtime.providerId}:${runtime.definition.id}`, error);
          }
        });
      }

      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (nextIndex < refreshes.length) {
          await refreshes[nextIndex++]();
        }
      };
      const workerCount = Math.min(PROVIDER_REFRESH_CONCURRENCY, refreshes.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      await this.finishRefreshWave(Array.from(changedTables));
    } finally {
      this.refreshingStaleDefinitions = false;
    }
  }

  private async finishRefreshWave(tables: string[]): Promise<void> {
    if (tables.length === 0) return;
    if (this.onRefreshWaveComplete) {
      await this.onRefreshWaveComplete(tables);
      return;
    }
    await this.onAllQueriesRefresh?.();
  }

  private async createProviderTables(provider: VaultQueryTableProvider): Promise<void> {
    for (const table of provider.tables) {
      this.validateTable(table);
      if (await relationExists(this.database, table.name)) {
        try {
          await this.ensureCompatibleTableSchema(provider, table);
        } catch (error) {
          logger.warn(`Recreating incompatible provider table: provider=${provider.id}, table=${table.name}`, error);
          await this.database.run(`DROP TABLE IF EXISTS ${quoteValidatedIdentifier(table.name)}`);
          await this.createProviderTable(table);
        }
      } else {
        await this.createProviderTable(table);
      }

      for (const index of table.indexes ?? []) {
        this.validateIdentifier(index.name, 'index name');
        for (const column of index.columns) {
          this.ensureTableColumn(table, column);
        }
        const unique = index.unique ? 'UNIQUE ' : '';
        const columns = index.columns.map(column => quoteValidatedIdentifier(column)).join(', ');
        await this.database.run(`CREATE ${unique}INDEX IF NOT EXISTS ${quoteValidatedIdentifier(index.name)} ON ${quoteValidatedIdentifier(table.name)} (${columns})`);
      }

      this.updateStatus(provider, undefined, table, { active: true });
    }
  }

  private async createProviderTable(table: ProviderTableDefinition): Promise<void> {
    const columnsSql = table.columns.map(column => this.columnSql(column)).join(', ');
    const primaryKeySql = table.primaryKey.length > 0
      ? `, PRIMARY KEY (${table.primaryKey.map(column => quoteValidatedIdentifier(column)).join(', ')})`
      : '';
    await this.database.run(`CREATE TABLE ${quoteValidatedIdentifier(table.name)} (${columnsSql}${primaryKeySql})`);
  }

  private async ensureCompatibleTableSchema(provider: VaultQueryTableProvider, table: ProviderTableDefinition): Promise<void> {
    const existingRows = await this.database.all(`PRAGMA table_info(${quoteValidatedIdentifier(table.name)})`);
    const existingByName = new Map(existingRows.map(row => [String(row.name), row]));
    const errors: string[] = [];

    for (const column of table.columns) {
      const existing = existingByName.get(column.name);
      if (!existing) {
        errors.push(`missing column ${column.name}`);
        continue;
      }

      const existingType = formatUnknownValue(existing.type).toUpperCase();
      if (existingType !== column.type) {
        errors.push(`column ${column.name} has type ${existingType || '(none)'}, expected ${column.type}`);
      }

      if (column.nullable === false && Number(existing.notnull ?? 0) !== 1 && !table.primaryKey.includes(column.name)) {
        errors.push(`column ${column.name} is nullable, expected NOT NULL`);
      }
    }

    const primaryKeyOrder = existingRows
      .filter(row => Number(row.pk ?? 0) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map(row => String(row.name));

    if (primaryKeyOrder.join('\u0000') !== table.primaryKey.join('\u0000')) {
      errors.push(`primary key is (${primaryKeyOrder.join(', ')}), expected (${table.primaryKey.join(', ')})`);
    }

    if (errors.length > 0) {
      const message = `Third-party provider table schema mismatch for ${table.name}: ${errors.join('; ')}. Rebuild or migrate the table before registering ${provider.id}.`;
      this.updateStatus(provider, undefined, table, {
        active: false,
        lastError: message,
      });
      throw new Error(message);
    }
  }

  private async materializeRefreshResult(provider: VaultQueryTableProvider, runtime: RuntimeRefreshDefinition, result: ProviderRefreshResult): Promise<void> {
    const tableByName = new Map(provider.tables.map(table => [table.name, table]));
    const refreshedAt = Date.now();

    await this.database.withTx(async () => {
      for (const [tableName, tableRows] of Object.entries(result.tables)) {
        const table = tableByName.get(tableName);
        if (!table) {
          throw new Error(`Provider ${provider.id} returned unknown table: ${tableName}`);
        }

        if (tableRows.replaceWhere) {
          await this.deleteRows(table, tableRows.replaceWhere);
        }

        await this.upsertRows(table, tableRows.rows);
        const dataAsOf = typeof tableRows.asOf === 'number' && Number.isFinite(tableRows.asOf)
          ? tableRows.asOf
          : undefined;
        const expiresAt = typeof tableRows.expiresAt === 'number' && Number.isFinite(tableRows.expiresAt)
          ? tableRows.expiresAt
          : table.defaultStaleAfterMs ? refreshedAt + table.defaultStaleAfterMs : undefined;
        this.updateStatus(provider, runtime.definition.id, table, {
          definitionBlockHash: runtime.blockHash,
          rowCount: tableRows.rows.length,
          dataAsOf,
          lastRefreshAt: refreshedAt,
          expiresAt,
          lastError: undefined,
          active: true,
        });
      }
    });
  }

  private async upsertRows(table: ProviderTableDefinition, rows: Record<string, ProviderRowValue>[]): Promise<void> {
    if (rows.length === 0) return;

    const columnNames = table.columns.map(column => column.name);

    const rowsByColumnShape = new Map<string, { columns: string[]; params: SqlParam[][] }>();

    for (const row of rows) {
      const rowColumns = columnNames.filter(column => Object.prototype.hasOwnProperty.call(row, column));
      if (rowColumns.length === 0) continue;

      for (const pk of table.primaryKey) {
        if (!rowColumns.includes(pk)) {
          throw new Error(`Provider row for ${table.name} is missing primary key column: ${pk}`);
        }
      }

      const params = rowColumns.map(column => this.toSqlParam(row[column]));
      const shapeKey = rowColumns.join('\u0000');
      const group = rowsByColumnShape.get(shapeKey);
      if (group) {
        group.params.push(params);
      } else {
        rowsByColumnShape.set(shapeKey, { columns: rowColumns, params: [params] });
      }
    }

    for (const { columns, params } of rowsByColumnShape.values()) {
      const quotedColumns = columns.map(column => quoteValidatedIdentifier(column)).join(', ');
      const updateColumns = columns.filter(column => !table.primaryKey.includes(column));
      const conflictColumns = table.primaryKey.map(column => quoteValidatedIdentifier(column)).join(', ');
      const conflictAction = updateColumns.length > 0
        ? `DO UPDATE SET ${updateColumns.map(column => `${quoteValidatedIdentifier(column)} = excluded.${quoteValidatedIdentifier(column)}`).join(', ')}`
        : 'DO NOTHING';

      await insertRowsChunked(
        this.database,
        placeholders => `INSERT INTO ${quoteValidatedIdentifier(table.name)} (${quotedColumns}) VALUES ${placeholders} ON CONFLICT (${conflictColumns}) ${conflictAction}`,
        params,
        columns.length
      );
    }
  }

  private async deleteRows(table: ProviderTableDefinition, where: Record<string, ProviderRowValue>): Promise<void> {
    const columnNames = table.columns.map(column => column.name);
    const columnSet = new Set(columnNames);
    const whereColumns = Object.keys(where).filter(column => columnSet.has(column));

    if (whereColumns.length === 0) {
      throw new Error(`Provider replacement for ${table.name} must specify at least one declared column.`);
    }

    const whereSql = whereColumns.map(column => `${quoteValidatedIdentifier(column)} = ?`).join(' AND ');
    const params = whereColumns.map(column => this.toSqlParam(where[column]));
    await this.database.run(`DELETE FROM ${quoteValidatedIdentifier(table.name)} WHERE ${whereSql}`, params);
  }

  private async reprocessIndexedBlocksForLanguage(language: string): Promise<void> {
    const runtimes: RuntimeRefreshDefinition[] = [];
    let scanned = 0;

    for (const blocks of this.indexedBlocksByPath.values()) {
      for (const block of blocks) {
        if (block.language === language) {
          scanned++;
          const runtime = await this.processIndexedBlock(block);
          if (runtime) {
            runtimes.push(runtime);
          }
        }
      }
    }

    logger.debug(`Reprocessed indexed provider definition blocks: language=${language}, scanned=${scanned}, runtimes=${runtimes.length}`);
    this.recomputeDuplicateDefinitions();
    await this.refreshIndexedDefinitions(runtimes);
    await this.rerenderProviderBlocksForLanguage(language);
  }

  private async processIndexedBlock(block: IndexedProviderDefinitionBlock): Promise<RuntimeRefreshDefinition | null> {
    const provider = this.providersByLanguage.get(block.language);
    if (!provider) {
      return null;
    }

    try {
      const context: ProviderDefinitionBlockContext = {
        path: block.path,
        blockIndex: block.blockIndex,
        blockHash: block.blockHash,
      };
      const definition = await provider.definitionBlock.parse(block.source, context);
      return this.storeRuntimeDefinition(provider, block.source, context, definition);
    } catch (error) {
      logger.error(`Indexed provider definition parse failed: provider=${provider.id}, language=${block.language}, path=${block.path}, blockIndex=${block.blockIndex}`, error);
      const key = this.runtimeDefinitionKey(provider.id, block.path, block.blockIndex, block.blockHash);
      const runtime: RuntimeRefreshDefinition = {
        providerId: provider.id,
        providerDisplayName: provider.displayName,
        language: block.language,
        sourcePath: block.path,
        blockIndex: block.blockIndex,
        blockHash: block.blockHash,
        definition: {
          id: `${block.path}:${block.blockIndex}`,
          request: {},
        },
        error: getErrorMessage(error),
      };
      this.definitions.set(key, runtime);
      return runtime;
    }
  }

  private async refreshIndexedDefinitions(runtimes: RuntimeRefreshDefinition[]): Promise<void> {
    if (this.refreshDeferred) {
      if (runtimes.length > 0) {
        logger.debug(`Queued provider definition refresh runtime(s) until vault indexing completes: count=${runtimes.length}`);
      }
      return;
    }
    const now = Date.now();

    for (const runtime of runtimes) {
      const provider = this.providers.get(runtime.providerId);
      if (!provider || runtime.error) {
        continue;
      }

      const duplicateKey = this.definitionDuplicateKey(runtime.providerId, runtime.definition.id);
      if (this.duplicateDefinitionKeys.has(duplicateKey)) {
        continue;
      }

      if (!this.shouldRefreshRuntimeDefinition(provider, runtime, now)) {
        continue;
      }

      try {
        await this.refreshDefinition(runtime.providerId, runtime.definition.id);
      } catch (error) {
        logger.error(`Provider refresh failed while indexing ${runtime.providerId}:${runtime.definition.id}`, error);
      }
    }
  }

  private async rerenderProviderBlocks(providerId: string, definitionId: string): Promise<void> {
    await this.rerenderProviderBlocksWhere(block => block.providerId === providerId && block.definitionId === definitionId);
  }

  private async rerenderProviderBlocksForPath(path: string): Promise<void> {
    await this.rerenderProviderBlocksWhere(block => block.sourcePath === path);
  }

  private async rerenderProviderBlocksForLanguage(language: string): Promise<void> {
    await this.rerenderProviderBlocksWhere(block => block.language === language);
  }

  private async rerenderProviderBlocksWhere(predicate: (block: RenderedProviderBlock) => boolean): Promise<void> {
    const blocks = Array.from(this.renderedBlocks.entries())
      .filter(([, block]) => predicate(block));
    if (blocks.length === 0) return;

    logger.debug(`Rerendering provider blocks: matched=${blocks.length} of ${this.renderedBlocks.size} tracked${blocks.map(([container, block]) => `; ${block.language} in ${block.sourcePath} connected=${container.isConnected}`).join('')}`);
    await Promise.all(blocks.map(([container, block]) => this.rerenderProviderBlock(container, block)));
  }

  private async rerenderProviderBlock(container: HTMLElement, block: RenderedProviderBlock): Promise<void> {
    const currentBlock = this.findCurrentIndexedBlock(block);
    const source = currentBlock?.source ?? block.source;
    await this.renderDefinitionBlock(block.language, source, container, block.ctx);
  }

  private shouldRefreshRuntimeDefinition(provider: VaultQueryTableProvider, runtime: RuntimeRefreshDefinition, now: number): boolean {
    const recent = this.recentRefreshes.get(this.definitionDuplicateKey(runtime.providerId, runtime.definition.id));
    if (recent && recent.blockHash === runtime.blockHash && now - recent.refreshedAt < RECENT_REFRESH_SKIP_MS) {
      return false;
    }

    const requestedTables = runtime.definition.requestedTables ?? provider.tables.map(table => table.name);
    const tableByName = new Map(provider.tables.map(table => [table.name, table]));

    for (const tableName of requestedTables) {
      const table = tableByName.get(tableName);
      if (!table) continue;

      const status = this.tableStatus.get(this.statusKey(provider.id, runtime.definition.id, table.name));
      let reason: string | null = null;
      if (!status?.lastRefreshAt) {
        reason = 'no refresh recorded';
      } else if (status.definitionBlockHash !== runtime.blockHash) {
        reason = 'definition block changed';
      } else if (status.expiresAt && status.expiresAt <= now) {
        reason = 'data expired';
      } else if (table.defaultStaleAfterMs && !status.expiresAt) {
        reason = 'stale policy without recorded expiry';
      }

      if (reason) {
        logger.debug(`Provider refresh needed (${reason}): provider=${runtime.providerId}, definition=${runtime.definition.id}, table=${tableName}`);
        return true;
      }
    }

    return false;
  }

  private storeRuntimeDefinition(provider: VaultQueryTableProvider, source: string, context: ProviderDefinitionBlockContext, definition: ProviderRefreshDefinition): RuntimeRefreshDefinition {
    const runtime = this.createRuntimeDefinition(provider, source, context, definition);
    const key = this.runtimeDefinitionKey(provider.id, context.path, context.blockIndex, context.blockHash);
    this.removeRuntimeDefinitionForBlock(provider.id, context.path, context.blockIndex, key);
    this.definitions.set(key, runtime);
    return runtime;
  }

  private removeRuntimeDefinitionForBlock(providerId: string, path: string, blockIndex: number, exceptKey: string): void {
    for (const [key, definition] of this.definitions.entries()) {
      if (
        key !== exceptKey &&
        definition.providerId === providerId &&
        definition.sourcePath === path &&
        definition.blockIndex === blockIndex
      ) {
        this.definitions.delete(key);
      }
    }
  }

  private createRuntimeDefinition(provider: VaultQueryTableProvider, source: string, context: ProviderDefinitionBlockContext, definition: ProviderRefreshDefinition): RuntimeRefreshDefinition {
    if (!definition.id?.trim()) {
      throw new Error('Provider refresh definition must include an id.');
    }

    return {
      providerId: provider.id,
      providerDisplayName: provider.displayName,
      language: provider.definitionBlock.language,
      sourcePath: context.path,
      blockIndex: context.blockIndex,
      blockHash: context.blockHash || hashString(source),
      definition,
    };
  }

  private renderRuntimeDefinition(container: HTMLElement, runtime: RuntimeRefreshDefinition): void {
    container.removeClass('vaultquery-provider-definition-container');

    if (this.isDuplicateRuntimeDefinition(runtime)) {
      this.renderProviderError(
        container,
        'Duplicate definition',
        `Another ${runtime.providerDisplayName} definition uses id "${runtime.definition.id}". Resolve the duplicate before refreshing.`,
        async () => {
          await this.refreshRuntimeDefinition(container, runtime);
        }
      );
      return;
    }

    if (runtime.error) {
      this.renderProviderError(container, 'Definition error', runtime.error, async () => {
        await this.refreshRuntimeDefinition(container, runtime);
      });
      return;
    }

    const wrapper = container.createDiv({ cls: 'vaultquery-provider-definition' });
    container.addClass('vaultquery-provider-definition-container');
    const header = wrapper.createDiv({ cls: 'vaultquery-provider-definition-header' });
    const titleGroup = header.createDiv({ cls: 'vaultquery-provider-definition-title-group' });
    titleGroup.createEl('h3', { text: runtime.providerDisplayName });
    titleGroup.createDiv({ cls: 'vaultquery-provider-definition-subtitle', text: 'Provider definition indexed' });

    const meta = header.createDiv({ cls: 'vaultquery-provider-definition-meta' });
    const definitionItem = meta.createDiv({ cls: 'vaultquery-provider-definition-meta-item' });
    definitionItem.createSpan({ cls: 'vaultquery-provider-definition-meta-label', text: 'Definition' });
    definitionItem.createSpan({ cls: 'vaultquery-provider-definition-meta-value', text: runtime.definition.id });

    if (runtime.definition.displayName) {
      const nameItem = meta.createDiv({ cls: 'vaultquery-provider-definition-meta-item' });
      nameItem.createSpan({ cls: 'vaultquery-provider-definition-meta-label', text: 'Name' });
      nameItem.createSpan({ cls: 'vaultquery-provider-definition-meta-value', text: runtime.definition.displayName });
    }

    const statuses = this.getStatus(runtime.providerId)
      .filter(status => status.definitionId === runtime.definition.id);

    if (statuses.length > 0) {
      const tableWrapper = wrapper.createDiv({ cls: 'vaultquery-provider-status-table-wrapper' });
      this.containHorizontalTouchScroll(tableWrapper);
      const table = tableWrapper.createEl('table', { cls: 'vaultquery-table vaultquery-provider-status-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      for (const heading of ['Table', 'Rows', 'As of', 'Expires At', 'Status']) {
        headerRow.createEl('th', { text: heading });
      }

      const tbody = table.createEl('tbody');
      for (const status of statuses) {
        const asOf = status.dataAsOf ?? status.lastRefreshAt;
        const row = tbody.createEl('tr');
        row.createEl('td', { text: status.tableName });
        row.createEl('td', { text: String(status.rowCount) });
        row.createEl('td', { text: asOf ? new Date(asOf).toLocaleString() : '-' });
        row.createEl('td', { text: status.expiresAt ? new Date(status.expiresAt).toLocaleString() : '-' });
        const statusCell = row.createEl('td');
        statusCell.createSpan({
          cls: status.lastError ? 'vaultquery-provider-status-badge is-error' : 'vaultquery-provider-status-badge is-ok',
          text: status.lastError ? "Error: " + status.lastError : 'OK',
        });
      }
    }

    this.addProviderRefreshButton(container, async () => {
      await this.refreshRuntimeDefinition(container, runtime);
    });
  }

  private containHorizontalTouchScroll(element: HTMLElement): void {
    let startX = 0;
    let startY = 0;

    element.addEventListener('touchstart', (event) => {
      const touch = event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });

    element.addEventListener('touchmove', (event) => {
      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = Math.abs(touch.clientX - startX);
      const deltaY = Math.abs(touch.clientY - startY);
      if (deltaX > deltaY) {
        event.stopPropagation();
      }
    }, { passive: true });
  }

  private renderProviderError(container: HTMLElement, title: string, error: unknown, onRefresh: () => Promise<void>): void {
    container.addClass('vaultquery-container');
    container.addClass('vaultquery-provider-definition-container');
    BaseRenderer.renderError(container, {
      title,
      message: getErrorMessage(error),
    });
    this.addProviderRefreshButton(container, onRefresh);
  }

  private addProviderRefreshButton(container: HTMLElement, onRefresh: () => Promise<void>): void {
    container.querySelector('.vaultquery-floating-buttons')?.remove();
    const buttonContainer = container.createDiv('vaultquery-floating-buttons');
    BaseRenderer.addRefreshButton(buttonContainer, onRefresh);
  }

  private async refreshRuntimeDefinition(container: HTMLElement, runtime: RuntimeRefreshDefinition): Promise<void> {
    this.recomputeDuplicateDefinitions();
    if (this.isDuplicateRuntimeDefinition(runtime)) {
      container.empty();
      this.renderRuntimeDefinition(container, runtime);
      return;
    }

    try {
      await this.refreshDefinition(runtime.providerId, runtime.definition.id);
    } catch (error) {
      runtime.error = getErrorMessage(error);
      container.empty();
      this.renderRuntimeDefinition(container, runtime);
      throw error;
    }
  }

  private isDuplicateRuntimeDefinition(runtime: RuntimeRefreshDefinition): boolean {
    return this.duplicateDefinitionKeys.has(this.definitionDuplicateKey(runtime.providerId, runtime.definition.id));
  }

  private renderProviderBlockMessage(container: HTMLElement, title: string, message: string): void {
    container.addClass('vaultquery-provider-definition-container');
    const wrapper = container.createDiv({ cls: 'vaultquery-provider-definition' });
    wrapper.createEl('h3', { text: title });
    wrapper.createEl('p', { text: message });
  }

  private recomputeDuplicateDefinitions(): void {
    const counts = new Map<string, number>();
    for (const definition of this.definitions.values()) {
      const key = this.definitionDuplicateKey(definition.providerId, definition.definition.id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    this.duplicateDefinitionKeys = new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    );
  }

  private removeRuntimeDefinitionsForPath(path: string): void {
    for (const [key, definition] of this.definitions.entries()) {
      if (definition.sourcePath === path) {
        this.definitions.delete(key);
      }
    }
  }

  private removeRenderedProviderBlocksForPath(path: string): void {
    for (const [container, block] of this.renderedBlocks.entries()) {
      if (block.sourcePath === path) {
        this.renderedBlocks.delete(container);
      }
    }
  }

  private extractFencedCodeBlocks(path: string, content: string): IndexedProviderDefinitionBlock[] {
    return scanMarkdownCodeFences(content)
      .map(block => ({
        path,
        language: block.language,
        source: block.source,
        blockIndex: block.blockIndex,
        blockHash: hashString(block.source),
      }));
  }

  private findBlockIndex(path: string, language: string, blockHash: string): number | null {
    const blocks = this.indexedBlocksByPath.get(path) ?? [];
    const block = blocks.find(candidate => candidate.language === language && candidate.blockHash === blockHash);
    if (block) {
      return block.blockIndex;
    }

    const languageBlocks = blocks.filter(candidate => candidate.language === language);
    return languageBlocks.length === 1 ? languageBlocks[0].blockIndex : null;
  }

  private findCurrentIndexedBlock(block: RenderedProviderBlock): IndexedProviderDefinitionBlock | undefined {
    const blocks = this.indexedBlocksByPath.get(block.sourcePath) ?? [];
    const matchingBlock = blocks.find(candidate =>
      candidate.language === block.language &&
      candidate.blockIndex === this.findBlockIndex(block.sourcePath, block.language, hashString(block.source))
    );
    if (matchingBlock) {
      return matchingBlock;
    }

    const languageBlocks = blocks.filter(candidate => candidate.language === block.language);
    return languageBlocks.length === 1 ? languageBlocks[0] : undefined;
  }

  private updateStatus(provider: VaultQueryTableProvider, definitionId: string | undefined, table: ProviderTableDefinition, updates: Partial<RuntimeTableStatus>): void {
    const key = this.statusKey(provider.id, definitionId, table.name);
    const existing = this.tableStatus.get(key);
    const status: RuntimeTableStatus = {
      providerId: provider.id,
      displayName: provider.displayName,
      tableName: table.name,
      definitionId,
      rowCount: 0,
      active: true,
      ...existing,
      ...updates,
    };
    this.tableStatus.set(key, status);
  }

  private columnSql(column: ProviderColumnDefinition): string {
    return `${quoteValidatedIdentifier(column.name)} ${column.type}${column.nullable === false ? ' NOT NULL' : ''}`;
  }

  private validateProvider(provider: VaultQueryTableProvider): void {
    if (!provider.id.trim()) throw new Error('Provider id is required.');
    if (!provider.displayName.trim()) throw new Error('Provider displayName is required.');
    if (!provider.tables.length) throw new Error(`Provider ${provider.id} must declare at least one table.`);
    if (!provider.definitionBlock.language.trim()) throw new Error(`Provider ${provider.id} must declare a definition block language.`);
  }

  private validateTable(table: ProviderTableDefinition): void {
    this.validateIdentifier(table.name, 'table name');
    if (!table.columns.length) throw new Error(`Third-party provider table ${table.name} must declare columns.`);
    for (const column of table.columns) {
      this.validateIdentifier(column.name, 'column name');
    }
    for (const pk of table.primaryKey) {
      this.ensureTableColumn(table, pk);
    }
  }

  private validateIdentifier(identifier: string, label: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
      throw new Error(`Invalid ${label}: ${identifier}`);
    }
  }

  private ensureTableColumn(table: ProviderTableDefinition, columnName: string): void {
    if (!table.columns.some(column => column.name === columnName)) {
      throw new Error(`Column ${columnName} is not declared on third-party provider table ${table.name}.`);
    }
  }

  private toSqlParam(value: ProviderRowValue | undefined): SqlParam {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  }

  private statusKey(providerId: string, definitionId: string | undefined, tableName: string): string {
    return `${providerId}:${definitionId ?? '*'}:${tableName}`;
  }

  private runtimeDefinitionKey(providerId: string, path: string, blockIndex: number, blockHash: string): string {
    return `${providerId}:${path}:${blockIndex}:${blockHash}`;
  }

  private definitionDuplicateKey(providerId: string, definitionId: string): string {
    return `${providerId}:${definitionId}`;
  }

  private formatDuration(ms: number): string {
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    return `${ms}ms`;
  }
}
