import { isDataFilePath } from './TabularTableOwnership';
import { isAbsoluteRootPath } from '../External/ExternalRootSettings';
import { sqliteIdentifierKey } from '../utils/SqlIdentifierUtils';
import { sha256Hex } from '../utils/Sha256';
import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { VaultDatabase } from '../Database/DatabaseService';
import type { PreviewResult } from '../Services/PreviewService';
import type { VaultQuerySettings } from '../Settings/Settings';
import { csvInsertColumns, extractDmlTargetSchema, extractDmlTargetTable, splitSqlStatements } from '../utils/SQLParsingUtils';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/ErrorMessages';
import { DataFileIndexingService } from './TabularIndexingService';
import { dataFileParseLimits } from './TabularLimits';
import { readDataFileBytes, vaultDataFileSource } from './TabularFileReader';
import type { readDataFile } from './TabularFileReader';
import { serializeDataFile } from './TabularByteDecoder';
import { stagedRowOrigins } from './TabularDatabaseOperations';
import { columnNames, DataFileError } from './TabularTypes';
import { FilePreviewStaleError, FileWriteApplyError } from '../WriteSync/FileWriteTypes';
import type { FileWritePhase } from '../WriteSync/FileWriteTypes';
import { processFileContents } from '../WriteSync/FileWriteOperations';
import { PreparedFileWriteRegistry } from '../WriteSync/PreparedFileWriteRegistry';

function assertVaultDataFilePath(path: string): void {
  if (isAbsoluteRootPath(path)) throw new Error(`Files outside the vault are read-only: ${path}`);
}

interface PreparedCsvWrite {
  readonly path: string;
  readonly revision: string;
  readonly headers: string;
  readonly original: string;
  readonly output: string;
  readonly outputRevision: string;
}

export function csvWriteTarget(sql: string): string | null {
  const statements = splitSqlStatements(sql);
  const targets = statements.map(extractDmlTargetTable);
  const target = targets.find((path): path is string => path !== null && isDataFilePath(path));
  if (!target) return null;

  if (targets.some(path => path === null || sqliteIdentifierKey(path) !== sqliteIdentifierKey(target))) {
    throw new DataFileError(target, 'ownership', 'A write batch must target one data file; mixing it with Markdown or other data files is not supported.');
  }

  for (const statement of statements) {
    const schema = extractDmlTargetSchema(statement);
    if (schema && schema.toLowerCase() !== 'main') throw new DataFileError(target, 'ownership', 'Data file writes must target the main database.');
    const columns = csvInsertColumns(statement);
    if (columns === null) throw new DataFileError(target, 'format', 'INSERT requires an explicit field list or DEFAULT VALUES.');

    if (columns.some(column => /^_vq_/i.test(column) || /^(rowid|_rowid_|oid)$/i.test(column))) {
      throw new DataFileError(target, 'format', 'Row identities cannot be supplied in INSERT.');
    }
  }

  return target;
}

export class CsvWriteService {
  public constructor(
    private readonly app: App,
    private readonly database: VaultDatabase,
    private readonly indexing: DataFileIndexingService,
    private readonly settings: Pick<VaultQuerySettings, 'dataFileMaxSizeMiB'>,
    private readonly plans: PreparedFileWriteRegistry,
    private readonly refresh: (paths: string[]) => Promise<string[]>,
  ) {}

  public preview(path: string, sql: string, params: unknown[]): Promise<PreviewResult> {
    const assertAccess = this.plans.captureAccess('data-file');
    assertVaultDataFilePath(path);

    return this.indexing.exclusive(async refresh => {
      assertAccess();
      this.indexing.assertReady(path);
      let captured: Awaited<ReturnType<typeof readDataFile>> | undefined;
      await refresh(path, source => { captured = source; });
      this.indexing.assertReady(path);
      if (!captured) throw new FilePreviewStaleError('The source was not captured. Generate a fresh preview.');
      const source = this.indexing.getSources().find(source => sqliteIdentifierKey(source.path) === sqliteIdentifierKey(path))!;
      path = source.path;
      const { document, mtime, revision } = captured;
      assertAccess();

      if (revision !== source.revision || JSON.stringify(columnNames(document.columns)) !== JSON.stringify(columnNames(source.columns)) || mtime !== source.mtime) {
        throw new DataFileError(path, 'source-changed', 'The file changed since indexing. Reindex it and generate a fresh preview.');
      }

      const staged = await this.database.stageCsvWrites(path, sql, params);
      assertAccess();
      const origins = stagedRowOrigins(staged.preview, document.rows.length, staged.rows.length);
      const output = serializeDataFile(document, staged.rows, dataFileParseLimits(this.settings.dataFileMaxSizeMiB), origins);
      const outputRevision = output === document.source ? revision : await this.revision(output);
      assertAccess();

      const id = this.plans.add('data-file', [path], { path, revision, headers: JSON.stringify(columnNames(document.columns)),
        original: document.source, output, outputRevision } satisfies PreparedCsvWrite, assertAccess);

      const decorate = (result: PreviewResult): void => {
        result.dataFileColumns = columnNames(document.columns);
        result.multiResults?.forEach(decorate);
      };

      decorate(staged.preview);
      staged.preview.planId = id;

      return staged.preview;
    });
  }

  public apply(id: string | undefined): Promise<string[]> {
    return this.plans.consume<PreparedCsvWrite, string[]>(id, 'data-file', async (plan, assertAccess) => {
      const state: { phase: FileWritePhase } = { phase: 'preflight' };
      let failure: unknown;
      let attempted = false, completed = false, unchanged = false;

      try {
        await this.indexing.exclusive(async () => {
          assertAccess();

          try {
            this.indexing.assertReady(plan.path);
          }
          catch (error) {
            throw new FilePreviewStaleError(getErrorMessage(error));
          }

          const current = this.indexing.getSources().find(source => source.path === plan.path);

          if (!current || current.revision !== plan.revision || JSON.stringify(columnNames(current.columns)) !== plan.headers || !this.indexing.shouldIndex(plan.path)) {
            throw new FilePreviewStaleError('The source or its columns changed. Generate a fresh preview.');
          }

          const { revision } = await readDataFileBytes(vaultDataFileSource(this.app.vault.adapter, plan.path, assertAccess), dataFileParseLimits(this.settings.dataFileMaxSizeMiB));
          if (revision !== plan.revision) throw new FilePreviewStaleError('The file changed after the preview. Generate a fresh preview.');
          assertAccess();

          if (plan.output === plan.original) {
            unchanged = true;

            return;
          }

          const file = this.app.vault.getAbstractFileByPath(plan.path);
          if (!(file instanceof TFile)) throw new FilePreviewStaleError('The file no longer exists.');

          await this.plans.withPath(plan.path, async () => {
            assertAccess();
            let writeError: unknown;
            let rejected = false;
            state.phase = 'write';

            try {
              await processFileContents(this.app.vault, file, plan.path, plan.original, plan.output, () => {
                try {
                  assertAccess();
                }
                catch (error) {
                  rejected = true; throw error;
                }

                attempted = true;
              });
            } catch (error) {
              if (rejected || error instanceof FilePreviewStaleError) { attempted = false; throw error; }
              attempted = true;
              writeError = error;
            }

            state.phase = 'verify';
            const verified = await readDataFileBytes(vaultDataFileSource(this.app.vault.adapter, plan.path, assertAccess), dataFileParseLimits(this.settings.dataFileMaxSizeMiB));
            if (verified.revision !== plan.outputRevision) throw new Error('The file was edited again after applying. Generate a fresh preview.');
            completed = true;
            if (writeError) logger.warn(`Data file write reported an error after the expected change: ${plan.path}`, writeError);
          });
        });
      } catch (error) {
        failure = error;
      }

      if (unchanged) return [];

      let diagnostics: string[];

      try {
        diagnostics = await this.refresh([plan.path]);
      }
      catch (error) {
        diagnostics = [getErrorMessage(error)];
      }

      const indexed = this.indexing.getSources().find(source => source.path === plan.path);

      if (attempted) {
        if (diagnostics.length || indexed?.status !== 'ready') {
          const message = `Indexing failed: ${diagnostics.join('\n') || indexed?.error || 'source changed again'}. Transient failures are retried automatically; reindex if the source remains unavailable.`;
          if (!failure) state.phase = 'index';
          failure = new Error(failure ? `${getErrorMessage(failure)}\n${message}` : message);
        } else if (indexed.revision !== plan.outputRevision) {
          completed = false;
          state.phase = 'verify';
          failure = new Error('The file was edited again after applying. The index contains the newer file; generate a fresh preview.');
        } else if (state.phase === 'verify') {
          try {
            assertAccess(); completed = true; failure = undefined;
          }
          catch (error) {
            failure = error;
          }
        }
      }

      try {
        await this.database.saveToDisk({ throwOnError: true });
      }
      catch (error) {
        if (!failure) { state.phase = 'save'; failure = error; }
      }

      if (failure) {
        if (!attempted && failure instanceof FilePreviewStaleError) throw failure;
        throw new FileWriteApplyError(getErrorMessage(failure), state.phase, completed ? [plan.path] : [],
          attempted && !completed ? [plan.path] : [], attempted ? [] : [plan.path], plan.path);
      }

      return completed ? [plan.path] : [];
    });
  }

  private async revision(source: string): Promise<string> {
    return sha256Hex(new TextEncoder().encode(source));
  }
}
