import type { TaskRow, HeadingRow, ListItemRow, TableCellRow } from '../Services/ContentLocationService';

export interface PropertyRow {
  path: string;
  key: string;
  value: string | null;
  type: string | null;
}

export interface EditPlannerPreviewResult {
  sqlToApply: string[];
  tasksAfter?: TaskRow[];
  tasksToDelete?: TaskRow[];
  headingsAfter?: HeadingRow[];
  headingsToDelete?: HeadingRow[];
  tableCellsAfter?: TableCellRow[];
  propertiesAfter?: PropertyRow[];
  propertiesToDelete?: PropertyRow[];
  listItemsAfter?: ListItemRow[];
  listItemsToDelete?: ListItemRow[];
  fileHashes?: Record<string, string>;
  fileMtimes?: Record<string, number>;
  filesToCreate?: Array<{ path: string; content: string }>;
  filesToDelete?: string[];
  notesContentUpdates?: Array<{ path: string; content: string }>;
}

export interface PreviewResult {
  op: 'insert' | 'update' | 'delete' | 'multi';
  table: string;
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
  sqlToApply: Array<{ sql: string }>;
  multiResults?: PreviewResult[];
}

export interface EntityHandlerContext {
  readFileContent: (path: string) => Promise<string>;
  queryDatabase: <T>(sql: string, params?: (string | number | null)[]) => Promise<T[]>;
  settings: {
    allowDeleteNotes: boolean;
  };
}

export interface EntityHandler {
  /**
   * Tables this handler can process
   */
  readonly supportedTables: string[];

  /**
   * Check if this handler can process the given table
   */
  canHandle(table: string): boolean;

  /**
   * Convert a preview result for this entity type
   */
  convertPreviewResult(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult>;

  /**
   * Handle INSERT operations for this entity type
   */
  handleInsertOperation(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult>;
}

/**
 * Create an empty result with required fields
 */
export function createEmptyResult(sqlToApply: string[]): EditPlannerPreviewResult {
  return {
    sqlToApply,
    tasksAfter: [],
    headingsAfter: [],
    tableCellsAfter: []
  };
}

/**
 * Extract SQL strings from preview result
 */
export function extractSql(previewResult: PreviewResult): string[] {
  return previewResult.sqlToApply.map(sp => sp.sql);
}
