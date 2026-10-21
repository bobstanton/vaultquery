import type { Database } from 'sql.js';
import { generateFileLink } from '../utils/MarkdownLinkUtils';
import type { App } from 'obsidian';
import { SharedSQLFunctions } from './SharedSQLFunctions';
import { clearSyncHandlers, registerSyncBridge } from './SyncHandlers';

export class CustomSQLFunctions extends SharedSQLFunctions {
  static clearSyncHandlers(): void {
    clearSyncHandlers();
  }

  static register(db: Database, app: App): void {
    this.registerRegexFunctions(db);
    this.registerMeasurementFunctions(db);
    this.registerDateFunctions(db);
    this.registerLinkFunctions(db, (path, subpath, alias) => generateFileLink(app, path, '', subpath, alias ?? ''));
    this.registerPathFunctions(db);
    this.registerGeoFunctions(db);
    this.registerResolveFunctions(db, app);
    registerSyncBridge(db);
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
    const linkText = this.normalizeWikilink(wikilink);
    if (!linkText) return null;

    const resolved = app.metadataCache.getFirstLinkpathDest(linkText, sourcePath || '');

    return resolved?.path ?? null;
  }
}
