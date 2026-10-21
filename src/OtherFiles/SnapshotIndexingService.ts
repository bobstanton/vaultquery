import { SerialQueue } from '../utils/SerialQueue';
import { mapConcurrent } from '../utils/Concurrent';
import { PathExclusions } from '../utils/PathExclusions';
import { fileMetadata } from './OtherFileContentSettings';
import type { IndexableFile, OtherFileMetadata } from './OtherFileTypes';
import type { SnapshotPublication } from './SnapshotTable';
import type { RealtimeIndexBatchResult } from '../Services/IndexingService';

const BATCH_ROWS = 64;
const BATCH_BYTES = 1024 * 1024;
const PUBLICATION_ROWS = 512;
const PUBLICATION_BYTES = 1024 * 1024;
const YIELD_INTERVAL_MS = 8;

export interface ExternalFileMembership {
  selects(path: string): boolean;
  sourceFor(path: string): string | undefined;
  retains(path: string): boolean;
}

export interface SnapshotVault {
  getFiles(): readonly IndexableFile[];
  getFile(path: string): IndexableFile | null;
  read(file: IndexableFile): Promise<ArrayBuffer>;
}

export interface SnapshotOperations<State, Row> {
  list(): State[];
  apply(publication: SnapshotPublication<Row>): void;
}

export interface SnapshotRead<Row> {
  row: Row;
  generation: number | undefined;
  timing?: SnapshotReadTiming;
}

export interface SnapshotReadTiming {
  readMs: number;
  parseMs: number;
  normalizeMs: number;
  bytesRead: number;
  prefixReads: number;
  readCalls: number;
}

export interface SnapshotTiming {
  phase: 'batch' | 'complete' | 'cancelled' | 'error';
  elapsedMs: number;
  candidates: number;
  processed: number;
  filesRead: number;
  indexed: number;
  removed: number;
  failed: number;
  unavailable: number;
  bytesRead: number;
  prefixReads: number;
  readCalls: number;
  extendedFiles: number;
  databaseMs: number;
  publicationMs: number;
  /** Summed per-file timings overlap while reads are concurrent; these are not wall time. */
  fileTimeTotalsMs: { readWait: number; parse: number; normalize: number };
}

export interface SnapshotOptions<Store, Row> {
  database: () => Store | undefined;
  publish: (publication: SnapshotPublication<Row>) => Promise<void>;
  progress: (current: number, total: number, path: string) => void;
  external?: ExternalFileMembership;
  batchGrowth: number;
  readConcurrency: number;
  publicationIntervalMs?: number;
  diagnostics?: (timing: SnapshotTiming) => void;
}

interface PendingRead<Row> {
  row?: Row;
  generation?: number;
  failed?: boolean;
  timing?: SnapshotReadTiming;
}

/**
 * A read commits only if nothing touched its file while it ran: the file's
 * dirty generation and stat revision must both be what they were when it began.
 */
export abstract class SnapshotIndexingService<Store, State extends OtherFileMetadata, Row extends State, Vault extends SnapshotVault = SnapshotVault> {
  protected readonly exclusions = new PathExclusions();
  protected readonly dirty = new Map<string, number>();
  protected readonly external?: ExternalFileMembership;
  private readonly rows = new Map<string, State>();
  private readonly counts = new Map<string, number>();
  private readonly retries = new Set<string>();
  private readonly queue = new SerialQueue();
  private generation = 0;
  private settingsRevision = 0;
  private initialized?: Store;
  private disposed = false;
  public error?: string;

  protected constructor(protected readonly vault: Vault, private readonly options: SnapshotOptions<Store, Row>) {
    this.external = options.external;
  }

  public abstract get enabled(): boolean;
  public abstract selected(path: string): boolean;
  protected abstract withIndex<T>(store: Store, work: (operations: SnapshotOperations<State, Row>) => T): Promise<T>;
  protected abstract read(file: IndexableFile, metadata: OtherFileMetadata, cancelled: () => boolean): Promise<SnapshotRead<Row> | undefined>;
  protected abstract current(row: State): boolean;
  protected abstract ready(row: Row): boolean;
  protected abstract bytes(row: Row): number;
  protected abstract stateOf(row: Row): State;

  protected revisit(_row: State): boolean { return false; }

  protected metadata(file: IndexableFile): OtherFileMetadata {
    return fileMetadata(file, Date.now(), this.external?.sourceFor(file.path) ?? 'vault');
  }

  public paths(): string[] { return [...this.rows.keys()]; }
  public has(path: string): boolean { return this.rows.has(path); }
  public state(path: string): State | undefined { return this.rows.get(path); }

  public sourceCounts(): ReadonlyMap<string, number> { return this.counts; }
  public retryPaths(): string[] { return [...new Set([...this.retries, ...this.dirty.keys()])]; }

  private setRow(row: State): void {
    const previous = this.rows.get(row.path);

    if (previous?.source !== row.source) {
      if (previous) this.countSource(previous.source, -1);
      this.countSource(row.source, 1);
    }

    this.rows.set(row.path, row);
    if (this.current(row)) this.retries.delete(row.path);
    else this.retries.add(row.path);
  }

  private countSource(source: string, delta: number): void {
    const count = (this.counts.get(source) ?? 0) + delta;
    if (count) this.counts.set(source, count);
    else this.counts.delete(source);
  }

  public invalidate(path: string): void { if (this.has(path) || this.selected(path)) this.dirty.set(path, ++this.generation); }
  public updateSelection(): void { this.settingsRevision++; }
  public dispose(): void { this.disposed = true; this.settingsRevision++; }
  public waitForIdle(): Promise<void> { return this.queue.waitForIdle(); }
  public reconcile(full = true, force = false): Promise<RealtimeIndexBatchResult> { return this.enqueue([], undefined, full, force); }

  public processBatch(removals: readonly string[], paths: readonly string[]): Promise<RealtimeIndexBatchResult> {
    return this.enqueue(removals, paths, false, false);
  }

  private enqueue(removals: readonly string[], paths: readonly string[] | undefined, full: boolean, force: boolean): Promise<RealtimeIndexBatchResult> {
    return this.queue.enqueue(() => this.process(removals, paths, full, force));
  }

  private async process(removals: readonly string[], paths: readonly string[] | undefined, full: boolean, force: boolean): Promise<RealtimeIndexBatchResult> {
    const result: RealtimeIndexBatchResult = { filesIndexed: 0, filesRemoved: 0, failedPaths: [], failedRemovalPaths: [], unavailablePaths: [] };
    const database = this.options.database();
    if (!database || this.disposed) return result;
    const revision = this.settingsRevision;
    const cancelled = () => this.disposed || database !== this.options.database() || revision !== this.settingsRevision;
    const interval = this.options.publicationIntervalMs;
    const started = performance.now();

    const timing: SnapshotTiming = { phase: 'batch', elapsedMs: 0, candidates: 0, processed: 0, filesRead: 0, indexed: 0, removed: 0, failed: 0, unavailable: 0,
      bytesRead: 0, prefixReads: 0, readCalls: 0, extendedFiles: 0, databaseMs: 0, publicationMs: 0,
      fileTimeTotalsMs: { readWait: 0, parse: 0, normalize: 0 } };

    const report = (phase: SnapshotTiming['phase']) => this.options.diagnostics?.({ ...timing, phase,
      elapsedMs: Math.round(performance.now() - started), indexed: result.filesIndexed, removed: result.filesRemoved,
      failed: result.failedPaths.length, unavailable: result.unavailablePaths?.length ?? 0,
      databaseMs: Math.round(timing.databaseMs), publicationMs: Math.round(timing.publicationMs),
      fileTimeTotalsMs: { readWait: Math.round(timing.fileTimeTotalsMs.readWait), parse: Math.round(timing.fileTimeTotalsMs.parse),
        normalize: Math.round(timing.fileTimeTotalsMs.normalize) } });

    const withIndex = async <T>(work: (operations: SnapshotOperations<State, Row>) => T): Promise<T> => {
      const start = performance.now();

      try {
        return await this.withIndex(database, work);
      }
      finally {
        timing.databaseMs += performance.now() - start;
      }
    };

    const publishRows = async (rows: Row[], removed: string[]) => {
      const start = performance.now();

      try {
        await this.options.publish({ rows, removed });
      }
      catch (error) {
        this.error = error instanceof Error ? error.message : String(error); throw error;
      }
      finally {
        timing.publicationMs += performance.now() - start;
      }
    };

    let publication: Row[] = [];
    let publicationBytes = 0;
    let lastPublish = performance.now();

    const publish = async () => {
      if (!publication.length) return;
      const rows = publication;
      publication = []; publicationBytes = 0; lastPublish = performance.now();
      await publishRows(rows, []);
    };

    const stage = async (row: Row) => {
      const bytes = this.bytes(row);
      if (publication.length && publicationBytes + bytes > PUBLICATION_BYTES) await publish();
      publication.push(row); publicationBytes += bytes;
      if (publicationBytes >= PUBLICATION_BYTES || publication.length >= PUBLICATION_ROWS) await publish();
    };

    try {
      if (this.initialized !== database) {
        const stored = await withIndex(operations => operations.list());
        this.rows.clear();
        this.counts.clear();
        this.retries.clear();

        for (const row of stored) {
          this.setRow(row);
        }

        this.initialized = database;
      }

      const removed = new Set(removals.filter(path => !this.external?.retains(path)));
      const candidates = new Set(paths ?? []);

      if (paths === undefined) {
        for (const row of this.rows.values()) {
          if (this.external?.retains(row.path)) continue;
          if (!this.selected(row.path) || (full && !this.vault.getFile(row.path))) { removed.add(row.path); continue; }
          if (this.revisit(row)) candidates.add(row.path);
        }

        if (full) for (const file of this.vault.getFiles()) {
          if (this.selected(file.path)) candidates.add(file.path);
        }
      }

      if (removed.size) {
        await withIndex(operations => operations.apply({ rows: [], removed: [...removed] }));

        for (const path of removed) {
          const old = this.rows.get(path);
          if (old) { this.rows.delete(path); this.countSource(old.source, -1); result.filesRemoved++; }
          this.retries.delete(path);
          if (!candidates.has(path)) this.dirty.delete(path);
        }

        await publishRows([], [...removed]);
      }

      timing.candidates = candidates.size;
      let batch: Array<{ row: Row; generation: number | undefined }> = [];
      let batchBytes = 0;
      let lastYield = performance.now();
      // The first batches stay small so a reader sees rows quickly; a long sweep
      // may then commit in larger ones, because every batch costs a publication
      // and a refresh of the blocks reading the table.
      let growth = 1;

      const flush = async () => {
        if (!batch.length) return;
        const entries = batch; batch = []; batchBytes = 0;
        growth = Math.min(growth * 2, this.options.batchGrowth);

        const committed = await withIndex(operations => {
          if (cancelled()) return [];

          const current = entries.filter(entry => {
            const file = this.vault.getFile(entry.row.path);

            return entry.generation === this.dirty.get(entry.row.path) && this.selected(entry.row.path) && file !== null && this.metadata(file).revision === entry.row.revision;
          });

          if (current.length) operations.apply({ rows: current.map(entry => entry.row), removed: [] });

          return current;
        });

        for (const { row } of committed) {
          this.setRow(this.stateOf(row));
          this.dirty.delete(row.path);
          result.filesIndexed++;
          if (!this.ready(row)) result.unavailablePaths!.push(row.path);
        }

        for (const { row } of committed) {
          await stage(row);
        }

        const accepted = new Set(committed);

        for (const entry of entries) {
          if (!accepted.has(entry)) { result.failedPaths.push(entry.row.path); this.retries.add(entry.row.path); }
        }

        if (interval !== undefined && performance.now() - lastPublish >= interval) await publish();
        report('batch');

        if (performance.now() - lastYield >= YIELD_INTERVAL_MS) {
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          lastYield = performance.now();
        }
      };

      const readOne = async (path: string): Promise<PendingRead<Row>> => {
        const file = this.vault.getFile(path);
        if (!file || !this.selected(path)) return {};
        const old = this.rows.get(path);
        const metadata = this.metadata(file);
        if (!force && !this.dirty.has(path) && !this.retries.has(path) && old && old.revision === metadata.revision
          && old.source === metadata.source && !this.error && this.current(old)) return {};

        return await this.read(file, metadata, cancelled) ?? { failed: true };
      };

      let current = 0;

      for await (const { item: path, value: read } of mapConcurrent([...candidates].sort(), this.options.readConcurrency, readOne, cancelled)) {
        this.progress(++current, candidates.size, path);
        timing.processed = current;

        if (read.timing) {
          const file = read.timing;
          timing.filesRead++;
          timing.bytesRead += file.bytesRead;
          timing.prefixReads += file.prefixReads;
          timing.readCalls += file.readCalls;
          if (file.prefixReads > 1) timing.extendedFiles++;
          timing.fileTimeTotalsMs.readWait += file.readMs;
          timing.fileTimeTotalsMs.parse += file.parseMs;
          timing.fileTimeTotalsMs.normalize += file.normalizeMs;
        }

        if (read.failed) { result.failedPaths.push(path); this.retries.add(path); continue; }
        const row = read.row;
        if (!row) continue;
        const bytes = this.bytes(row);
        if (batch.length && batchBytes + bytes > BATCH_BYTES * growth) await flush();
        batch.push({ row, generation: read.generation }); batchBytes += bytes;
        if (batch.length >= BATCH_ROWS * growth || batchBytes >= BATCH_BYTES * growth) await flush();
      }

      await flush();
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
    finally {
      try {
        await publish();
      }
      finally {
        report(this.error ? 'error' : cancelled() ? 'cancelled' : 'complete');
      }
    }

    return result;
  }

  private progress(current: number, total: number, path: string): void {
    this.options.progress(current, total, path);
  }
}
