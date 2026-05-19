import { Database } from 'sql.js';
import { App } from 'obsidian';
import { SharedSQLFunctions } from './SharedSQLFunctions';

type SyncHandler = (...args: unknown[]) => number;

const syncHandlers: Map<string, SyncHandler> = new Map();

export class CustomSQLFunctions extends SharedSQLFunctions {
  static registerSyncHandler(name: string, handler: SyncHandler): void {
    syncHandlers.set(name, handler);
  }

  static clearSyncHandlers(): void {
    syncHandlers.clear();
  }

  static register(db: Database, app: App): void {
    this.registerRegexFunctions(db);
    this.registerDateFunctions(db);
    this.registerLinkFunctions(db);
    this.registerPathFunctions(db);
    this.registerGeoFunctions(db);
    this.registerResolveFunctions(db, app);
    this.registerSyncBridge(db);
  }

  private static registerSyncBridge(db: Database): void {
    // Note: sql.js doesn't support variadic functions, so we use fixed arity
    db.create_function('_vq_sync', (type: string, arg1: unknown, arg2: unknown, arg3: unknown, arg4: unknown) => {
      const handler = syncHandlers.get(type);
      if (handler) {
        // Filter out undefined args (sql.js passes undefined for unused args)
        const args = [arg1, arg2, arg3, arg4].filter(a => a !== undefined);
        return handler(...args);
      }
      return 0;
    });
  }

  private static registerResolveFunctions(db: Database, app: App): void {
    db.create_function('resolve_link', (wikilink: string) => {
      return this.resolveLink(app, wikilink, '');
    });

    // Useful when the link might be relative to a specific location
    db.create_function('resolve_link', (wikilink: string, sourcePath: string) => {
      return this.resolveLink(app, wikilink, sourcePath);
    });
  }

  private static resolveLink(app: App, wikilink: string, sourcePath: string): string | null {
    if (wikilink == null) return null;

    let linkText = wikilink.trim();
    if (linkText.startsWith('[[') && linkText.endsWith(']]')) {
      linkText = linkText.slice(2, -2);
    }

    const pipeIndex = linkText.indexOf('|');
    if (pipeIndex !== -1) {
      linkText = linkText.substring(0, pipeIndex);
    }

    const hashIndex = linkText.indexOf('#');
    if (hashIndex !== -1) {
      linkText = linkText.substring(0, hashIndex);
    }

    linkText = linkText.trim();
    if (!linkText) return null;

    const resolved = app.metadataCache.getFirstLinkpathDest(linkText, sourcePath || '');
    return resolved?.path ?? null;
  }
}
