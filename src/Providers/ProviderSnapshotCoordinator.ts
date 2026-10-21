import { SerialQueue } from '../utils/SerialQueue';
import { DataFileError } from '../Tabular/TabularTypes';
import { checkDataFileSize } from '../Tabular/TabularLimits';
import type { TabularParseLimits } from '../Tabular/TabularTypes';
import { getErrorMessage } from '../utils/ErrorMessages';
import type { ProviderRefreshDefinition, ProviderRefreshResult, ProviderTableDefinition, TableProviderStatus, VaultQueryTableProvider } from './TableProviderTypes';
import { sameSnapshotOwner, snapshotTableDefinition, validateSnapshotTableName } from './ProviderSnapshotOperations';
import type { ProviderSnapshotOperations, ProviderSnapshotOwner, ProviderSnapshotRelocation, StoredProviderSnapshot } from './ProviderSnapshotOperations';
import { ProviderSnapshotUnavailableError } from './ProviderSnapshotUnavailableError';

export interface SnapshotRuntime {
  providerId: string;
  providerDisplayName: string;
  sourcePath: string;
  blockHash: string;
  definition: ProviderRefreshDefinition;
}

export interface SnapshotDatabase {
  withProviderSnapshots<T>(work: (operations: ProviderSnapshotOperations) => T): Promise<T>;
  hasProviderSnapshots?(): Promise<boolean>;
}

const key = (name: string): string => name.toLowerCase();
interface PreparedRuntime extends SnapshotRuntime {
  readonly key: string;
  readonly signature: string;
  readonly fingerprint: string;
}

function copyDefinitionValue<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return Object.freeze(value.map(item => copyDefinitionValue(item as unknown))) as T;

  if (value && typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype === Object.prototype || prototype === null) {
      const copy: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;

      for (const [name, child] of Object.entries(value)) {
        Object.defineProperty(copy, name, { value: copyDefinitionValue(child as unknown), enumerable: true });
      }

      return Object.freeze(copy) as T;
    }
  }

  return value;
}

function prepareRuntime(runtime: SnapshotRuntime): PreparedRuntime {
  return Object.freeze({ ...runtime,
    definition: copyDefinitionValue(runtime.definition),
    key: JSON.stringify([runtime.providerId, runtime.definition.id]),
    signature: JSON.stringify([runtime.sourcePath, runtime.blockHash, runtime.definition]),
    fingerprint: JSON.stringify([runtime.providerId, runtime.definition.id, runtime.definition.requestedTables, runtime.definition.request]),
  });
}

const runtimeKey = (runtime: PreparedRuntime): string => runtime.key;
const runtimeSignature = (runtime: PreparedRuntime): string => runtime.signature;

const ownerFor = (runtime: PreparedRuntime, table: string): ProviderSnapshotOwner => ({ table,
  providerId: runtime.providerId, definitionId: runtime.definition.id, sourcePath: runtime.sourcePath,
  fingerprint: runtime.fingerprint,
});

export class ProviderSnapshotCoordinator {
  private definitions: PreparedRuntime[] = [];
  private readonly tableRuntimes = new Map<string, PreparedRuntime | null>();
  private readonly preparedRuntimes = new WeakMap<SnapshotRuntime, PreparedRuntime>();
  private readonly runtimeSignatures = new Map<string, Set<string>>();
  private stored = new Map<string, StoredProviderSnapshot>();
  private readonly unvalidatedNames = new Map<string, string>();
  private initializationError?: string;
  private restorationPending = false;
  private initialized?: SnapshotDatabase;
  private enabled = true;
  private disposed = false;
  private generation = 0;
  private readonly pending = new Map<string, Promise<string[]>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly errors = new Map<string, string>();
  private readonly retries = new Map<string, { attempts: number; next: number }>();
  private registeredProviders?: Set<string>;
  private readonly dirtyPaths = new Map<string, number>();
  private readonly pendingMoves = new Map<string, { path: string; indexed: boolean }>();
  private readonly schemaChanges = new Map<string, boolean>();
  private readonly queue = new SerialQueue();
  private readonly downloads = new SerialQueue();
  private publish: (tables: string[], relocations?: ProviderSnapshotRelocation[]) => Promise<void> = async () => {};

  public constructor(private readonly database: () => SnapshotDatabase | undefined, private readonly limits: () => TabularParseLimits, private readonly staticNames: () => string[]) {
  }

  public setPublisher(publish: (tables: string[], relocations?: ProviderSnapshotRelocation[]) => Promise<void>): void { this.publish = publish; }
  public get hasDefinitions(): boolean { return this.definitions.length > 0 || this.stored.size > 0 || this.unvalidatedNames.size > 0; }
  public reservePersistedNames(names: string[]): void {
    for (const name of names) {
      this.unvalidatedNames.set(key(name), name);
    }

    if (names.length) this.restorationPending = true;
  }

  public finishDefinitionDiscovery(): void { this.restorationPending = false; }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.invalidate();
  }

  public dispose(): void { this.disposed = true; this.invalidate(); this.pendingMoves.clear(); }
  public waitForIdle(): Promise<void> { return this.queue.waitForIdle(this.downloads); }

  public setRegisteredProviders(ids: string[]): void { this.registeredProviders = new Set(ids); }
  public sourcePaths(): string[] {
    return [...new Set([...this.definitions.map(runtime => runtime.sourcePath),
      ...[...this.stored.values()].map(record => record.sourcePath), ...[...this.pendingMoves.values()].map(move => move.path)])];
  }

  public renamePath(previous: string, current: string): void {
    if (previous === current || this.disposed) return;
    this.invalidatePath(previous);

    for (const [path, move] of this.pendingMoves) {
      if (move.path === previous) this.pendingMoves.set(path, { path: current, indexed: false });
    }

    this.pendingMoves.set(previous, { path: current, indexed: false });
  }

  public invalidatePath(path: string): void {
    const runtimes = this.definitions.filter(runtime => runtime.sourcePath === path);
    if (!runtimes.length) return;
    this.dirtyPaths.set(path, (this.dirtyPaths.get(path) ?? 0) + 1);

    for (const runtime of runtimes) {
      this.controllers.get(runtimeKey(runtime))?.abort();
      this.pending.delete(runtimeKey(runtime));
    }
  }

  public pathRevision(path: string): number | undefined { return this.dirtyPaths.get(path); }
  public confirmIndexedPath(path: string, revision: number | undefined): string[] {
    if (this.dirtyPaths.get(path) !== revision) return [];
    this.dirtyPaths.delete(path);

    return this.definitions.filter(runtime => runtime.sourcePath === path).flatMap(runtime => runtime.definition.requestedTables ?? []);
  }

  private invalidate(): void {
    this.generation++;
    this.pending.clear();

    for (const controller of this.controllers.values()) {
      controller.abort();
    }
  }

  public setDefinitions(inputs: SnapshotRuntime[]): void {
    const definitions = inputs.map(input => {
      const runtime = prepareRuntime(input);
      this.preparedRuntimes.set(input, runtime);
      this.preparedRuntimes.set(runtime, runtime);

      return runtime;
    });

    const signatures = new Map<string, Set<string>>();
    const counts = new Map<string, number>();

    for (const runtime of definitions) {
      const id = runtimeKey(runtime);
      if (!signatures.has(id)) signatures.set(id, new Set());
      signatures.get(id)!.add(runtimeSignature(runtime));
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    for (const id of new Set([...this.runtimeSignatures.keys(), ...signatures.keys()])) {
      const previous = this.runtimeSignatures.get(id);
      const next = signatures.get(id);

      if (!previous || !next || previous.size !== next.size || [...previous].some(value => !next.has(value))) {
        this.controllers.get(id)?.abort();
        this.pending.delete(id);
        this.errors.delete(id);
        this.retries.delete(id);
      }
    }

    this.definitions = definitions;
    this.runtimeSignatures.clear();

    for (const [id, values] of signatures) {
      this.runtimeSignatures.set(id, values);
    }

    this.tableRuntimes.clear();

    for (const runtime of definitions) {
      for (const table of runtime.definition.requestedTables ?? []) {
        const tableKey = key(table);
        const ambiguous = this.tableRuntimes.has(tableKey) || counts.get(runtimeKey(runtime)) !== 1;
        this.tableRuntimes.set(tableKey, ambiguous ? null : runtime);
      }
    }
  }

  public names(): string[] {
    return [...new Set([...this.unvalidatedNames.values(), ...[...this.stored.values()].map(record => record.table)]
      .concat(this.definitions.flatMap(runtime => runtime.definition.requestedTables ?? [])))];
  }

  public owns(name: string): boolean {
    const tableKey = key(name);

    return this.tableRuntimes.has(tableKey) || this.stored.has(tableKey)
      || this.unvalidatedNames.has(tableKey);
  }

  private runtimeFor(name: string): PreparedRuntime | undefined { return this.tableRuntimes.get(key(name)) ?? undefined; }

  private isCurrent(runtime: PreparedRuntime, generation: number, controller?: AbortController): boolean {
    return !this.disposed && this.enabled && !controller?.signal.aborted && generation === this.generation
      && !this.dirtyPaths.has(runtime.sourcePath)
      && Boolean(this.runtimeSignatures.get(runtimeKey(runtime))?.has(runtimeSignature(runtime)));
  }

  public ready(name: string): StoredProviderSnapshot | undefined {
    if (!this.enabled || this.disposed || this.restorationPending || this.initializationError || this.initialized !== this.database()) return undefined;
    const runtime = this.runtimeFor(name);
    const record = this.stored.get(key(name));
    if (!runtime || !record || this.dirtyPaths.has(runtime.sourcePath) || this.pendingMoves.has(record.sourcePath)) return undefined;
    const owner = ownerFor(runtime, record.table);

    return sameSnapshotOwner(record, owner) && record.fingerprint === owner.fingerprint ? record : undefined;
  }

  public declaredTables(): ProviderTableDefinition[] {
    return this.names().flatMap(name => {
      const record = this.ready(name);

      return record ? [snapshotTableDefinition(record)] : [];
    });
  }

  public status(): TableProviderStatus[] {
    if (!this.enabled) return [];

    return this.definitions.flatMap(runtime => (runtime.definition.requestedTables ?? []).map(table => {
      const record = this.ready(table);
      const error = this.errors.get(runtimeKey(runtime));

      return { providerId: runtime.providerId, displayName: runtime.providerDisplayName, tableName: table,
        definitionId: runtime.definition.id, rowCount: record?.rowCount ?? 0, dataAsOf: record?.asOf,
        lastRefreshAt: record?.validatedAt ?? record?.asOf, expiresAt: record?.expiresAt, active: Boolean(record),
        lastValidatedAt: record?.validatedAt ?? record?.asOf, snapshotRevision: record?.revision,
        schemaChanged: this.schemaChanges.get(key(table)),
        snapshotState: this.snapshotState(runtime, record, error),
        lastError: error ?? (this.runtimeFor(table) ? undefined : 'Duplicate provider definition or table name.') };
    }));
  }

  private snapshotState(runtime: PreparedRuntime, record: StoredProviderSnapshot | undefined, error: string | undefined): TableProviderStatus['snapshotState'] {
    if (this.controllers.has(runtimeKey(runtime))) return 'refreshing';
    if (record) return error || record.expiresAt <= Date.now() ? 'stale' : 'ready';

    return error ? 'unavailable' : 'pending';
  }

  public async initialize(force = false): Promise<void> {
    if (force) { this.invalidate(); this.pendingMoves.clear(); }
    const operation = this.queue.enqueue(() => this.initializeNow(force));

    try {
      await operation; this.initializationError = undefined;
    }
    catch (error) {
      this.initializationError = getErrorMessage(error); throw error;
    }
  }

  private async initializeNow(force = false): Promise<void> {
    const database = this.database();
    if (!database) return;
    if (!this.enabled && database.hasProviderSnapshots && !await database.hasProviderSnapshots()) return;
    if (!force && this.initialized === database && !this.initializationError) return;
    if (this.initialized && this.initialized !== database) { this.invalidate(); this.pendingMoves.clear(); }

    const records = await database.withProviderSnapshots(operations => {
      const records = operations.list();

      for (const record of records) {
        operations.validateStored(record);
      }

      if (force) for (const record of records) {
        operations.remove(record);
      }

      return records;
    });

    this.stored.clear();
    this.unvalidatedNames.clear();
    this.initialized = database;
    this.initializationError = undefined;

    if (force) {
      await this.publish(records.map(record => record.table));

      return;
    }

    for (const record of records) {
      this.stored.set(key(record.table), record);

      try {
        this.checkRecordLimits(record);
      }
      catch (error) {
        await database.withProviderSnapshots(operations => operations.remove(record));
        this.stored.delete(key(record.table));
        await this.publish([record.table]);
        this.errors.set(JSON.stringify([record.providerId, record.definitionId]), getErrorMessage(error));
      }
    }
  }

  private checkRecordLimits(record: StoredProviderSnapshot): void {
    this.checkSnapshotLimits(record.table, record.sourceBytes, record.columns.length);
  }

  private checkSnapshotLimits(table: string, bytes: number, columns: number): void {
    const limits = this.limits();
    checkDataFileSize(table, bytes, limits);

    if (columns > limits.maxColumns) {
      throw new DataFileError(table, 'limit', 'CSV snapshot exceeds the SQLite column limit.');
    }
  }

  public needsPathReconciliation(path: string): boolean {
    if (this.initialized !== this.database() || !this.initialized || this.initializationError) return true;
    if (this.dirtyPaths.has(path) || this.pendingMoves.has(path)) return true;

    for (const move of this.pendingMoves.values()) {
      if (move.path === path) return true;
    }

    for (const record of this.stored.values()) {
      if (record.sourcePath === path) return true;
    }

    return this.definitions.some(runtime => runtime.sourcePath === path);
  }

  public async reconcile(path?: string, awaitingReplacement = false): Promise<void> {
    const pathRevision = path === undefined ? undefined : this.dirtyPaths.get(path);
    await this.queue.enqueue(() => this.reconcileNow(path, pathRevision, awaitingReplacement));
  }

  private async reconcileNow(path?: string, pathRevision?: number, awaitingReplacement = false): Promise<void> {
    if (!this.enabled) return;
    await this.initializeNow();

    if (path !== undefined) {
      if (this.dirtyPaths.get(path) !== pathRevision) return;
      this.dirtyPaths.delete(path);
    }

    const database = this.database();
    if (!database || !this.enabled) return;
    const removed: string[] = [];
    const relocations: ProviderSnapshotRelocation[] = [];

    for (const [previousPath, move] of this.pendingMoves) {
      if (move.path === path && !awaitingReplacement) move.indexed = true;
      if (!move.indexed) continue;
      let waiting = false;

      for (const record of this.stored.values()) {
        if (record.sourcePath !== previousPath) continue;
        if (this.registeredProviders && !this.registeredProviders.has(record.providerId)) { waiting = true; continue; }
        if (this.tableRuntimes.get(key(record.table)) === null) { waiting = true; continue; }
        const runtime = this.runtimeFor(record.table);
        const owner = runtime ? ownerFor(runtime, record.table) : undefined;

        const unchanged = owner && owner.sourcePath === move.path && owner.fingerprint === record.fingerprint
          && sameSnapshotOwner({ ...record, sourcePath: move.path }, owner);

        const result = await database.withProviderSnapshots(operations => {
          if (this.pendingMoves.get(previousPath) !== move || this.runtimeFor(record.table) !== runtime || this.dirtyPaths.has(move.path)) return undefined;
          if (unchanged && owner) return operations.relocate(record, owner);
          operations.remove(record);

          return null;
        });

        if (result === undefined) { waiting = true; continue; }

        if (result) {
          this.stored.set(key(record.table), result);
          relocations.push({ previous: record, current: result });
        } else {
          this.stored.delete(key(record.table));
          removed.push(record.table);
        }
      }

      if (!waiting && this.pendingMoves.get(previousPath) === move) {
        this.pendingMoves.delete(previousPath);
      }
    }

    for (const record of this.stored.values()) {
      if (this.pendingMoves.has(record.sourcePath)) continue;
      if (this.registeredProviders && !this.registeredProviders.has(record.providerId)) continue;
      if (path !== undefined && record.sourcePath !== path) continue;
      if (this.tableRuntimes.get(key(record.table)) === null) continue;
      const runtime = this.runtimeFor(record.table);
      const owner = runtime ? ownerFor(runtime, record.table) : undefined;
      if (owner && sameSnapshotOwner(record, owner) && record.fingerprint === owner.fingerprint) continue;
      await database.withProviderSnapshots(operations => operations.remove(record));
      this.stored.delete(key(record.table));
      removed.push(record.table);
    }

    if (relocations.length) await this.publish(removed, relocations);
    else if (removed.length) await this.publish(removed);
  }

  public async publishReadySnapshots(): Promise<void> {
    await this.queue.enqueue(async () => {
      const tables = this.names().filter(name => this.ready(name));
      if (tables.length) await this.publish(tables);
    });
  }

  public stale(input: SnapshotRuntime, now = Date.now()): boolean {
    const runtime = this.preparedRuntimes.get(input) ?? prepareRuntime(input);
    if (!this.enabled || this.disposed || (this.retries.get(runtimeKey(runtime))?.next ?? 0) > now) return false;

    return (runtime.definition.requestedTables ?? []).some(table => {
      const record = this.ready(table);

      return !record || record.expiresAt <= now;
    });
  }

  public async assertReadable(names: readonly string[]): Promise<void> {
    for (const name of names) {
      if (!this.owns(name)) continue;
      if (this.ready(name)) continue;
      const runtime = this.runtimeFor(name);
      const pending = runtime ? this.pending.get(runtimeKey(runtime)) : undefined;
      if (pending && runtime && this.controllers.has(runtimeKey(runtime))) await pending.catch(() => {});

      if (!this.ready(name)) {
        const detail = this.initializationError ?? (runtime
          ? this.errors.get(runtimeKey(runtime)) ?? 'The initial snapshot is waiting to load.'
          : 'Enable this table\'s source in VaultQuery settings and resolve its definition.');

        throw new ProviderSnapshotUnavailableError(`Provider table ${name} is unavailable. ${detail}`, name);
      }
    }
  }

  public staleReaders(names: readonly string[]): SnapshotRuntime[] {
    return this.definitions.filter(runtime => runtime.definition.requestedTables?.some(table => names.some(name => key(name) === key(table))) && this.stale(runtime));
  }

  public refresh(provider: VaultQueryTableProvider, input: SnapshotRuntime): Promise<string[]> {
    const runtime = this.preparedRuntimes.get(input) ?? prepareRuntime(input);
    const id = runtimeKey(runtime);
    const existing = this.pending.get(id);
    if (existing) return existing;
    const generation = this.generation;
    let resolve!: (tables: string[]) => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<string[]>((done, fail) => { resolve = done; reject = fail; });

    const lifetime = this.downloads.enqueue(async () => {
      if (this.pending.get(id) !== operation) {
        resolve([]);

        return;
      }

      let changed: string[] | undefined;

      try {
        changed = await this.refreshNow(provider, runtime, generation);
      }
      catch (error) {
        reject(error);
      }
      finally {
        await provider.whenIdle?.();
      }

      if (changed) resolve(changed);
    });

    void lifetime.catch(reject);
    this.pending.set(id, operation);
    void operation.finally(() => { if (this.pending.get(id) === operation) this.pending.delete(id); }).catch(() => {});

    return operation;
  }

  private assertDeclaredTables(runtime: PreparedRuntime, tables: string[]): void {
    if (!tables.length || new Set(tables.map(key)).size !== tables.length) {
      throw new Error('Definition snapshots require unique requestedTables.');
    }

    const reserved = new Set(this.staticNames().map(key));

    for (const table of tables) {
      validateSnapshotTableName(table);
      const declared = this.runtimeFor(table);

      const matches = declared && runtimeKey(declared) === runtimeKey(runtime)
        && runtimeSignature(declared) === runtimeSignature(runtime);

      if (!matches || reserved.has(key(table))) throw new Error(`Provider table name is duplicated or reserved: ${table}.`);
    }
  }

  private validateResult(result: ProviderRefreshResult, tables: string[]): void {
    if (Object.keys(result.tables).length) throw new Error('Definition snapshot providers must return snapshots, not static row upserts.');
    const snapshots = result.snapshots ?? [];
    const returned = [...snapshots, ...result.unchangedSnapshots ?? []];
    const unique = new Set(returned.map(item => key(item.table)));

    if (returned.length !== tables.length || unique.size !== returned.length || returned.some(item => !tables.includes(item.table))) {
      throw new Error('Provider returned missing, duplicate, or unreserved snapshots.');
    }

    for (const item of returned) {
      if (!item.revision || !Number.isFinite(item.asOf) || !Number.isFinite(item.expiresAt) || item.expiresAt <= item.asOf) {
        throw new Error('Provider snapshot revision and freshness are invalid.');
      }
    }

    for (const snapshot of snapshots) {
      if (snapshot.kind !== 'table' || snapshot.document.path !== snapshot.table) {
        throw new Error('Provider snapshot must contain a CSV document for its reserved table.');
      }

      const document = snapshot.document;
      this.checkSnapshotLimits(snapshot.table, document.sourceBytes, document.columns.length);
    }
  }

  private invalidatesSnapshot(error: unknown, materializing: boolean): boolean {
    if (error instanceof DataFileError) {
      if (['format', 'encoding', 'limit'].includes(error.code)) return true;
      if (error.code === 'ownership') return false;
    }

    return materializing;
  }

  private async refreshNow(provider: VaultQueryTableProvider, runtime: PreparedRuntime, generation: number): Promise<string[]> {
    const tables = runtime.definition.requestedTables ?? [];

    const prepared = await this.queue.enqueue(async () => {
      if (!this.isCurrent(runtime, generation)) return undefined;
      await this.initializeNow();
      generation = this.generation;
      if (!this.isCurrent(runtime, generation)) return undefined;
      const database = this.database();
      if (!database) throw new Error('Provider loading is waiting for the main database.');
      this.assertDeclaredTables(runtime, tables);

      await database.withProviderSnapshots(operations => {
        if (!this.isCurrent(runtime, generation)) return;
        this.assertDeclaredTables(runtime, tables);

        for (const table of tables) {
          operations.assertAvailable(ownerFor(runtime, table));
        }
      });

      if (!this.isCurrent(runtime, generation) || database !== this.database()) return undefined;
      const controller = new AbortController();
      this.controllers.set(runtimeKey(runtime), controller);

      return { database, controller };
    });

    if (!prepared) return [];
    const { database, controller } = prepared;
    const current = (): boolean => this.isCurrent(runtime, generation, controller) && this.database() === database;
    let committed = false;
    let materializing = false;

    try {
      const result = await provider.refresh({ providerId: provider.id, definitionId: runtime.definition.id,
        requestedTables: tables, request: runtime.definition.request, existingStatus: this.status(),
        existingSnapshots: tables.flatMap(table => this.ready(table) ?? []), signal: controller.signal });

      return await this.queue.enqueue(async () => {
        if (!current()) return [];
        this.assertDeclaredTables(runtime, tables);
        this.validateResult(result, tables);
        const snapshots = result.snapshots ?? [];
        materializing = snapshots.length > 0;

        const records = await database.withProviderSnapshots(operations => {
          if (!current()) return [];
          this.assertDeclaredTables(runtime, tables);

          return operations.batch(() => [
            ...snapshots.map(snapshot => operations.replace(ownerFor(runtime, snapshot.table), snapshot)),
            ...(result.unchangedSnapshots ?? []).map(metadata => operations.touch(ownerFor(runtime, metadata.table), metadata)),
          ]);
        });

        for (const record of records) {
          const previous = this.stored.get(key(record.table));
          this.schemaChanges.set(key(record.table), Boolean(previous && JSON.stringify(previous.columns) !== JSON.stringify(record.columns)));
          this.stored.set(key(record.table), record);
        }

        committed = records.length > 0;
        if (!committed) return [];
        this.errors.delete(runtimeKey(runtime));
        this.retries.delete(runtimeKey(runtime));
        const changed = snapshots.map(snapshot => snapshot.table);
        if (changed.length) await this.publish(changed);

        return changed;
      });
    }
    catch (error) {
      return await this.queue.enqueue(async () => {
        if (!current()) return [];
        this.errors.set(runtimeKey(runtime), getErrorMessage(error));
        const attempts = (this.retries.get(runtimeKey(runtime))?.attempts ?? 0) + 1;
        this.retries.set(runtimeKey(runtime), { attempts, next: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(attempts - 1, 6)) });

        if (!committed && this.invalidatesSnapshot(error, materializing)) {
          const removed: string[] = [];

          for (const table of tables) {
            const record = this.stored.get(key(table));
            if (!record) continue;
            const didRemove = await database.withProviderSnapshots(operations => current() && operations.remove(record));
            if (!didRemove) continue;
            this.stored.delete(key(table));
            removed.push(table);
          }

          if (removed.length) await this.publish(removed);
        }

        throw error;
      });
    }
    finally {
      if (this.controllers.get(runtimeKey(runtime)) === controller) this.controllers.delete(runtimeKey(runtime));
    }
  }
}
