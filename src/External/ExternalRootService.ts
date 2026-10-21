import { PathExclusions } from '../utils/PathExclusions';
import { SerialQueue } from '../utils/SerialQueue';
import { mapConcurrent } from '../utils/Concurrent';
import { ExternalFileCatalog } from './ExternalFileCatalog';
import { comparablePath, effectiveRefreshMode, isHiddenSegment, isWithin, joinRootPath, normalizeRefreshMinutes, normalizeRefreshMode, normalizeRootPath, normalizeExternalRoots, rootForExternalFile, rootStateFor, retainsRows } from './ExternalRootSettings';
import { logger as rootLogger } from '../utils/logger';
import type { ForwardReader } from '../utils/ForwardStream';
import type { ExternalRoot, ResolvedExternalRoot } from './ExternalRootSettings';

const logger = rootLogger.scope('External');

const SCAN_PROGRESS_MS = 1_000;
const STAT_CONCURRENCY = 8;
const WATCH_RETRY_MIN_MS = 1_000;
const WATCH_RETRY_MAX_MS = 60_000;

const UNSUPPORTED_PLATFORM = 'This device cannot read folders outside the vault.';

export interface ExternalDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  stat?: ExternalStat;
}

export interface ExternalFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface ExternalStat {
  size: number;
  mtimeMs: number;
  birthtimeMs?: number;
  ctimeMs?: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ExternalFileSystem {
  readdir(path: string, options: { withFileTypes: true }): Promise<ExternalDirent[]>;
  stat(path: string): Promise<ExternalStat>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  open(path: string, flags: string): Promise<ExternalFileHandle>;
}

export interface ExternalWatcher { close(): void }
export type ExternalWatchListener = (eventType: string, filename: string | null) => void;
export type ExternalWatch = (path: string, options: { recursive: boolean }, listener: ExternalWatchListener, onError?: (error: unknown) => void) => ExternalWatcher;

export interface ExternalRefreshScope {
  root: string;
  directory?: string;
  file?: string;
}

export interface ExternalRootFailure {
  path: string;
  reason: string;
}

export interface ExternalRootScanStatus extends ResolvedExternalRoot {
  scanning: boolean;
  filesFound: number;
  lastScanStarted: number | null;
  lastScanCompleted: number | null;
  failures: ExternalRootFailure[];
}

export interface ExternalRootStatus extends ExternalRootScanStatus {
  filesIndexed: number;
  filesSkipped: number;
}

export interface ExternalScanDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface ExternalRootSettingsSource {
  externalRoots: ExternalRoot[];
  excludePatterns: string[];
}

export interface IndexableExternalFile {
  path: string;
  stat: { size: number; mtime: number; ctime: number };
}

export interface ExternalRootRuntime {
  fileSystem(): ExternalFileSystem | undefined;
  watch?(): ExternalWatch | undefined;
  vaultPath(): string | null;
}

interface ScanRecord {
  scanning: boolean;
  lastScanStarted: number | null;
  lastScanCompleted: number | null;
  failures: Map<string, string>;
}

interface RootWatcher {
  path: string;
  handle?: ExternalWatcher;
  timer?: number;
  failures: number;
  generation: number;
}

export class ExternalRootService {
  private readonly exclusions = new PathExclusions();
  /** Keyed by exact path: two names differing only in case are two files wherever the file system says so. */
  private readonly entries = new ExternalFileCatalog();
  private readonly unreadablePaths = new Set<string>();
  private readonly refreshes = new SerialQueue();
  private counted?: { revision: number; roots: readonly ResolvedExternalRoot[]; states: string; files: Map<string, number> };
  private readonly realRoots = new Map<string, string>();
  private readonly scans = new Map<string, ScanRecord>();
  private lastStatusAt = 0;
  private entriesRevision = 0;
  private readonly watchers = new Map<string, RootWatcher>();
  private resolved: ResolvedExternalRoot[] = [];
  private disposed = false;

  public constructor(private readonly settings: ExternalRootSettingsSource, private readonly runtime: ExternalRootRuntime,
    private readonly onChange: (scope?: ExternalRefreshScope) => void = () => {},
    private readonly onStatus: () => void = () => {}) {
    this.updateRoots();
  }

  public statuses(): ExternalRootScanStatus[] {
    const files = this.filesByRoot();

    return this.resolved.map(root => {
      const key = comparablePath(root.path);
      const scan = this.scans.get(key);

      return { ...root, scanning: scan?.scanning ?? false, filesFound: files.get(key) ?? 0,
        lastScanStarted: scan?.lastScanStarted ?? null, lastScanCompleted: scan?.lastScanCompleted ?? null,
        failures: [...scan?.failures ?? []].map(([path, reason]) => ({ path, reason })) };
    });
  }

  public recordFailures(failures: readonly ExternalRootFailure[]): void {
    let recorded = false;

    for (const failure of failures) {
      const root = rootForExternalFile(this.resolved, failure.path) ?? this.resolved.find(candidate => isWithin(candidate.path, failure.path));
      if (!root) continue;
      this.scan(root.path).failures.set(failure.path, failure.reason);
      recorded = true;
    }

    if (recorded) this.onStatus();
  }

  /** Status polls ask often and files arrive rarely, so the count is kept until the files or the roots change. */
  private filesByRoot(): Map<string, number> {
    const states = this.resolved.map(root => root.state).join();
    const counted = this.counted;
    if (counted && counted.revision === this.entriesRevision && counted.roots === this.resolved && counted.states === states) return counted.files;
    const files = new Map<string, number>();

    for (const file of this.entries.values()) {
      const source = this.sourceFor(file.path);
      if (source) files.set(comparablePath(source), (files.get(comparablePath(source)) ?? 0) + 1);
    }

    this.counted = { revision: this.entriesRevision, roots: this.resolved, states, files };

    return files;
  }

  private scan(root: string): ScanRecord {
    const key = comparablePath(root);
    let record = this.scans.get(key);
    if (!record) this.scans.set(key, record = { scanning: false, lastScanStarted: null, lastScanCompleted: null, failures: new Map() });

    return record;
  }

  private startScan(root: string, directory: string): ScanRecord {
    const record = this.scan(root);
    record.scanning = true;
    record.lastScanStarted = this.lastStatusAt = Date.now();

    for (const path of [...record.failures.keys()]) {
      if (isWithin(directory, path)) record.failures.delete(path);
    }

    for (const path of this.unreadablePaths) {
      if (isWithin(directory, path)) this.unreadablePaths.delete(path);
    }

    this.onStatus();

    return record;
  }

  private finishScan(record: ScanRecord): void {
    record.scanning = false;
    record.lastScanCompleted = this.lastStatusAt = Date.now();
    this.onStatus();
  }

  private reportProgress(): void {
    if (Date.now() - this.lastStatusAt < SCAN_PROGRESS_MS) return;
    this.lastStatusAt = Date.now();
    this.onStatus();
  }

  /** Bumped whenever the set of known files changes, so a count taken over them can be reused until it does. */
  public revision(): number { return this.entriesRevision; }

  public get enabled(): boolean { return this.resolved.some(root => root.state === 'ready'); }
  public get configured(): boolean { return this.resolved.length > 0; }
  public roots(): readonly ResolvedExternalRoot[] { return this.resolved; }
  public files(): IndexableExternalFile[] { return [...this.entries.values()]; }
  public file(path: string): IndexableExternalFile | null { return this.entries.get(path) ?? null; }
  public has(path: string): boolean { return this.entries.has(path); }

  public selects(path: string): boolean {
    const root = rootForExternalFile(this.resolved, path);
    if (!root) return false;
    const relative = path.slice(root.path.length).replace(/^\//, '');

    return !this.exclusions.matches(relative, this.settings.excludePatterns) && !this.unreadable(path);
  }

  public retains(path: string): boolean {
    const root = rootForExternalFile(this.resolved, path, true);
    if (!root || this.exclusions.matches(path.slice(root.path.length).replace(/^\//, ''), this.settings.excludePatterns)) return false;

    return retainsRows(root.state) || this.unreadable(path);
  }

  private unreadable(path: string): boolean {
    for (const unreadable of this.unreadablePaths) {
      if (isWithin(unreadable, path)) return true;
    }

    return false;
  }

  public sourceFor(path: string): string | undefined {
    return rootForExternalFile(this.resolved, path)?.path;
  }

  public updateRoots(): void {
    const readable = this.runtime.fileSystem() !== undefined;
    const watchable = this.runtime.watch?.() !== undefined;
    const vaultPath = this.runtime.vaultPath();

    const resolved = normalizeExternalRoots(this.settings.externalRoots).map(root => {
      const state = rootStateFor(root, vaultPath, readable);
      const refresh = normalizeRefreshMode(root.refresh);
      const previous = this.resolved.find(candidate => comparablePath(candidate.path) === comparablePath(root.path));
      const unavailable = state === 'ready' && previous && (previous.state === 'missing' || previous.state === 'unreadable');

      return { ...root, refresh: effectiveRefreshMode(refresh, watchable), refreshMinutes: normalizeRefreshMinutes(root.refreshMinutes),
        state: unavailable ? previous.state : state, error: unavailable ? previous.error : state === 'ready' ? null : describeState(state) };
    });

    if (JSON.stringify(resolved) !== JSON.stringify(this.resolved)) {
      this.resolved = resolved;
      this.entriesRevision++;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.stopWatching();
    this.entries.clear();
    this.unreadablePaths.clear();
  }

  public exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.refreshes.enqueue(work);
  }

  /**
   * Walks into a fresh map and swaps it in once the walk completes, so anything
   * reading the files meanwhile sees the previous walk rather than a half-empty one.
   */
  public async refresh(scope?: ExternalRefreshScope): Promise<ExternalScanDiff> {
    this.updateRoots();
    const target = scope ? this.scanTarget(scope) : undefined;
    if (scope && !target) return { added: [], changed: [], removed: [] };
    const found = new Map<string, IndexableExternalFile>();
    const fs = this.runtime.fileSystem();
    const file = scope?.file && normalizeRootPath(scope.file);
    if (fs && !this.disposed && target?.root.state === 'ready' && file && isWithin(target.root.path, file) && this.entries.has(file)) {
      return this.refreshFile(fs, target.root, file);
    }

    if (fs && !this.disposed) {
      if (!target) this.realRoots.clear();
      const targets = target ? [target] : this.resolved.filter(root => this.walkable(root)).map(root => ({ root, directory: root.path }));
      await this.scanDirectories(fs, targets, found);
    }

    if (this.disposed) return { added: [], changed: [], removed: [] };
    const diff = this.entries.replace(found, target?.directory, path => this.retains(path));
    // A file that only changed is the same file: what a count over these entries
    // answers moves when one arrives or leaves, not when one is rewritten.
    if (diff.added.length || diff.removed.length) this.entriesRevision++;
    this.onStatus();

    return diff;
  }

  private walkable(root: ResolvedExternalRoot): boolean {
    return (root.state === 'ready' || root.state === 'missing' || root.state === 'unreadable') && root.extensions.length > 0;
  }

  private scanTarget(scope: ExternalRefreshScope): { root: ResolvedExternalRoot; directory: string } | undefined {
    const root = this.resolved.find(candidate => comparablePath(candidate.path) === comparablePath(scope.root));
    if (!root || !this.walkable(root)) return undefined;
    const directory = root.state === 'ready' && scope.directory ? normalizeRootPath(scope.directory) : root.path;

    return isWithin(root.path, directory) ? { root, directory } : { root, directory: root.path };
  }

  private async refreshFile(fs: ExternalFileSystem, root: ResolvedExternalRoot, path: string): Promise<ExternalScanDiff> {
    const record = this.startScan(root.path, path);
    let file: IndexableExternalFile | undefined;

    try {
      try {
        this.realRoots.set(comparablePath(root.path), normalizeRootPath(await fs.realpath(root.path)));
      }
      catch (error) {
        this.rootUnavailable(root, error);
      }

      if (root.state === 'ready' && this.selects(path)) {
        try {
          const { linked } = await this.confirm(path);
          if (!linked) {
            const stat = await fs.stat(path);
            if (stat.isFile()) file = indexedFile(path, stat);
            else return await this.refresh(this.watchScope(root.path, path, 'rename'));
          }
        } catch (error) {
          this.recordFailure(path, error, 'External file could not be read');
        }
      }

      if (this.disposed) return { added: [], changed: [], removed: [] };
      const diff = this.entries.replaceFile(path, file, candidate => this.retains(candidate));
      // A native change notification can precede a distinguishable timestamp or size.
      if (file && !diff.changed.length) diff.changed.push(path);
      if (diff.added.length || diff.removed.length) this.entriesRevision++;

      return diff;
    } finally {
      this.finishScan(record);
    }
  }

  private async scanDirectories(fs: ExternalFileSystem, targets: Array<{ root: ResolvedExternalRoot; directory: string }>, found: Map<string, IndexableExternalFile>): Promise<void> {
    const records = targets.map(({ root, directory }) => this.startScan(root.path, directory));
    const visited = new Set<string>();

    try {
      // Resolve every root before walking so nested roots have their current selection state.
      for (const { root } of targets) {
        if (this.disposed) return;
        try {
          const real = normalizeRootPath(await fs.realpath(root.path));
          this.realRoots.set(comparablePath(root.path), real);
          root.state = 'ready';
          root.error = null;
        } catch (error) {
          this.rootUnavailable(root, error);
        }
      }

      for (const { root, directory } of targets.sort((left, right) => left.directory.length - right.directory.length)) {
        if (this.disposed) return;
        if (root.state !== 'ready') continue;
        try {
          await this.walk(fs, directory, found, visited);
        }
        catch (error) {
          if (comparablePath(directory) === comparablePath(root.path)) this.rootUnavailable(root, error);
          else this.recordFailure(directory, error, 'External folder is no longer readable');
        }
      }
    } finally {
      for (const record of records) {
        this.finishScan(record);
      }
    }
  }

  private rootUnavailable(root: ResolvedExternalRoot, error: unknown): void {
    root.state = isMissing(error) ? 'missing' : 'unreadable';
    root.error = error instanceof Error ? error.message : String(error);
    logger.warn('External root is unavailable', { path: root.path, error: root.error });
  }

  private async walk(fs: ExternalFileSystem, directory: string, found: Map<string, IndexableExternalFile>, visited: Set<string>): Promise<void> {
    const key = comparablePath(directory);
    if (this.disposed || visited.has(key)) return;
    const dirents = await fs.readdir(directory, { withFileTypes: true });
    visited.add(key);

    const visible = dirents.filter(entry => !entry.isSymbolicLink() && !isHiddenSegment(entry.name));

    for await (const { value: file } of mapConcurrent(visible.filter(entry => entry.isFile()), STAT_CONCURRENCY, async entry => {
      const path = joinRootPath(directory, entry.name);
      if (!this.selects(path)) return;

      try {
        const stat = entry.stat ?? await fs.stat(path);
        if (!stat.isFile()) return;

        return indexedFile(path, stat);
      } catch (error) {
        this.recordFailure(path, error, 'External file could not be read');
      }
    }, () => this.disposed)) {
      if (file) { found.set(file.path, file); this.reportProgress(); }
    }

    for (const entry of visible) {
      if (this.disposed) return;
      if (!entry.isDirectory()) continue;
      const path = joinRootPath(directory, entry.name);

      try {
        await this.walk(fs, path, found, visited);
      }
      catch (error) {
        this.recordFailure(path, error, 'External folder could not be listed');
      }
    }
  }

  private recordFailure(path: string, error: unknown, message: string): void {
    if (!isMissing(error)) this.unreadablePaths.add(path);
    logger.debug(message, { path, error: error instanceof Error ? error.message : String(error) });
    const root = this.resolved.find(candidate => isWithin(candidate.path, path));
    if (root) this.scan(root.path).failures.set(path, error instanceof Error ? error.message : String(error));
  }

  public startWatching(): void {
    const watch = this.runtime.watch?.();
    if (!watch || this.disposed) { this.stopWatching(); return; }
    const wanted = new Set<string>();
    const covered: string[] = [];

    for (const root of [...this.resolved].sort((left, right) => left.path.length - right.path.length)) {
      if (!this.walkable(root) || root.refresh !== 'watch' || covered.some(path => isWithin(path, root.path))) continue;
      const key = comparablePath(root.path);
      wanted.add(key);
      let entry = this.watchers.get(key);
      if (!entry) this.watchers.set(key, entry = { path: root.path, failures: 0, generation: 0 });
      if (root.state !== 'ready') {
        if (entry.handle) this.closeWatcher(entry);
        this.retryWatcher(entry);
      } else if (!entry.handle && entry.timer === undefined) this.openWatcher(entry, watch);
      if (entry.handle) covered.push(root.path);
    }

    for (const [key, entry] of this.watchers) {
      if (wanted.has(key)) continue;
      this.closeWatcher(entry);
      this.watchers.delete(key);
    }
  }

  private openWatcher(entry: RootWatcher, watch: ExternalWatch): void {
    const generation = ++entry.generation;
    const current = () => !this.disposed && this.watchers.get(comparablePath(entry.path)) === entry && entry.generation === generation;
    const failed = (error: unknown) => {
      if (!current()) return;
      this.closeWatcher(entry);
      logger.warn('External folder watching stopped; retrying and rescanning the folder', { path: entry.path, error });
      this.retryWatcher(entry);
      this.onChange({ root: entry.path });
    };

    try {
      const handle = watch(entry.path, { recursive: true }, (event, filename) => {
        if (current()) this.onChange(this.watchScope(entry.path, filename, event));
      }, failed);
      if (current()) { entry.handle = handle; entry.failures = 0; }
      else handle.close();
    } catch (error) {
      failed(error);
    }
  }

  private retryWatcher(entry: RootWatcher): void {
    if (this.disposed || entry.timer !== undefined) return;
    const delay = Math.min(WATCH_RETRY_MAX_MS, WATCH_RETRY_MIN_MS * 2 ** Math.min(entry.failures++, 6));
    entry.timer = window.setTimeout(() => {
      entry.timer = undefined;
      if (this.disposed || this.watchers.get(comparablePath(entry.path)) !== entry) return;
      this.onChange({ root: entry.path });
      this.startWatching();
    }, delay);
  }

  private closeWatcher(entry: RootWatcher): void {
    entry.generation++;
    if (entry.timer !== undefined) window.clearTimeout(entry.timer);
    entry.timer = undefined;
    try {
      entry.handle?.close();
    } catch {
      /* The native error handler may have closed this handle already. */
    }
    entry.handle = undefined;
  }

  private watchScope(root: string, filename: string | null, event: string): ExternalRefreshScope {
    if (!filename) return { root };
    const relative = filename.replace(/\\/g, '/');
    if (relative.split('/').some(part => part === '.' || part === '..')) return { root };
    const absolute = relative.startsWith('/') ? normalizeRootPath(relative) : normalizeRootPath(joinRootPath(root, relative));
    if (!isWithin(root, absolute)) return { root };
    if (event === 'change' && this.entries.has(absolute)) return { root, file: absolute };
    const cut = absolute.lastIndexOf('/');

    return { root, directory: cut > root.length ? absolute.slice(0, cut) : root };
  }

  public stopWatching(): void {
    for (const entry of this.watchers.values()) {
      this.closeWatcher(entry);
    }
    this.watchers.clear();
  }

  public async readAll(path: string): Promise<ArrayBuffer> {
    const { fs } = await this.confirm(path);
    const bytes = await fs.readFile(path);

    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  public async openRead(path: string): Promise<ForwardReader> {
    const { fs } = await this.confirm(path);
    const handle = await fs.open(path, 'r');

    return {
      read: async (buffer, offset, length, position) => (await handle.read(buffer, offset, length, position)).bytesRead,
      cancel: () => handle.close(),
    };
  }

  private async confirm(path: string): Promise<{ fs: ExternalFileSystem; linked: boolean }> {
    const fs = this.runtime.fileSystem();
    if (!fs) throw new Error(UNSUPPORTED_PLATFORM);
    const root = rootForExternalFile(this.resolved, path);
    if (!root || !this.selects(path)) throw new Error(`Path is not inside a configured external folder: ${path}`);
    const real = this.realRoots.get(comparablePath(root.path)) ?? normalizeRootPath(await fs.realpath(root.path));
    this.realRoots.set(comparablePath(root.path), real);
    const resolvedPath = normalizeRootPath(await fs.realpath(path));

    if (!isWithin(real, resolvedPath)) {
      throw new Error(`Path resolves outside its external folder: ${path}`);
    }

    const expected = joinRootPath(real, path.slice(root.path.length).replace(/^\//, ''));

    return { fs, linked: comparablePath(resolvedPath) !== comparablePath(expected) };
  }
}

function indexedFile(path: string, stat: ExternalStat): IndexableExternalFile {
  return { path, stat: { size: stat.size, mtime: stat.mtimeMs, ctime: stat.birthtimeMs ?? stat.ctimeMs ?? stat.mtimeMs } };
}

function isMissing(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;

  return code === 'ENOENT' || code === 'ENOTDIR';
}

function describeState(state: ResolvedExternalRoot['state']): string {
  switch (state) {
    case 'invalid': return 'Enter an absolute folder path.';
    case 'inside-vault': return 'This folder is inside the vault and is already indexed.';
    case 'unsupported-platform': return UNSUPPORTED_PLATFORM;
    case 'missing': return 'This folder could not be read.';
    default: return 'This folder could not be used.';
  }
}
