import { assertDataFileReads } from '../Tabular/TabularAccess';
import type { VaultQuerySettings } from '../Settings/Settings';
import { ERROR_MESSAGES } from '../utils/ErrorMessages';
import { FilePreviewStaleError } from './FileWriteTypes';

type Kind = 'markdown' | 'data-file' | 'other_files';
interface Entry {
  kind: Kind;
  paths: readonly string[];
  data: unknown;
  expires: number;
  assertAccess: () => void;
}

export class PreparedFileWriteRegistry {
  private readonly plans = new Map<string, Entry>();
  private readonly pendingPaths = new Map<string, Promise<unknown>>();
  private readonly active = new Set<Promise<unknown>>();
  private timer?: number;
  private disposed = false;
  private configuration?: string;
  private currentDatabase?: object;
  private revision = 0;

  constructor(private readonly settings: VaultQuerySettings, private readonly database: () => object | undefined) {}

  updateAccess(): void {
    const settings = this.settings, database = this.database();

    const key = JSON.stringify([settings.allowWriteOperations, settings.indexingInterval,
      settings.otherFileContentExtensions, settings.excludePatterns, settings.dataFileMaxSizeMiB,
      settings.enableDataFileReads, settings.maxFileSizeKB, settings.enabledFeatures]);

    if (key === this.configuration && database === this.currentDatabase) return;
    this.configuration = key;
    this.currentDatabase = database;
    this.revision++;
    this.invalidate();
  }

  captureAccess(kind: Kind): () => void {
    this.updateAccess();
    const revision = this.revision;

    const assertAccess = () => {
      this.updateAccess();

      if (this.disposed || !this.currentDatabase || revision !== this.revision) {
        throw new FilePreviewStaleError('File preview was invalidated because settings or database changed. Generate a fresh preview.');
      }

      if (kind === 'data-file') assertDataFileReads(this.settings);
      if (!this.settings.allowWriteOperations) throw new Error(ERROR_MESSAGES.WRITE_OPERATIONS_DISABLED);
      if (this.settings.indexingInterval !== 'realtime') throw new Error('File writes require real-time indexing.');
    };

    assertAccess();

    return assertAccess;
  }

  add<T>(kind: Kind, paths: readonly string[], data: T, assertAccess: () => void): string {
    assertAccess();
    this.expire();
    const id = crypto.randomUUID();
    this.plans.set(id, { kind, paths: [...paths], data, expires: Date.now() + 5 * 60_000, assertAccess });
    this.schedule();

    return id;
  }

  kind(id: string | undefined): Kind | undefined {
    this.updateAccess();
    this.expire();

    return id ? this.plans.get(id)?.kind : undefined;
  }

  async consume<T, R>(id: string | undefined, kind: Kind, work: (data: T, assertAccess: () => void) => Promise<R>): Promise<R> {
    this.updateAccess();
    this.expire();
    const plan = id ? this.plans.get(id) : undefined;
    if (!plan || plan.kind !== kind || this.disposed) throw new FilePreviewStaleError();
    this.plans.delete(id!);
    this.schedule();

    const operation = Promise.resolve().then(() => {
      plan.assertAccess();

      return work(plan.data as T, plan.assertAccess);
    });

    this.active.add(operation);

    try {
      return await operation;
    }
    finally {
      this.active.delete(operation);
    }
  }

  discard(id: string): void {
    const plan = this.plans.get(id);
    if (!plan) return;
    this.plans.delete(id);
    this.schedule();
  }

  invalidate(kind?: Kind, path?: string): void {
    for (const [id, plan] of this.plans) {
      if ((!kind || plan.kind === kind) && (!path || plan.paths.includes(path))) this.discard(id);
    }
  }

  async withPath<T>(path: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.pendingPaths.get(path) ?? Promise.resolve()).catch(() => {}).then(work);
    this.pendingPaths.set(path, operation);

    try {
      return await operation;
    }
    finally {
      if (this.pendingPaths.get(path) === operation) this.pendingPaths.delete(path);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await Promise.allSettled([...this.active]);
  }

  private expire(): void {
    for (const [id, plan] of this.plans) {
      if (plan.expires <= Date.now()) this.discard(id);
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;

    if (this.plans.size) {
      const expiry = Array.from(this.plans.values()).reduce((earliest, plan) => Math.min(earliest, plan.expires), Infinity);
      this.timer = window.setTimeout(() => { this.timer = undefined; this.expire(); }, Math.max(1, expiry - Date.now()));
    }
  }
}
