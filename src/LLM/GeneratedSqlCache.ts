import type { App } from 'obsidian';
import type { GeneratedVaultQuery } from './LlmTypes';
import { READ_OUTPUT_KINDS } from './LlmTypes';
import { getDatabaseDir } from '../Settings/Settings';
import { getErrorMessage } from '../utils/ErrorMessages';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('GeneratedSqlCache');
const CACHE_FILE_NAME = 'llm-cache.json';
const MAX_CACHE_ENTRIES = 200;

interface StoredGeneration extends GeneratedVaultQuery {
  key: string;
}

export class GeneratedSqlCache {
  private loading: Promise<Map<string, GeneratedVaultQuery>> | null = null;

  public constructor(private app: App) {}

  public async get(key: string): Promise<GeneratedVaultQuery | null> {
    return (await this.load()).get(key) ?? null;
  }

  public async set(key: string, generation: GeneratedVaultQuery): Promise<void> {
    const entries = await this.load();
    entries.delete(key);

    entries.set(key, {
      sql: generation.sql,
      statementKind: generation.statementKind,
      outputKind: generation.outputKind,
      outputOptions: generation.outputOptions ? { ...generation.outputOptions } : undefined
    });

    while (entries.size > MAX_CACHE_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }

    await this.persist(entries);
  }

  public async invalidate(key: string): Promise<void> {
    const entries = await this.load();

    if (entries.delete(key)) {
      await this.persist(entries);
    }
  }

  private get directory(): string {
    return getDatabaseDir(this.app.vault.configDir);
  }

  private get path(): string {
    return `${this.directory}/${CACHE_FILE_NAME}`;
  }

  private load(): Promise<Map<string, GeneratedVaultQuery>> {
    if (!this.loading) {
      this.loading = this.read();
    }

    return this.loading;
  }

  private async read(): Promise<Map<string, GeneratedVaultQuery>> {
    const entries = new Map<string, GeneratedVaultQuery>();

    try {
      const adapter = this.app.vault.adapter;

      if (!(await adapter.exists(this.path))) {
        return entries;
      }

      const stored = JSON.parse(await adapter.read(this.path)) as StoredGeneration[];

      if (!Array.isArray(stored)) {
        return entries;
      }

      for (const entry of stored) {
        if (typeof entry?.key !== 'string' || typeof entry.sql !== 'string'
          || !READ_OUTPUT_KINDS.has(entry.outputKind)
          || (entry.statementKind !== 'read' && entry.statementKind !== 'write')) continue;
        const { key, sql, statementKind, outputKind, outputOptions } = entry;
        if (outputOptions !== undefined && (!outputOptions || typeof outputOptions !== 'object'
          || Array.isArray(outputOptions) || Object.values(outputOptions).some(value => typeof value !== 'string'))) continue;
        entries.set(key, { sql, statementKind, outputKind, outputOptions });
      }
    }
    catch (error: unknown) {
      logger.warn('Failed to read the generated SQL cache', getErrorMessage(error));
    }

    return entries;
  }

  private async persist(entries: Map<string, GeneratedVaultQuery>): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;

      if (!(await adapter.exists(this.directory))) {
        await adapter.mkdir(this.directory);
      }

      const stored: StoredGeneration[] = Array.from(entries, ([key, generation]) => ({ key, ...generation }));
      await adapter.write(this.path, JSON.stringify(stored));
    }
    catch (error: unknown) {
      logger.warn('Failed to save the generated SQL cache', getErrorMessage(error));
    }
  }
}
