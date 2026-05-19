import { Database } from 'sql.js';
import { SharedSQLFunctions } from './SharedSQLFunctions';

/**
 * SQL functions that can run in a web worker (no Obsidian API dependencies)
 */
export class WorkerSQLFunctions extends SharedSQLFunctions {

  static register(db: Database): void {
    this.registerRegexFunctions(db);
    this.registerDateFunctions(db);
    this.registerLinkFunctions(db);
    this.registerPathFunctions(db);
    this.registerGeoFunctions(db);
    // Note: resolve_link() is NOT included - it requires Obsidian API
  }
}
