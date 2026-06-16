import { logger as rootLogger } from '../utils/logger';
import type { ParsedQuery } from '../utils/QueryParsingUtils';
import type { VaultQuerySettings } from '../Settings/Settings';
import { parseBooleanOption } from '../utils/ConfigParsingUtils';

const logger = rootLogger.scope('QueryRefresh');

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
  const configuredValue = options?.autorefresh ?? options?.['auto-refresh'];
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

  static hasEntries(): boolean {
    return this.entries.size > 0;
  }

  static register(container: HTMLElement, entry: RefreshEntry): void {
    // Opportunistically drop entries for DOM Obsidian has discarded, so the
    // map (and the closures it holds over query results) doesn't grow for the
    // lifetime of the session.
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
    const promises: Promise<void>[] = [];

    for (const [container, entry] of Array.from(this.entries.entries())) {
      if (!container.isConnected) {
        this.entries.delete(container);
        continue;
      }
      if (!options.force && !entry.autoRefresh) {
        continue;
      }
      promises.push(entry.onRefresh());
    }

    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('Query refresh failed', result.reason);
      }
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
