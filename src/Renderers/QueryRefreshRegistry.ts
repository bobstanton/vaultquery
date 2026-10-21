import { logger as rootLogger } from '../utils/logger';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import type { VaultQuerySettings } from '../Settings/Settings';
import { parseBooleanOption } from '../utils/ConfigParsingUtils';
import { sqliteIdentifierKey } from '../utils/SqlIdentifierUtils';

const logger = rootLogger.scope('QueryRefresh');
const AUTO_REFRESH_DEBOUNCE_MS = 150;
const REFRESH_CONCURRENCY = 4;
const MAX_REFRESH_COOLDOWN_MS = 5_000;

export interface RefreshEntry {
  onRefresh: () => Promise<void>;
  autoRefresh?: boolean;
  sql?: string;
  missedTables?: Set<string> | 'all';
}

export type RefreshScopeResolver = (sql: string, tables: ReadonlySet<string>) => Promise<boolean>;

interface RefreshAllOptions {
  force?: boolean;
  tables?: Iterable<string>;
}

type PendingScope = Set<string> | 'all' | null;

function scopeKeys(tables: Iterable<string>): Set<string> {
  return new Set(Array.from(tables, sqliteIdentifierKey));
}

interface AutoRefreshResolutionOptions {
  includeGlobalDefault?: boolean;
}

export function resolveAutoRefreshSetting(settings: VaultQuerySettings, parsed: ParsedQuery | undefined, resolutionOptions: AutoRefreshResolutionOptions = {}): boolean {
  const options = parsed?.output?.options;
  const configuredValue = options?.autorefresh;
  const parsedOverride = parseBooleanOption(configuredValue);

  if (parsedOverride !== undefined) {
    return parsedOverride;
  }

  if (resolutionOptions.includeGlobalDefault === false) {
    return false;
  }

  return settings.autoRefreshOnIndexChange;
}

export function registerQueryRefresh(context: { container: HTMLElement; onRefresh?: () => Promise<void>; settings: VaultQuerySettings; parsed?: ParsedQuery }, includeGlobalDefault: boolean): void {
  if (!context.onRefresh) return;

  QueryRefreshRegistry.register(context.container, {
    onRefresh: context.onRefresh,
    autoRefresh: resolveAutoRefreshSetting(context.settings, context.parsed, { includeGlobalDefault }),
    sql: context.parsed?.query,
  });
}

export class QueryRefreshRegistry {
  private static entries = new Map<HTMLElement, RefreshEntry>();
  private static autoRefreshTimeout: number | null = null;
  private static pendingScope: PendingScope = null;
  private static autoRefreshRunning = false;
  private static lastRefreshMs = 0;
  private static revision = 0;
  private static scopeResolver: RefreshScopeResolver | undefined;
  private static reattachWatches = new Map<HTMLElement, IntersectionObserver>();

  static setScopeResolver(resolver: RefreshScopeResolver): void {
    this.scopeResolver = resolver;
  }

  static clearScopeResolver(resolver: RefreshScopeResolver): void {
    if (this.scopeResolver === resolver) this.scopeResolver = undefined;
  }

  static hasEntries(): boolean {
    return this.entries.size > 0;
  }

  static register(container: HTMLElement, entry: RefreshEntry): void {
    this.stopReattachWatch(container);
    this.entries.set(container, entry);
  }

  static unregister(container: HTMLElement): void {
    for (const registered of Array.from(this.entries.keys())) {
      if (registered === container || container.contains(registered)) {
        this.stopReattachWatch(registered);
        this.entries.delete(registered);
      }
    }
  }

  static async refreshAll(options: RefreshAllOptions = {}): Promise<void> {
    const refreshes: Array<() => Promise<void>> = [];
    const scope = options.tables === undefined ? undefined : scopeKeys(options.tables);

    const skipped: Array<{ sql?: string; reason: string }> = [];

    for (const [container, entry] of Array.from(this.entries.entries())) {
      if (!options.force && !entry.autoRefresh) {
        skipped.push({ sql: entry.sql, reason: 'auto refresh off' });
        continue;
      }

      if (!container.isConnected) {
        entry.missedTables = scope === undefined || entry.missedTables === 'all' ? 'all'
          : new Set([...entry.missedTables ?? [], ...scope]);

        this.watchForReattach(container);
        skipped.push({ sql: entry.sql, reason: 'detached' });
        continue;
      }

      const missed = entry.missedTables;
      entry.missedTables = undefined;
      const pending = missed === 'all' ? undefined : scope && missed ? new Set([...scope, ...missed]) : missed ?? scope;

      if (pending && !await this.readsChangedTables(entry, pending)) {
        skipped.push({ sql: entry.sql, reason: 'reads none of the changed tables' });
        continue;
      }

      refreshes.push(entry.onRefresh);
    }

    if (skipped.length) logger.debug('Query refresh skipped blocks', { tables: scope ? [...scope] : 'all', skipped });

    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < refreshes.length) {
        const refresh = refreshes[nextIndex++];

        try {
          await refresh();
        }
        catch (error) {
          logger.error('Query refresh failed', error);
        }
      }
    };

    const workerCount = Math.min(REFRESH_CONCURRENCY, refreshes.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  private static watchForReattach(container: HTMLElement): void {
    const Observer = container.ownerDocument?.defaultView?.IntersectionObserver;
    if (!Observer || this.reattachWatches.has(container)) return;

    const observer = new Observer((records) => {
      if (records.some(record => record.isIntersecting)) void this.catchUp(container);
    });

    observer.observe(container);
    this.reattachWatches.set(container, observer);
  }

  private static stopReattachWatch(container: HTMLElement): void {
    this.reattachWatches.get(container)?.disconnect();
    this.reattachWatches.delete(container);
  }

  private static async catchUp(container: HTMLElement): Promise<void> {
    this.stopReattachWatch(container);
    const entry = this.entries.get(container);
    const missed = entry?.missedTables;
    if (!entry || !missed || !container.isConnected) return;

    entry.missedTables = undefined;

    if (missed !== 'all' && !await this.readsChangedTables(entry, missed)) return;

    try {
      await entry.onRefresh();
    }
    catch (error) {
      logger.error('Query refresh failed', error);
    }
  }

  static dataRevision(): number {
    return this.revision;
  }

  static scheduleAutoRefresh(tables?: Iterable<string>): void {
    this.revision++;

    if (tables === undefined) {
      this.pendingScope = 'all';
    }
    else if (this.pendingScope !== 'all') {
      const pending = this.pendingScope ?? new Set<string>();

      for (const table of tables) {
        pending.add(sqliteIdentifierKey(table));
      }

      this.pendingScope = pending;
    }

    if (this.autoRefreshTimeout !== null) {
      window.clearTimeout(this.autoRefreshTimeout);
    }

    this.autoRefreshTimeout = window.setTimeout(() => {
      this.autoRefreshTimeout = null;
      void this.drainScheduledAutoRefreshes();
    }, this.refreshDelay());
  }

  private static refreshDelay(): number {
    return Math.min(Math.max(AUTO_REFRESH_DEBOUNCE_MS, this.lastRefreshMs), MAX_REFRESH_COOLDOWN_MS);
  }

  private static async readsChangedTables(entry: RefreshEntry, scope: ReadonlySet<string>): Promise<boolean> {
    if (!entry.sql || !this.scopeResolver) {
      return true;
    }

    try {
      return await this.scopeResolver(entry.sql, scope);
    }
    catch (error) {
      logger.debug('Could not scope a query refresh; refreshing it', error);

      return true;
    }
  }

  private static async drainScheduledAutoRefreshes(): Promise<void> {
    if (this.autoRefreshRunning) return;

    this.autoRefreshRunning = true;

    try {
      while (this.pendingScope !== null) {
        const scope = this.pendingScope;
        this.pendingScope = null;
        const startedAt = performance.now();
        await this.refreshAll(scope === 'all' ? {} : { tables: scope });
        this.lastRefreshMs = performance.now() - startedAt;

        if (this.pendingScope !== null && this.lastRefreshMs > AUTO_REFRESH_DEBOUNCE_MS) {
          await new Promise<void>(resolve => window.setTimeout(resolve, this.refreshDelay()));
        }
      }
    } finally {
      this.autoRefreshRunning = false;
    }
  }

  static async refreshForElement(element: HTMLElement): Promise<boolean> {
    let matchingContainer: HTMLElement | null = null;
    let matchingEntry: RefreshEntry | null = null;

    for (const [container, entry] of this.entries.entries()) {
      if (container === element || container.contains(element)) {
        if (!matchingContainer || matchingContainer.contains(container)) {
          matchingContainer = container;
          matchingEntry = entry;
        }
      }
    }

    if (!matchingEntry) {
      return false;
    }

    try {
      await matchingEntry.onRefresh();

      return true;
    }
    catch (error) {
      logger.error('Query refresh failed', error);

      return false;
    }
  }
}
