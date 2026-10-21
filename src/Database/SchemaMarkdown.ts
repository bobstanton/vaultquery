import { taskColumnDocs, BLOCKS_COLUMNS, EMBEDS_COLUMNS, HEADINGS_COLUMNS, HEADINGS_VIEW_COLUMNS, LINKS_COLUMNS, LIST_ITEMS_COLUMNS, LIST_ITEMS_VIEW_COLUMNS, NOTES_COLUMNS, PROPERTIES_COLUMNS, TABLE_CELLS_COLUMNS, TABLE_ROWS_COLUMNS, TAGS_COLUMNS, TASKS_VIEW_COLUMNS, UNRESOLVED_LINKS_COLUMNS } from './SchemaDocumentation';
import type { SchemaTable } from './SchemaDocumentation';
import type { VaultQuerySettings } from '../Settings/Settings';

export interface SchemaViews {
  getViewNames(): string[] | Promise<string[]>;
  getViewColumns(view: string): string[] | Promise<string[]>;
}

export class CachedSchemaViews implements SchemaViews {
  private names?: string[];
  private readonly columns = new Map<string, string[]>();
  public constructor(private readonly schema: SchemaViews) {}

  public async getViewNames(): Promise<string[]> {
    return this.names ??= await this.schema.getViewNames();
  }

  public async getViewColumns(view: string): Promise<string[]> {
    const cached = this.columns.get(view);
    if (cached) return cached;
    const columns = await this.schema.getViewColumns(view);
    this.columns.set(view, columns);

    return columns;
  }
}

export async function schemaTables(settings: VaultQuerySettings, schema: SchemaViews): Promise<SchemaTable[]> {
  const tables: SchemaTable[] = [];

  tables.push({ name: 'notes', columns: NOTES_COLUMNS, isView: false, notes: [] });

  if (settings.enabledFeatures.indexFrontmatter) {
    tables.push({ name: 'properties', columns: PROPERTIES_COLUMNS, isView: false, notes: [] });

    const viewColumns = await schema.getViewColumns('notes_with_properties');

    if (viewColumns.length > 0) {
      const viewCols = viewColumns.map((col: string) => ({
        name: col,
        type: ['path', 'title', 'content'].includes(col) ? 'TEXT' :
              ['created', 'modified', 'size'].includes(col) ? 'INTEGER' : 'TEXT',
        description: NOTES_COLUMNS.find(column => column.name === col)?.description ?? 'Frontmatter value',
      }));

      tables.push({ name: 'notes_with_properties', columns: viewCols, isView: true,
        notes: [
          "One row per note, including notes without properties. Property columns are TEXT; missing values are NULL; list values are JSON arrays. Column names are sanitized, lowercase frontmatter keys.",
          "Supports INSERT, UPDATE, DELETE (syncs to frontmatter). Writes preserve original keys. JSON arrays write lists; other text is split on commas only for list properties. Ambiguous property columns require writing to properties with the exact key.",
        ] });
    }

    const notePropsColumns = await schema.getViewColumns('note_properties');

    if (notePropsColumns.length > 0) {
      const notePropsViewCols = notePropsColumns.map((col: string) => ({
        name: col,
        type: 'TEXT',
        description: col === 'path' ? 'Vault-relative note path' : 'Frontmatter value',
      }));

      tables.push({ name: 'note_properties', columns: notePropsViewCols, isView: true,
        notes: [
          "One row per path with properties (no notes columns). Uses the TEXT columns and JSON list values from notes_with_properties. Supports INSERT (existing notes only), UPDATE, DELETE.",
        ] });
    }
  }

  if (settings.enabledFeatures.indexTasks) {
    tables.push({ name: 'tasks', columns: taskColumnDocs(), isView: false, notes: [] });

    tables.push({ name: 'tasks_view', columns: TASKS_VIEW_COLUMNS, isView: true,
      notes: [
        "Supports INSERT, UPDATE, DELETE. When no tasks exist, new tasks insert at line 1 (beginning of file).",
      ] });
  }

  if (settings.enabledFeatures.indexHeadings) {
    tables.push({ name: 'headings', columns: HEADINGS_COLUMNS, isView: false, notes: [] });

    tables.push({ name: 'headings_view', columns: HEADINGS_VIEW_COLUMNS, isView: true,
      notes: [
        "Supports INSERT, UPDATE, DELETE. When no headings exist, new headings insert at line 1 (beginning of file).",
      ] });
  }

  if (settings.enabledFeatures.indexTags) {
    tables.push({ name: 'tags', columns: TAGS_COLUMNS, isView: false, notes: [] });
  }

  if (settings.enabledFeatures.indexLinks) {
    tables.push({ name: 'links', columns: LINKS_COLUMNS, isView: false, notes: [] });
  }

  if (settings.enabledFeatures.indexUnresolvedLinks) {
    tables.push({ name: 'unresolved_links', columns: UNRESOLVED_LINKS_COLUMNS, isView: false, notes: [] });
  }

  if (settings.enabledFeatures.indexEmbeds) {
    tables.push({ name: 'embeds', columns: EMBEDS_COLUMNS, isView: false, notes: [] });
  }

  if (settings.enabledFeatures.indexBlocks) {
    tables.push({ name: 'blocks', columns: BLOCKS_COLUMNS, isView: false, notes: [] });
  }

  if (settings.enabledFeatures.indexListItems) {
    tables.push({ name: 'list_items', columns: LIST_ITEMS_COLUMNS, isView: false, notes: [] });

    tables.push({ name: 'list_items_view', columns: LIST_ITEMS_VIEW_COLUMNS, isView: true,
      notes: [
        "Supports INSERT, UPDATE, DELETE. When no list items exist, new items insert at line 1 (beginning of file).",
      ] });
  }

  if (settings.enabledFeatures.indexTables) {
    tables.push({ name: 'table_cells', columns: TABLE_CELLS_COLUMNS, isView: false, notes: [] });

    tables.push({ name: 'table_rows', columns: TABLE_ROWS_COLUMNS, isView: true,
      notes: [
        "Supports INSERT, UPDATE, DELETE",
      ] });
  }

  const views = await schema.getViewNames();
  const builtInViews = ['notes_with_properties', 'headings_view', 'list_items_view', 'tasks_view', 'table_rows', 'table_columns', 'note_properties'];
  const dynamicViews = views.filter((v: string) => !builtInViews.includes(v));

  for (const viewName of dynamicViews) {
    const viewColumns = await schema.getViewColumns(viewName);

    if (viewColumns.length > 0) {
      const viewCols = viewColumns.map((col: string) => ({
        name: col,
        type: ['path', 'table_name'].includes(col) ? 'TEXT' :
              ['table_index', 'row_index'].includes(col) ? 'INTEGER' : 'TEXT',
        description: ['path', 'table_index', 'row_index', 'table_name'].includes(col)
          ? TABLE_CELLS_COLUMNS.find(column => column.name === col)?.description ?? '' : '',
      }));

      tables.push({ name: viewName, columns: viewCols, isView: true,
        notes: [
          "Supports INSERT, UPDATE, DELETE",
        ], section: 'Dynamic Table Views',
        sectionNote: 'These views are auto-generated from markdown tables in the vault. Enable "Dynamic table views" in settings.' });
    }
  }

  return tables;
}

export function disabledSchemaTables(settings: VaultQuerySettings): string[] {
  const disabledFeatures: string[] = [];
  if (!settings.enabledFeatures.indexFrontmatter) disabledFeatures.push('properties');
  if (!settings.enabledFeatures.indexTables) disabledFeatures.push('table_cells');
  if (!settings.enabledFeatures.indexTasks) disabledFeatures.push('tasks');
  if (!settings.enabledFeatures.indexHeadings) disabledFeatures.push('headings');
  if (!settings.enabledFeatures.indexLinks) disabledFeatures.push('links');
  if (!settings.enabledFeatures.indexUnresolvedLinks) disabledFeatures.push('unresolved_links');
  if (!settings.enabledFeatures.indexEmbeds) disabledFeatures.push('embeds');
  if (!settings.enabledFeatures.indexTags) disabledFeatures.push('tags');
  if (!settings.enabledFeatures.indexBlocks) disabledFeatures.push('blocks');
  if (!settings.enabledFeatures.indexListItems) disabledFeatures.push('list_items');

  return disabledFeatures;
}
