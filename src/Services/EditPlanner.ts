import { App, MetadataCache } from 'obsidian';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import { ContentLocationService, type Range } from './ContentLocationService';
import { TaskEditPlanner, HeadingEditPlanner, ListItemEditPlanner, TableEditPlanner, type TaskRow, type HeadingRow, type ListItemRow, type TableCellRow, type ReplaceRangeEdit, type FrontmatterEdit, type Edit, type FrontmatterValue, type FrontmatterData, type PropertyRow, type EntityPlannerContext } from '../EditPlanner';

export type {
  ReplaceRangeEdit,
  FrontmatterEdit,
  Edit,
  FrontmatterValue,
  FrontmatterData,
  PropertyRow,
  Range
};

export type CreateFileEdit = { type: "createFile"; path: string; text: string; reason?: string };
export type DeleteFileEdit = { type: "deleteFile"; path: string; reason?: string };

export interface EditPlan {
  edits: Edit[];
  warnings: string[];
  stats: {
    filesTouched: number;
    replaceRangeEdits: number;
    frontmatterEdits: number;
    created: number;
    deleted: number;
    createdAt: string;
  };
}

export interface TableRowGroup {
  path: string;
  table_index: number;
  block_id?: string | null;
  table_start?: number | null;
  table_end?: number | null;
  line_number?: number | null;
  header: string[];
  rows: Array<Record<string, string>>;
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

export interface EditPlannerDeps {
  app: App;
  metadataCache: MetadataCache;
  readFile: (path: string) => Promise<string>;
  discoverTableRange?: (content: string, tableIndex: number) => Range | null;
  queryListItemsByListIndex?: (path: string, listIndex: number) => Promise<Array<{ line_number: number | null; item_index: number }>>;
}

interface PathGroups {
  tasks: TaskRow[];
  tasksToDelete: TaskRow[];
  headings: HeadingRow[];
  headingsToDelete: HeadingRow[];
  tableCells: TableCellRow[];
  properties: PropertyRow[];
  propertiesToDelete: PropertyRow[];
  listItems: ListItemRow[];
  listItemsToDelete: ListItemRow[];
}

export class EditPlanner {
  private readonly contentLocationService: ContentLocationService;
  private readonly taskPlanner: TaskEditPlanner;
  private readonly headingPlanner: HeadingEditPlanner;
  private readonly listItemPlanner: ListItemEditPlanner;
  private readonly tablePlanner: TableEditPlanner;

  public constructor(private readonly deps: EditPlannerDeps) {
    this.contentLocationService = new ContentLocationService(deps.app, deps.metadataCache);
    this.taskPlanner = new TaskEditPlanner(this.contentLocationService);
    this.headingPlanner = new HeadingEditPlanner(this.contentLocationService);
    this.listItemPlanner = new ListItemEditPlanner(this.contentLocationService);
    this.tablePlanner = new TableEditPlanner(
      this.contentLocationService,
      deps.discoverTableRange || ((content, tableIndex) => MarkdownTableUtils.findTableByIndex(content, tableIndex))
    );
  }

  public async planFromPreview(preview: EditPlannerPreviewResult): Promise<EditPlan> {
    const byPath = this.groupByPath(preview);
    const edits: Edit[] = [];
    const warnings: string[] = [];

    // Handle file creations
    if (preview.filesToCreate) {
      for (const fileToCreate of preview.filesToCreate) {
        edits.push({
          type: 'createFile',
          path: fileToCreate.path,
          text: fileToCreate.content,
          reason: 'INSERT into notes table'
        });
      }
    }

    if (preview.filesToDelete) {
      for (const pathToDelete of preview.filesToDelete) {
        edits.push({
          type: 'deleteFile',
          path: pathToDelete,
          reason: 'DELETE FROM notes'
        });
      }
    }

    const pendingCreates = new Map<string, string>();
    if (preview.filesToCreate) {
      for (const f of preview.filesToCreate) {
        pendingCreates.set(f.path, f.content);
      }
    }

    if (preview.notesContentUpdates) {
      for (const update of preview.notesContentUpdates) {
        let existingContent: string;
        try {
          existingContent = await this.deps.readFile(update.path);
        }
        catch (e) {
          console.warn('[VaultQuery] EditPlanner: Failed to read file for content update', update.path, e);
          warnings.push(`File not found or unreadable: ${update.path}`);
          continue;
        }

        edits.push({
          type: 'replaceRange',
          path: update.path,
          range: { start: 0, end: existingContent.length },
          text: update.content,
          reason: 'UPDATE notes content'
        });
      }
    }

    for (const [path, groups] of byPath) {
      let content: string;
      if (pendingCreates.has(path)) {
        content = pendingCreates.get(path)!;
      }
      else {
        try {
          content = await this.deps.readFile(path);
        }
        catch (e) {
          console.warn('[VaultQuery] EditPlanner: Failed to read file', path, e);
          warnings.push(`File not found or unreadable: ${path}`);
          continue;
        }
      }

      const ctx: EntityPlannerContext = { content, path, warnings };

      const taskResult = this.taskPlanner.planTaskEdits(ctx, groups.tasks, groups.tasksToDelete);
      warnings.push(...taskResult.warnings);

      const headingResult = this.headingPlanner.planHeadingEdits(ctx, groups.headings, groups.headingsToDelete);
      warnings.push(...headingResult.warnings);

      const tableResult = this.tablePlanner.planTableEdits(ctx, groups.tableCells);
      warnings.push(...tableResult.warnings);

      const listItemResult = await this.listItemPlanner.planListItemEdits(
        ctx,
        groups.listItems,
        groups.listItemsToDelete,
        this.deps.queryListItemsByListIndex
      );
      warnings.push(...listItemResult.warnings);

      if (groups.properties.length > 0 || groups.propertiesToDelete.length > 0) {
        edits.push({
          type: "frontmatter",
          path,
          mutate: (fm: FrontmatterData) => {
            for (const prop of groups.properties) {
              fm[prop.key] = this.parsePropertyValue(prop.value, prop.type);
            }
            for (const prop of groups.propertiesToDelete) {
              delete fm[prop.key];
            }
          },
          reason: "update properties"
        });
      }

      const merged = this.mergeByPriorityThenValidate(
        [tableResult.edits, headingResult.edits, taskResult.edits, listItemResult.edits],
        warnings
      );
      edits.push(...merged);
    }

    const stats = {
      filesTouched: new Set(edits.map(e => e.path)).size,
      replaceRangeEdits: edits.filter(e => e.type === "replaceRange").length,
      frontmatterEdits: edits.filter(e => e.type === "frontmatter").length,
      created: edits.filter(e => e.type === "createFile").length,
      deleted: edits.filter(e => e.type === "deleteFile").length,
      createdAt: new Date().toISOString(),
    };

    return { edits, warnings, stats };
  }

  public emitTaskLine(base: TaskRow, completed: boolean, existing?: string): string {
    return this.taskPlanner.emitTaskLine(base, completed, existing);
  }

  public emitHeadingLine(row: HeadingRow, existing?: string): string {
    return this.headingPlanner.emitHeadingLine(row, existing);
  }

  public emitListItemLine(base: ListItemRow, existing?: string): string {
    return this.listItemPlanner.emitListItemLine(base, existing);
  }

  public buildMarkdownTable(header: string[], rows: Array<Record<string, string>>): string {
    return this.tablePlanner.buildMarkdownTable(header, rows);
  }

  private groupByPath(preview: EditPlannerPreviewResult): Map<string, PathGroups> {
    const byPath: Map<string, PathGroups> = new Map();

    const getOrCreate = (path: string): PathGroups => {
      if (!byPath.has(path)) {
        byPath.set(path, {
          tasks: [],
          tasksToDelete: [],
          headings: [],
          headingsToDelete: [],
          tableCells: [],
          properties: [],
          propertiesToDelete: [],
          listItems: [],
          listItemsToDelete: []
        });
      }
      return byPath.get(path)!;
    };

    for (const t of preview.tasksAfter ?? []) getOrCreate(t.path).tasks.push(t);
    for (const t of preview.tasksToDelete ?? []) getOrCreate(t.path).tasksToDelete.push(t);
    for (const h of preview.headingsAfter ?? []) getOrCreate(h.path).headings.push(h);
    for (const h of preview.headingsToDelete ?? []) getOrCreate(h.path).headingsToDelete.push(h);
    for (const c of preview.tableCellsAfter ?? []) getOrCreate(c.path).tableCells.push(c);
    for (const p of preview.propertiesAfter ?? []) getOrCreate(p.path).properties.push(p);
    for (const p of preview.propertiesToDelete ?? []) getOrCreate(p.path).propertiesToDelete.push(p);
    for (const l of preview.listItemsAfter ?? []) getOrCreate(l.path).listItems.push(l);
    for (const l of preview.listItemsToDelete ?? []) getOrCreate(l.path).listItemsToDelete.push(l);

    return byPath;
  }

  private sortAndValidateEdits(edits: ReplaceRangeEdit[]): { ok: ReplaceRangeEdit[]; warnings: string[] } {
    const warnings: string[] = [];
    const sorted = edits.slice().sort((a, b) => b.range.start - a.range.start);
    const ok: ReplaceRangeEdit[] = [];
    let prevStart = Number.POSITIVE_INFINITY;

    for (const e of sorted) {
      if (e.range.start > e.range.end) {
        warnings.push(`Invalid range [${e.range.start}, ${e.range.end}) for ${e.path}`);
        continue;
      }
      if (e.range.end > prevStart) {
        warnings.push(`Overlap detected in ${e.path} around ${e.range.start}-${e.range.end}; keeping higher-priority edit only.`);
        continue;
      }
      ok.push(e);
      prevStart = e.range.start;
    }
    return { ok, warnings };
  }

  private mergeByPriorityThenValidate(buckets: ReplaceRangeEdit[][], warnings: string[]): ReplaceRangeEdit[] {
    const concat = ([] as ReplaceRangeEdit[]).concat(...buckets);
    const { ok, warnings: w } = this.sortAndValidateEdits(concat);
    warnings.push(...w);
    return ok;
  }

  private parsePropertyValue(value: string | null, type: string | null): FrontmatterValue {
    if (value === null || value === undefined) {
      return null;
    }

    switch (type?.toLowerCase()) {
      case 'number':
        const num = Number(value);
        return isNaN(num) ? value : num;

      case 'boolean':
        const lower = value.toLowerCase();
        if (lower === 'true' || lower === '1' || lower === 'yes') return true;
        if (lower === 'false' || lower === '0' || lower === 'no') return false;
        return value;

      case 'date':
      case 'datetime':
        return value;

      case 'list':
      case 'array':
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        }
        catch (e) {
          console.warn('[VaultQuery] EditPlanner: Failed to parse array property value', value, e);
          if (value.includes(',')) {
            return value.split(',').map(s => s.trim());
          }
        }
        return value;

      case 'aliases':
      case 'tags':
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        }
        catch (e) {
          console.warn('[VaultQuery] EditPlanner: Failed to parse tags/aliases property value', value, e);
          if (value.includes(',')) {
            return value.split(',').map(s => s.trim());
          }
        }
        return value;

      default:
        return value;
    }
  }
}
