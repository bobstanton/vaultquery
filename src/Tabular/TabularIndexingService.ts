import { isDataFilePath } from './TabularTableOwnership';
import { SerialQueue } from '../utils/SerialQueue';
import { sqliteIdentifierKey } from '../utils/SqlIdentifierUtils';
import type { DataFileDatabaseOperations, IndexedDataFile } from './TabularDatabaseOperations';
import { dataFileParseLimits } from './TabularLimits';
import { readDataFile, vaultDataFileSource } from './TabularFileReader';
import type { DataFileAdapter } from './TabularFileReader';
import { DataFileError } from './TabularTypes';
import { PathExclusions } from '../utils/PathExclusions';
import { assertDataFileReads } from './TabularAccess';
import type { TabularDocument } from './TabularTypes';
import type { VaultQuerySettings } from '../Settings/Settings';
import { getErrorMessage } from '../utils/ErrorMessages';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('DataFiles');

export interface ExternalCsvMembership {
  selects(path: string): boolean;
  retains(path: string): boolean;
}

interface CsvVault {
  getFiles(): readonly { path: string }[];
  adapter: DataFileAdapter;
}

interface CsvStore {
  withCsvOperations<T>(work: (operations: DataFileDatabaseOperations) => T): Promise<T>;
}

export type CsvPublication =
  | { kind: 'reset' }
  | { kind: 'remove'; path: string }
  | { kind: 'unavailable'; source: IndexedDataFile }
  | { kind: 'ready'; document: TabularDocument; revision: string; mtime: number; isUpdate?: boolean };

export function csvPublicationPath(publication: Exclude<CsvPublication, { kind: 'reset' }>): string {
  return publication.kind === 'ready' ? publication.document.path
    : publication.kind === 'unavailable' ? publication.source.path : publication.path;
}

interface CsvBatchResult {
  filesIndexed: number;
  filesRemoved: number;
  failedPaths: string[];
  failedRemovalPaths: string[];
}

export class DataFileIndexingService {
  private readonly queue = new SerialQueue();
  private initialized = false;
  private settingsRevision = 0;
  private readonly sources = new Map<string, IndexedDataFile>();
  private sourceList?: readonly IndexedDataFile[];
  private readonly sourcePathsByKey = new Map<string, Set<string>>();
  private readonly dirty = new Map<string, number>();
  private readonly recoveryTimers = new Map<string, number>();
  private readonly recoveryAttempts = new Map<string, number>();
  private disposed = false;
  private readonly exclusions = new PathExclusions();

  public constructor(
    private readonly vault: CsvVault,
    private readonly settings: Pick<VaultQuerySettings, 'enableDataFileReads' | 'excludePatterns' | 'dataFileMaxSizeMiB'>,
    private readonly database: CsvStore,
    private readonly publish: (publication: CsvPublication) => Promise<void>,
    private readonly onRecovery: () => Promise<void> = async () => {},
    private readonly external?: ExternalCsvMembership,
  ) {}

  public shouldIndex(path: string): boolean {
    if (!this.settings.enableDataFileReads || !isDataFilePath(path)) return false;
    if (this.external?.retains(path)) return false;
    if (this.external?.selects(path)) return true;

    return !this.exclusions.matches(path, this.settings.excludePatterns);
  }

  public updateSettings(): Promise<CsvBatchResult> {
    this.settingsRevision++;

    for (const path of this.recoveryTimers.keys()) {
      this.cancelRecovery(path);
    }

    return this.reconcile(true);
  }

  public hasPendingSources(paths: Iterable<string>): boolean {
    const keys = new Set(Array.from(paths, sqliteIdentifierKey));

    return Array.from(this.dirty.keys()).some(path => keys.has(sqliteIdentifierKey(path)));
  }

  public getSources(): readonly IndexedDataFile[] {
    return this.sourceList ??= [...this.sources.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  private setSource(source: IndexedDataFile): void {
    this.sources.set(source.path, source);
    const key = sqliteIdentifierKey(source.path);
    let paths = this.sourcePathsByKey.get(key);
    if (!paths) this.sourcePathsByKey.set(key, paths = new Set());
    paths.add(source.path);
    this.sourceList = undefined;
  }

  public hasReadyRelation(name: string): boolean {
    for (const path of this.sourcePathsByKey.get(sqliteIdentifierKey(name)) ?? []) {
      if (this.sources.get(path)?.status === 'ready') return true;
    }

    return false;
  }

  public invalidate(path: string): void {
    this.cancelRecovery(path);
    this.dirty.set(path, (this.dirty.get(path) ?? 0) + 1);
  }

  public dispose(): void {
    this.disposed = true;

    for (const path of this.recoveryTimers.keys()) {
      this.cancelRecovery(path);
    }

    this.recoveryAttempts.clear();
  }

  private cancelRecovery(path: string): void {
    const timer = this.recoveryTimers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.recoveryTimers.delete(path);
    this.recoveryAttempts.delete(path);
  }

  private scheduleRecovery(path: string): void {
    const delays = [1000, 5000, 15000];
    const attempt = this.recoveryAttempts.get(path) ?? 0;
    if (this.disposed || !this.shouldIndex(path) || this.recoveryTimers.has(path) || attempt >= delays.length) return;
    this.recoveryAttempts.set(path, attempt + 1);

    this.recoveryTimers.set(path, window.setTimeout(() => {
      this.recoveryTimers.delete(path);

      void this.queue.enqueue(async () => {
        if (this.disposed) return;
        await this.process([], [path]);
        if (!this.disposed) await this.onRecovery().catch(error => logger.warn('Could not persist data file recovery', error));
      }).catch((error: unknown) => {
        logger.warn('Data file recovery failed', { path, error });
        this.scheduleRecovery(path);
      });
    }, delays[attempt]));
  }

  public waitForIdle(): Promise<void> { return this.queue.waitForIdle(); }

  public assertReady(path: string): void {
    assertDataFileReads(this.settings);
    const key = sqliteIdentifierKey(path);

    if (Array.from(this.dirty.keys()).some(candidate => sqliteIdentifierKey(candidate) === key)) {
      throw new DataFileError(path, 'source-changed', 'The file changed and is waiting to be indexed.');
    }

    const matches = [...this.sourcePathsByKey.get(key) ?? []].map(path => this.sources.get(path)!);

    if (matches.length !== 1 || matches[0].status !== 'ready') {
      throw new DataFileError(path, 'source-changed', matches.find(source => source.error)?.error ?? 'The file is missing, excluded, or has not been indexed.');
    }
  }

  public reconcile(force = false): Promise<CsvBatchResult> {
    return this.queue.enqueue(async () => {
      await this.initialize(force);
      const files = this.settings.enableDataFileReads ? this.vault.getFiles() : [];
      const paths = files.map(file => file.path).filter(path => this.shouldIndex(path)).sort();
      const current = new Set(paths);

      const stale = [...this.sources.keys()].filter(path => !current.has(path) && !this.external?.retains(path));

      return this.process(stale, paths, files);
    });
  }

  public processBatch(removals: readonly string[], candidates: readonly string[]): Promise<CsvBatchResult> {
    return this.queue.enqueue(async () => {
      await this.initialize(false);

      return this.process(removals, candidates);
    });
  }

  public deindex(path: string): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.initialize(false);
      await this.remove(path);
    });
  }

  public exclusive<T>(work: (refresh: (path: string, capture?: (source: Awaited<ReturnType<typeof readDataFile>>) => void) => Promise<CsvBatchResult>) => Promise<T>): Promise<T> {
    return this.queue.enqueue(() => work((path, capture) => this.process([], [path], undefined, capture)));
  }

  private async initialize(force: boolean): Promise<void> {
    if (this.initialized && !force) return;

    for (const path of this.recoveryTimers.keys()) {
      this.cancelRecovery(path);
    }

    this.recoveryAttempts.clear();
    await this.database.withCsvOperations(operations => operations.clear());
    this.sources.clear();
    this.sourcePathsByKey.clear();
    this.sourceList = undefined;
    this.dirty.clear();
    await this.publish({ kind: 'reset' });
    this.initialized = true;
  }

  private async remove(path: string): Promise<void> {
    this.cancelRecovery(path);
    await this.database.withCsvOperations(operations => operations.remove(path));
    this.dirty.delete(path);
    this.sources.delete(path);
    const key = sqliteIdentifierKey(path);
    const paths = this.sourcePathsByKey.get(key);
    paths?.delete(path);
    if (!paths?.size) this.sourcePathsByKey.delete(key);
    this.sourceList = undefined;
    await this.publish({ kind: 'remove', path });
  }

  private async process(
    removals: readonly string[], candidates: readonly string[], files?: readonly { path: string }[],
    capture?: (source: Awaited<ReturnType<typeof readDataFile>>) => void
  ): Promise<CsvBatchResult> {
    const result: CsvBatchResult = { filesIndexed: 0, filesRemoved: 0, failedPaths: [], failedRemovalPaths: [] };

    for (const path of new Set(removals)) {
      if (this.external?.retains(path)) continue;

      try {
        await this.remove(path); result.filesRemoved++;
      }
      catch (error) {
        logger.error('Data file removal failed', { path, error }); result.failedRemovalPaths.push(path);
      }
    }

    const groups = new Map<string, string[]>();
    const candidateKeys = new Set([...removals, ...candidates].map(sqliteIdentifierKey));

    for (const file of this.settings.enableDataFileReads ? files ?? this.vault.getFiles() : []) {
      const key = sqliteIdentifierKey(file.path);
      if (!candidateKeys.has(key) || !this.shouldIndex(file.path)) continue;
      const group = groups.get(key);
      if (group) group.push(file.path);
      else groups.set(key, [file.path]);
    }

    const paths = new Set(candidates);

    for (const path of candidates) {
      for (const collision of groups.get(sqliteIdentifierKey(path)) ?? []) {
        paths.add(collision);
      }
    }

    for (const path of removals) {
      for (const survivor of groups.get(sqliteIdentifierKey(path)) ?? []) {
        paths.add(survivor);
      }
    }

    for (const path of paths) {
      if (this.external?.retains(path)) continue;
      if (result.failedRemovalPaths.includes(path)) { result.failedPaths.push(path); continue; }
      let changed = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = this.dirty.get(path);
        const settingsRevision = this.settingsRevision;
        const cancelled = () => !this.settings.enableDataFileReads || settingsRevision !== this.settingsRevision;

        try {
          if (!this.shouldIndex(path) || !groups.get(sqliteIdentifierKey(path))?.includes(path)) {
            await this.remove(path);
            result.filesRemoved++;
            break;
          }

          if ((groups.get(sqliteIdentifierKey(path))?.length ?? 0) > 1) {
            throw new DataFileError(path, 'ownership', 'Multiple vault paths resolve to the same SQLite relation name. Rename or exclude one of the files.');
          }

          const file = vaultDataFileSource(this.vault.adapter, path, () => {
            if (cancelled()) throw new Error('Indexing was canceled.');
          });

          const { document, mtime, revision } = await readDataFile(file, dataFileParseLimits(this.settings.dataFileMaxSizeMiB));
          if (cancelled()) break;
          const latest = await file.stat();
          if (cancelled()) break;

          if (!latest || latest.mtime !== mtime || latest.size !== document.sourceBytes || generation !== this.dirty.get(path)) {
            throw new DataFileError(path, 'source-changed', 'The source changed before publication; queue a fresh index.');
          }

          capture?.({ document, mtime, revision });
          const previous = this.sources.get(path);

          if (previous?.status === 'ready' && previous.revision === revision && previous.mtime === mtime) {
            this.cancelRecovery(path);
            this.dirty.delete(path);
            break;
          }

          await this.database.withCsvOperations(operations => {
            if (!cancelled()) operations.replaceSnapshot(document, revision, mtime);
          });

          if (cancelled()) break;

          this.setSource({ path, relationName: path, columns: [...document.columns], revision, mtime,
            sourceBytes: document.sourceBytes, format: document.format, status: 'ready', error: null });

          changed = true;
          await this.publish({ kind: 'ready', document, revision, mtime, isUpdate: previous !== undefined });

          if (generation !== this.dirty.get(path)) {
            throw new DataFileError(path, 'source-changed', 'The source changed during publication; queue a fresh index.');
          }

          this.cancelRecovery(path);
          this.dirty.delete(path);
          break;
        }
        catch (error) {
          if (cancelled()) break;
          if (attempt < 2 && (generation !== this.dirty.get(path) || error instanceof DataFileError && error.code === 'source-changed')) continue;
          const message = getErrorMessage(error);
          logger.warn('Data file indexing failed', { path, error: message });

          try {
            const source = await this.database.withCsvOperations(operations => {
              if (cancelled()) return;
              operations.markUnavailable(path, message);

              return operations.getSource(path)!;
            });

            if (cancelled() || !source) break;
            this.setSource(source);
            changed = true;
            await this.publish({ kind: 'unavailable', source });
          }
          catch (failure) {
            logger.error('Could not record a data file failure', { path, error: failure });
            result.failedPaths.push(path);
            this.scheduleRecovery(path);
            break;
          }

          if (!(error instanceof DataFileError) || error.code === 'io' || error.code === 'source-changed') this.scheduleRecovery(path);
          else this.cancelRecovery(path);
          if (generation === this.dirty.get(path)) this.dirty.delete(path);

          if ((error instanceof DataFileError && error.code === 'source-changed') || generation !== this.dirty.get(path) && this.dirty.has(path)) {
            result.failedPaths.push(path);
          }

          break;
        }
      }

      if (changed) result.filesIndexed++;
    }

    return result;
  }
}
