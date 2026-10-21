import type { Database } from 'sql.js';
import { SharedSQLFunctions } from './SharedSQLFunctions';

/**
 * SQL functions that can run in a web worker (no Obsidian API dependencies)
 */
export class WorkerSQLFunctions extends SharedSQLFunctions {
  static register(db: Database): void {
    this.registerRegexFunctions(db);
    this.registerMeasurementFunctions(db);
    this.registerDateFunctions(db);
    this.registerPathFunctions(db);
    this.registerGeoFunctions(db);

    db.create_function('_vq_sync', (_type: unknown, _arg1: unknown, _arg2: unknown, _arg3: unknown, _arg4: unknown) => 0);
  }
}
