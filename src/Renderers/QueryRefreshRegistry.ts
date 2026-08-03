import { logger as rootLogger } from '../utils/logger';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import type { VaultQuerySettings } from '../Settings/Settings';
import { parseBooleanOption } from '../utils/ConfigParsingUtils';

const logger = rootLogger.scope('QueryRefresh');
const AUTO_REFRESH_DEBOUNCE_MS = 150;
const REFRESH_CONCURRENCY = 4;

export interface RefreshEntry {
  onRefresh: () => Promise<void>;
  autoRefresh?: boolean;
}

interface RefreshAllOptions {
  force?: boolean;
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

export class QueryRefreshRegistry {
  private static entries = new Map<HTMLElement, RefreshEntry>();
  private static autoRefreshTimeout: number | null = null;
  private static autoRefreshPending = false;
  private static autoRefreshRunning = false;

  static hasEntries(): boolean {
    return this.entries.size > 0;
  }

  static register(container: HTMLElement, entry: RefreshEntry): void {
    for (const registeredContainer of Array.from(this.entries.keys())) {
      if (!registeredContainer.isConnected) {
        this.entries.delete(registeredContainer);
      }
    }

    this.entries.set(container, entry);
  }

  static unregister(container: HTMLElement): void {
    for (const registeredContainer of this.entries.keys()) {
      if (registeredContainer === container || container.contains(registeredContainer)) {
        this.entries.delete(registeredContainer);
      }
    }
  }

  static async refreshAll(options: RefreshAllOptions = {}): Promise<void> {
    const refreshes: Array<() => Promise<void>> = [];

    for (const [container, entry] of Array.from(this.entries.entries())) {
      if (!container.isConnected) {
        this.entries.delete(container);
        continue;
      }
      if (!options.force && !entry.autoRefresh) {
        continue;
      }
      refreshes.push(entry.onRefresh);
    }

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

  static scheduleAutoRefresh(): void {
    this.autoRefreshPending = true;
    if (this.autoRefreshTimeout !== null) {
      window.clearTimeout(this.autoRefreshTimeout);
    }

    this.autoRefreshTimeout = window.setTimeout(() => {
      this.autoRefreshTimeout = null;
      void this.drainScheduledAutoRefreshes();
    }, AUTO_REFRESH_DEBOUNCE_MS);
  }

  private static async drainScheduledAutoRefreshes(): Promise<void> {
    if (this.autoRefreshRunning) return;

    this.autoRefreshRunning = true;
    try {
      while (this.autoRefreshPending) {
        this.autoRefreshPending = false;
        await this.refreshAll();
      }
    } finally {
      this.autoRefreshRunning = false;
    }
  }

  static async refreshForElement(element: HTMLElement): Promise<boolean> {
    let matchingContainer: HTMLElement | null = null;
    let matchingEntry: RefreshEntry | null = null;

    for (const [container, entry] of this.entries.entries()) {
      if (!container.isConnected) {
        this.entries.delete(container);
        continue;
      }

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
