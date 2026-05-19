import type { IndexNoteData } from '../types/types.d.ts';
import type { EnabledFeatures } from './DatabaseSchema';

export type WorkerRequest =
  | { type: 'init'; id: number; wasmBinary?: ArrayBuffer }
  | { type: 'query'; id: number; sql: string; params: (string | number | null)[] }
  | { type: 'run'; id: number; sql: string; params: (string | number | null)[] }
  | { type: 'indexNote'; id: number; data: IndexNoteData }
  | { type: 'indexNotesBatch'; id: number; notesData: IndexNoteData[]; isInitialIndexing: boolean }
  | { type: 'createIndexes'; id: number; features?: EnabledFeatures }
  | { type: 'registerFunction'; id: number; name: string; source: string }
  | { type: 'deleteNote'; id: number; path: string }
  | { type: 'close'; id: number }
  | { type: 'export'; id: number }
  | { type: 'import'; id: number; data: ArrayBuffer }
  | { type: 'rebuildPropertiesView'; id: number }
  | { type: 'rebuildTableViews'; id: number; enableDynamicTableViews: boolean }
  | { type: 'getAllPropertyKeys'; id: number }
  | { type: 'getViewNames'; id: number }
  | { type: 'getViewColumns'; id: number; viewName: string }
  | { type: 'getAllUserViews'; id: number }
  | { type: 'getAllUserFunctions'; id: number }
  | { type: 'getAllUserTriggers'; id: number }
  | { type: 'registerTrigger'; id: number; triggerName: string; triggerSql: string; sourcePath?: string }
  | { type: 'registerUserTriggers'; id: number }
  | { type: 'health'; id: number };

export type WorkerResponse =
  | { type: 'success'; id: number; result?: unknown }
  | { type: 'error'; id: number; error: string }
  | { type: 'ready' };
