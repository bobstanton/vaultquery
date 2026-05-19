import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('QueryRefresh');

interface RefreshEntry {
  onRefresh: () => Promise<void>;
  shouldRefresh?: (indexedPaths: Set<string>) => boolean;
}

export function buildShouldRefreshPredicate(sourcePath: string | undefined, query: string | undefined): ((indexedPaths: Set<string>) => boolean) | undefined {
  if (!sourcePath || !query) return undefined;
  if (!query.includes('{this.path}')) return undefined;
  return (indexedPaths) => indexedPaths.has(sourcePath);
}

export class QueryRefreshRegistry {
  private static entries = new Map<HTMLElement, RefreshEntry>();

  static register(container: HTMLElement, entry: RefreshEntry): void {
    this.entries.set(container, entry);
  }

  static unregister(container: HTMLElement): void {
    this.entries.delete(container);
  }

  static async refreshAll(indexedPaths?: string[]): Promise<void> {
    const indexedSet = indexedPaths ? new Set(indexedPaths) : null;
    const promises: Promise<void>[] = [];

    for (const [container, entry] of this.entries.entries()) {
      if (!container.isConnected) {
        this.entries.delete(container);
        continue;
      }
      if (indexedSet && entry.shouldRefresh && !entry.shouldRefresh(indexedSet)) {
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
}
