import { Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import type { VaultDatabase } from '../Database/DatabaseService';
import type { VaultQuerySettings } from '../Settings/Settings';
import type { PreviewResult } from '../Services/PreviewService';
import { otherFileWriteStatements } from '../utils/SQLParsingUtils';
import { sha256Hex } from '../utils/Sha256';
import { getErrorMessage } from '../utils/ErrorMessages';
import { logger } from '../utils/logger';
import { createFileWithFolders, resolveVaultFile } from '../utils/VaultUtils';
import { processFileContents } from '../WriteSync/FileWriteOperations';
import { PreparedFileWriteRegistry } from '../WriteSync/PreparedFileWriteRegistry';
import { FilePreviewStaleError, FileWriteApplyError } from '../WriteSync/FileWriteTypes';
import type { FileWritePhase } from '../WriteSync/FileWriteTypes';
import { classifyFileContents, isIndexablePath } from './OtherFileContentSettings';
import { pathExtension, pathParent } from '../utils/PathUtils';
import { fileContentBytes } from './OtherFileWriteStaging';
import type { OtherFileIndexingService } from './OtherFileIndexingService';

interface PreparedFile {
  path: string;
  originalHash?: string;
  originalText?: string;
  output: string | Uint8Array | null;
  outputHash?: string;
}
interface PreparedOtherFiles {
  files: PreparedFile[];
  limit: number;
}

export class OtherFileWriteService {
  constructor(private readonly app: App, private readonly database: VaultDatabase,
    private readonly indexing: OtherFileIndexingService, private readonly settings: VaultQuerySettings,
    private readonly plans: PreparedFileWriteRegistry,
    private readonly refresh: (paths: string[]) => Promise<string[]>) {}

  async preview(sql: string, params: unknown[]): Promise<PreviewResult> {
    const assertAccess = this.plans.captureAccess('other_files');
    const statements = otherFileWriteStatements(sql);
    await this.indexing.waitForIdle();
    const limit = this.settings.maxFileSizeKB * 1024;
    const staged = await this.database.stageOtherFileWrites(sql, params, { maxFileBytes: limit });
    assertAccess();
    const files: PreparedFile[] = [], operations: PreviewResult[] = [];

    const emptyPreview = (op: PreviewResult['op']): PreviewResult => ({
      op, table: 'other_files', pkCols: ['path'], ids: [], before: [], after: [], sqlToApply: [],
    });

    for (const row of staged) {
      this.assertPath(row.path);
      const originalHash = row.original === null ? undefined : await sha256Hex(fileContentBytes(row.original));
      const outputBytes = row.output === null ? null : fileContentBytes(row.output);
      const output = outputBytes === null ? null : classifyFileContents(outputBytes);
      const outputHash = outputBytes === null ? undefined : await sha256Hex(outputBytes);

      const file: PreparedFile = { path: row.path, originalHash,
        originalText: typeof row.original === 'string' && typeof output === 'string' ? row.original : undefined,
        output, outputHash };

      try {
        await this.checkSource(file, limit);
      }
      catch (error) {
        await this.refresh([row.path]).catch(() => []);
        throw error;
      }

      assertAccess();
      if (originalHash === outputHash) continue;
      files.push(file);
      const op = originalHash === undefined ? 'insert' : output === null ? 'delete' : 'update';
      let operation = operations.find(result => result.op === op);

      if (!operation) {
        operation = emptyPreview(op);
        operations.push(operation);
      }

      operation.ids.push([row.path]);
      if (row.original !== null) operation.before.push({ path: row.path, content: row.original });
      if (output !== null) operation.after.push({ path: row.path, content: output instanceof Uint8Array ? output.slice() : output });
    }

    const planId = this.plans.add('other_files', files.map(file => file.path),
      { files, limit } satisfies PreparedOtherFiles, assertAccess);

    const preview = operations.length > 1 ? { ...emptyPreview('multi'), multiResults: operations }
      : operations[0] ?? emptyPreview(statements[0].op);

    return { ...preview, planId, sqlToApply: statements.map(statement => ({ sql: statement.sql, params })) };
  }

  apply(id: string | undefined): Promise<string[]> {
    return this.plans.consume<PreparedOtherFiles, string[]>(id, 'other_files', async (plan, assertAccess) => {
      const completed: string[] = [], unknown: string[] = [], attempted: string[] = [];
      let failedPath: string | undefined, phase: FileWritePhase = 'preflight', failure: unknown;

      try {
        assertAccess();
        await this.indexing.waitForIdle();

        for (const file of plan.files) {
          failedPath = file.path;
          this.assertPath(file.path);
          await this.checkSource(file, plan.limit);
        }

        for (const file of plan.files) {
          failedPath = file.path;
          let metadata: ReturnType<OtherFileWriteService['watchMetadata']>;

          try {
            await this.plans.withPath(file.path, async () => {
              phase = 'preflight';
              assertAccess();
              this.assertPath(file.path);
              const current = await this.checkSource(file, plan.limit);
              assertAccess();
              metadata = this.watchMetadata(file);
              phase = 'write';
              attempted.push(file.path);
              let writeError: unknown;

              try {
                if (file.output === null) await this.app.fileManager.trashFile(current!);
                else if (!current) {
                  await createFileWithFolders(this.app.vault, file.path, file.output);
                } else if (file.originalText !== undefined && typeof file.output === 'string') {
                  await processFileContents(this.app.vault, current, file.path, file.originalText, file.output,
                    assertAccess);
                } else await this.app.vault.modifyBinary(current, fileContentBytes(file.output).slice().buffer);
              } catch (error) {
                writeError = error;
              }

              if (writeError instanceof FilePreviewStaleError) throw writeError;
              phase = 'verify';

              try {
                const current = this.getFile(file.path);

                if (file.output === null) {
                  if (this.app.vault.getAbstractFileByPath(file.path)) throw new Error(`File still exists after deletion: ${file.path}`);
                } else if (!current || await sha256Hex(await this.read(current, plan.limit)) !== file.outputHash) {
                  throw new Error(`File contents do not match the prepared output: ${file.path}`);
                }
              } catch (error) {
                unknown.push(file.path); throw error;
              }

              completed.push(file.path);
              if (writeError) logger.warn(`File write reported an error after the expected change: ${file.path}`, writeError);
            });

            phase = 'index';
            if (metadata && !await metadata.wait()) new Notice(`File written; Markdown metadata indexing is pending: ${file.path}`);
          } finally {
            metadata?.cancel();
          }
        }

        failedPath = undefined;
      } catch (error) {
        failure = error;
      }

      const paths = attempted.length ? attempted : failedPath ? [failedPath] : [];

      if (paths.length) {
        let indexingError: unknown;

        try {
          const diagnostics = await this.refresh(paths);
          if (diagnostics.length) indexingError = new Error(diagnostics.join('\n'));
        } catch (error) {
          indexingError = error;
        }

        if (indexingError && !failure) { phase = 'index'; failure = indexingError; }

        try {
          await this.database.saveToDisk({ throwOnError: true });
        }
        catch (error) {
          if (!failure) { phase = 'save'; failure = error; }
        }
      }

      if (failure) {
        if (!attempted.length && failure instanceof FilePreviewStaleError) throw failure;
        const untouched = plan.files.map(file => file.path).filter(path => !completed.includes(path) && !unknown.includes(path));
        const message = `${getErrorMessage(failure)} Completed files: ${completed.length}. Unverified files: ${unknown.length}. Unchanged files: ${untouched.length}.`;
        throw new FileWriteApplyError(message, phase, completed, unknown, untouched, failedPath);
      }

      return completed;
    });
  }

  private watchMetadata(file: PreparedFile): { wait: () => Promise<boolean>; cancel: () => void } | undefined {
    if (pathExtension(file.path).toLowerCase() !== 'md' || file.output === null) return;
    const expected = new TextDecoder().decode(fileContentBytes(file.output));
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });

    const ref = this.app.metadataCache.on('changed', (changed, data) => {
      if (changed.path === file.path && data.replace(/^\uFEFF/, '') === expected) finish();
    });

    let timer: number | undefined;

    return {
      wait: () => Promise.race([ready.then(() => true), new Promise<boolean>(resolve => {
        timer = window.setTimeout(() => resolve(false), 10_000);
      })]),
      cancel: () => { this.app.metadataCache.offref(ref); if (timer !== undefined) window.clearTimeout(timer); },
    };
  }

  private assertPath(path: string): void {
    if (typeof path !== 'string' || !isIndexablePath(path) || normalizePath(path) !== path || !this.indexing.selected(path)) {
      throw new Error(`File path is not selected for content indexing: ${String(path)}`);
    }
  }

  private getFile(path: string): TFile | null {
    return resolveVaultFile(this.app.vault, path);
  }

  private async checkSource(file: PreparedFile, limit: number): Promise<TFile | null> {
    const current = this.getFile(file.path);
    if (current && current.path !== file.path) throw new FilePreviewStaleError(`File path spelling changed: ${file.path}`);

    if (file.originalHash === undefined) {
      if (this.app.vault.getAbstractFileByPath(file.path)) throw new FilePreviewStaleError(`File already exists: ${file.path}`);
      const parent = pathParent(file.path);
      const folder = this.app.vault.getAbstractFileByPath(parent);

      if (parent && folder && !(folder instanceof TFolder)) {
        throw new FilePreviewStaleError(`Parent path is not a folder: ${parent}`);
      }
    } else if (!current || await sha256Hex(await this.read(current, limit)) !== file.originalHash) {
      throw new FilePreviewStaleError(`File changed since the indexed preview: ${file.path}`);
    }

    if (current && (current.path !== file.path || this.getFile(file.path) !== current)) throw new FilePreviewStaleError(`File moved during reading: ${file.path}`);

    return current;
  }

  private async read(file: TFile, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    const { size, mtime, ctime } = file.stat, path = file.path;
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new FilePreviewStaleError(`File exceeds the write limit: ${path}`);
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    const current = this.getFile(path);
    if (!current || current !== file || current.path !== path || current.stat.size !== size || current.stat.mtime !== mtime
      || current.stat.ctime !== ctime || bytes.byteLength !== size) throw new FilePreviewStaleError(`File changed during reading: ${path}`);

    return bytes;
  }
}
