import { stringifyYaml } from 'obsidian';
import { escapeRegex, processEscapeSequences } from '../utils/StringUtils';
import { logger as rootLogger } from '../utils/logger';
import { asNum, asStr, readLocationFields } from './types';
import { appendCellsFromTableRows } from './TableUtils';
import { createRowColumnKey, createTableKey, parseTableKey } from '../utils/StringUtils';
import { formatUnknownValue } from '../utils/ResultFormatUtils';

import type { PreviewResult } from './types';
import type { ObsidianEditIntent, ObsidianEntityLocation } from './ObsidianEditIntent';
import type { HeadingRow, ListItemRow, TableCellRow, TaskRow } from '../Services/ContentLocationService';

const logger = rootLogger.scope('WriteSync');

export type QueryDescendants = (rows: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
type QueryDatabase = <T>(sql: string, params?: (string | number | null)[]) => Promise<T[]>;
type ReadFileContent = (path: string) => Promise<string | null>;
type TableCellMapByTable = Map<string, Map<string, TableCellRow>>;
type TableCellKeySetByTable = Map<string, Set<string>>;
type NewRowsByTable = Map<string, TableCellRow[]>;

interface PropertyRow {
  path: string;
  key: string;
  value: string | null;
  type: string | null;
}

const DIRECT_TABLES = new Set([
  'notes',
  'notes_with_properties',
  'properties',
  'tasks',
  'tasks_view',
  'headings',
  'headings_view',
  'list_items',
  'list_items_view',
  'table_cells',
  'table_rows',
  'tags',
  'links'
]);

export function createPropertyIntents(previewResult: PreviewResult): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    return previewResult.before.map(row => {
      const property = toPropertyRow(row);
      return {
        type: 'deleteProperty',
        path: property.path,
        key: property.key
      };
    });
  }

  if (previewResult.op === 'update') {
    const beforeProps = previewResult.before.map(toPropertyRow);
    const afterProps = previewResult.after.map(toPropertyRow);
    const intents: ObsidianEditIntent[] = [];

    for (let i = 0; i < afterProps.length; i++) {
      const before = beforeProps[i];
      const after = afterProps[i];
      if (!after) {
        continue;
      }

      intents.push(createSetPropertyIntent(after));
      if (before && before.key !== after.key) {
        intents.push({
          type: 'deleteProperty',
          path: before.path,
          key: before.key
        });
      }
    }

    return intents;
  }

  return previewResult.after.map(row => createSetPropertyIntent(toPropertyRow(row)));
}

export function createNoteIntents(previewResult: PreviewResult, allowDeleteNotes: boolean): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    if (!allowDeleteNotes) {
      throw new Error('DELETE FROM notes is disabled. Enable "Allow file deletion" in VaultQuery settings to delete files.');
    }

    return previewResult.before.map(row => ({
      type: 'deleteNote',
      path: row.path as string
    }));
  }

  if (previewResult.op === 'update') {
    if (previewResult.table === 'notes_with_properties') {
      return [];
    }

    return previewResult.after
      .filter(row => row.content !== undefined)
      .map(row => ({
        type: 'replaceNoteBody',
        path: row.path as string,
        content: processEscapeSequences(row.content as string)
      }));
  }

  if (previewResult.op === 'insert') {
    const isFromPropertiesView = previewResult.table === 'notes_with_properties';
    const notesCoreColumns = ['path', 'title', 'content', 'created', 'modified', 'size'];

    return previewResult.after.map(row => {
      const path = row.path as string;
      let content = processEscapeSequences((row.content as string) || '');

      const title = row.title as string | undefined;
      if (!content && title) {
        content = `# ${title}\n\n`;
      }

      if (isFromPropertiesView) {
        const properties: Record<string, string> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!notesCoreColumns.includes(key) && value !== null && value !== undefined) {
            properties[key] = formatUnknownValue(value);
          }
        }

        if (Object.keys(properties).length > 0) {
          const frontmatterYaml = stringifyYaml(properties).trimEnd();
          const frontmatter = ["---", frontmatterYaml, "---", "", ""].join("\n");
          content = frontmatter + content;
        }
      }

      return { type: 'createNote', path, content };
    });
  }

  return [];
}

export function canDirectlyApplyPreviewResult(previewResult: PreviewResult): boolean {
  if (previewResult.op === 'multi') {
    return previewResult.multiResults?.every(canDirectlyApplyPreviewResult) ?? false;
  }

  return DIRECT_TABLES.has(previewResult.table);
}

export async function createDirectlyApplicableIntents(previewResult: PreviewResult, allowDeleteNotes: boolean, queryListItemDescendants?: QueryDescendants,
  queryDatabase?: QueryDatabase, readFileContent?: ReadFileContent): Promise<ObsidianEditIntent[] | null> {
  if (!canDirectlyApplyPreviewResult(previewResult)) {
    return null;
  }

  if (previewResult.op === 'multi') {
    if (!queryDatabase) {
      throw new Error('Multi-statement writes require database lookup.');
    }
    return await createMultiStatementIntents(previewResult, allowDeleteNotes, queryListItemDescendants, queryDatabase, readFileContent);
  }

  if (previewResult.table === 'notes' || previewResult.table === 'notes_with_properties') {
    if (previewResult.table === 'notes_with_properties' && previewResult.op === 'update') {
      return createNotesWithPropertiesUpdateIntents(previewResult);
    }
    return createNoteIntents(previewResult, allowDeleteNotes);
  }

  if (previewResult.table === 'tasks' || previewResult.table === 'tasks_view') {
    return createTaskIntents(previewResult);
  }

  if (previewResult.table === 'headings' || previewResult.table === 'headings_view') {
    return createHeadingIntents(previewResult);
  }

  if (previewResult.table === 'list_items' || previewResult.table === 'list_items_view') {
    if (previewResult.table === 'list_items_view' && previewResult.op === 'delete') {
      if (!queryListItemDescendants) {
        throw new Error('DELETE FROM list_items_view requires descendant lookup.');
      }

      const rowsToDelete = await queryListItemDescendants(previewResult.before);
      return createListItemIntents({ ...previewResult, before: rowsToDelete });
    }

    return createListItemIntents(previewResult);
  }

  if (previewResult.table === 'table_cells' || previewResult.table === 'table_rows') {
    if (!queryDatabase) {
      throw new Error(`${previewResult.table} writes require table cell lookup.`);
    }
    return await createTableRewriteIntents(previewResult, queryDatabase);
  }

  if (previewResult.table === 'tags') {
    if (!queryDatabase || !readFileContent) {
      throw new Error('tags writes require note content and tag lookup.');
    }
    return await createTagIntents(previewResult, queryDatabase, readFileContent);
  }

  if (previewResult.table === 'links') {
    if (!readFileContent) {
      throw new Error('links writes require note content lookup.');
    }
    return await createLinkIntents(previewResult, readFileContent);
  }

  return createPropertyIntents(previewResult);
}

async function createMultiStatementIntents(previewResult: PreviewResult, allowDeleteNotes: boolean, queryListItemDescendants: QueryDescendants | undefined,
  queryDatabase: QueryDatabase, readFileContent: ReadFileContent | undefined): Promise<ObsidianEditIntent[] | null> {
  const intents: ObsidianEditIntent[] = [];
  const changedCellsByTable: TableCellMapByTable = new Map();
  const deletedCellsByTable: TableCellKeySetByTable = new Map();
  const affectedTables = new Set<string>();
  const newRowsByTable: NewRowsByTable = new Map();

  for (const result of previewResult.multiResults ?? []) {
    if (result.table === 'table_cells') {
      collectTableCellStatement(result, changedCellsByTable, deletedCellsByTable, affectedTables);
      continue;
    }

    if (result.table === 'table_rows' && result.op === 'insert') {
      await appendCellsFromTableRows(
        result.after,
        affectedTables,
        newRowsByTable,
        async (path, tableIndex) => {
          return await queryMaxTableRow(queryDatabase, path, tableIndex);
        },
        'ObsidianEditIntentFactory'
      );
      continue;
    }

    const resultIntents = await createDirectlyApplicableIntents(result, allowDeleteNotes, queryListItemDescendants, queryDatabase, readFileContent);
    if (!resultIntents) {
      return null;
    }
    intents.push(...resultIntents);
  }

  const tableCells = await buildMultiStatementTableCells(affectedTables, changedCellsByTable, deletedCellsByTable, newRowsByTable, queryDatabase);
  intents.push(...createTableRewriteIntentsFromCells(tableCells));
  return intents;
}

function collectTableCellStatement(previewResult: PreviewResult, changedCellsByTable: TableCellMapByTable,
  deletedCellsByTable: TableCellKeySetByTable, affectedTables: Set<string>): void {
  if (previewResult.op === 'delete') {
    for (const row of previewResult.before) {
      const cell = toTableCellRow(row);
      const tableKey = createTableKey(cell.path, cell.table_index);
      const cellKey = createRowColumnKey(cell.row_index, cell.column_name);
      const deletedCells = deletedCellsByTable.get(tableKey) || new Set<string>();
      deletedCells.add(cellKey);
      deletedCellsByTable.set(tableKey, deletedCells);
      affectedTables.add(tableKey);
    }
    return;
  }

  for (const row of previewResult.after) {
    const cell = toTableCellRow(row);
    const tableKey = createTableKey(cell.path, cell.table_index);
    const cellKey = createRowColumnKey(cell.row_index, cell.column_name);
    const tableCells = changedCellsByTable.get(tableKey) || new Map<string, TableCellRow>();
    tableCells.set(cellKey, cell);
    changedCellsByTable.set(tableKey, tableCells);
    deletedCellsByTable.get(tableKey)?.delete(cellKey);
    affectedTables.add(tableKey);
  }
}

function mergeExistingCells(existingCellRows: TableCellRow[], changedCells: Map<string, TableCellRow>, deletedCells: Set<string>): TableCellRow[] {
  const mergedCells: TableCellRow[] = [];

  for (const existingCell of existingCellRows) {
    const cellKey = createRowColumnKey(existingCell.row_index, existingCell.column_name);
    if (deletedCells.has(cellKey)) {
      continue;
    }
    mergedCells.push(changedCells.get(cellKey) ?? existingCell);
  }

  return mergedCells;
}

async function buildMultiStatementTableCells(affectedTables: Set<string>, changedCellsByTable: TableCellMapByTable,
  deletedCellsByTable: TableCellKeySetByTable, newRowsByTable: NewRowsByTable, queryDatabase: QueryDatabase): Promise<TableCellRow[]> {
  const allTableCells: TableCellRow[] = [];

  for (const tableKey of affectedTables) {
    const { path, tableIndex } = parseTableKey(tableKey);
    const changedCells = changedCellsByTable.get(tableKey) || new Map<string, TableCellRow>();
    const deletedCells = deletedCellsByTable.get(tableKey) || new Set<string>();
    const existingCellRows = await queryExistingTableCells(path, tableIndex, queryDatabase);

    allTableCells.push(...mergeExistingCells(existingCellRows, changedCells, deletedCells));

    const newRows = newRowsByTable.get(tableKey);
    if (newRows) {
      allTableCells.push(...newRows);
    }
  }

  return allTableCells;
}

function createNotesWithPropertiesUpdateIntents(previewResult: PreviewResult): ObsidianEditIntent[] {
  const notesCoreColumns = ['path', 'title', 'content', 'created', 'modified', 'size'];
  const intents: ObsidianEditIntent[] = [];

  for (let i = 0; i < previewResult.after.length; i++) {
    const afterRow = previewResult.after[i];
    const beforeRow = previewResult.before[i];
    const path = asStr(afterRow.path);

    if (afterRow.content !== undefined && afterRow.content !== beforeRow?.content) {
      intents.push({
        type: 'replaceNoteBody',
        path,
        content: processEscapeSequences(asStr(afterRow.content))
      });
    }

    for (const [key, afterValue] of Object.entries(afterRow)) {
      if (notesCoreColumns.includes(key)) {
        continue;
      }

      const beforeValue = beforeRow?.[key];
      if (afterValue === beforeValue) {
        continue;
      }

      if (afterValue === null || afterValue === undefined) {
        intents.push({ type: 'deleteProperty', path, key });
      }
      else {
        intents.push({
          type: 'setProperty',
          path,
          key,
          value: formatUnknownValue(afterValue),
          valueType: null
        });
      }
    }
  }

  return intents;
}

async function createTagIntents(previewResult: PreviewResult, queryDatabase: QueryDatabase, readFileContent: ReadFileContent): Promise<ObsidianEditIntent[]> {
  if (previewResult.op === 'insert') {
    return await createTagInsertIntents(previewResult, queryDatabase, readFileContent);
  }

  if (previewResult.op === 'update') {
    return await createTagUpdateIntents(previewResult, readFileContent);
  }

  if (previewResult.op === 'delete') {
    return await createTagDeleteIntents(previewResult, readFileContent);
  }

  return [];
}

// Insert builders pass allowEmptyBaseline: an empty file is a legitimate insert
// target, so they skip (with a warning) only files that cannot be read at all,
// while update/delete builders also skip empty files.
async function createContentPatchIntents<T>(entriesByPath: Map<string, T[]>, readFileContent: ReadFileContent,
  mutateContent: (content: string, entries: T[]) => string, allowEmptyBaseline?: { warnName: string }): Promise<ObsidianEditIntent[]> {
  const intents: ObsidianEditIntent[] = [];

  for (const [path, entries] of entriesByPath) {
    const baselineContent = await readFileContent(path);
    if (baselineContent === null) {
      if (allowEmptyBaseline) {
        logger.warn(`${allowEmptyBaseline.warnName}: skipping unreadable file`, path);
      }
      continue;
    }
    if (!allowEmptyBaseline && !baselineContent) {
      continue;
    }

    const content = mutateContent(baselineContent, entries);
    intents.push({ type: 'replaceNoteContent', path, content, baselineContent, mode: 'patch' });
  }

  return intents;
}

async function createTagUpdateIntents(previewResult: PreviewResult, readFileContent: ReadFileContent): Promise<ObsidianEditIntent[]> {
  const tagChangesByPath = new Map<string, Array<{ oldTag: string; newTag: string }>>();

  for (let i = 0; i < previewResult.before.length; i++) {
    const before = previewResult.before[i];
    const after = previewResult.after[i];
    if (before && after && before.tag_name !== after.tag_name) {
      const path = asStr(after.path);
      const changes = tagChangesByPath.get(path) || [];
      changes.push({ oldTag: asStr(before.tag_name), newTag: asStr(after.tag_name) });
      tagChangesByPath.set(path, changes);
    }
  }

  return await createContentPatchIntents(tagChangesByPath, readFileContent, (content, changes) => {
    for (const change of changes) {
      const regex = new RegExp(escapeRegex(change.oldTag) + '(?=\\s|$|[^\\w-])', 'g');
      content = content.replace(regex, change.newTag);
    }
    return content;
  });
}

async function createTagDeleteIntents(previewResult: PreviewResult, readFileContent: ReadFileContent): Promise<ObsidianEditIntent[]> {
  const tagDeletesByPath = new Map<string, string[]>();

  for (const row of previewResult.before) {
    const path = asStr(row.path);
    const tags = tagDeletesByPath.get(path) || [];
    tags.push(asStr(row.tag_name));
    tagDeletesByPath.set(path, tags);
  }

  return await createContentPatchIntents(tagDeletesByPath, readFileContent, (content, tagsToDelete) => {
    for (const tag of tagsToDelete) {
      const regex = new RegExp(escapeRegex(tag) + '(\\s?)(?=\\s|$|[^\\w-])', 'g');
      content = content.replace(regex, '');
    }
    return content;
  });
}

async function createTagInsertIntents(previewResult: PreviewResult, queryDatabase: QueryDatabase, readFileContent: ReadFileContent): Promise<ObsidianEditIntent[]> {
  const inlineTagsByPath = new Map<string, Array<{ tagName: string; lineNumber: number; insertPosition: string }>>();
  const frontmatterTagsByPath = new Map<string, string[]>();

  for (const row of previewResult.after) {
    const path = asStr(row.path);
    let tagName = asStr(row.tag_name);
    if (!tagName.startsWith('#')) {
      tagName = '#' + tagName;
    }
    const lineNumber = asNum(row.line_number, null);
    const insertPosition = asStr(row.insert_position, 'new_line');

    if (lineNumber !== null) {
      const tags = inlineTagsByPath.get(path) || [];
      tags.push({ tagName, lineNumber, insertPosition });
      inlineTagsByPath.set(path, tags);
    }
    else {
      const tags = frontmatterTagsByPath.get(path) || [];
      tags.push(tagName.slice(1));
      frontmatterTagsByPath.set(path, tags);
    }
  }

  const intents = await createContentPatchIntents(inlineTagsByPath, readFileContent, (content, newTags) =>
    insertLineItems(content, newTags.map(tag => ({
      value: tag.tagName,
      lineNumber: tag.lineNumber,
      insertPosition: tag.insertPosition
    }))), { warnName: 'createTagInsertIntents' });

  for (const [path, newTags] of frontmatterTagsByPath) {
    const existingTagsResult = await queryDatabase<{ tag_name: string }>('SELECT DISTINCT tag_name FROM tags WHERE path = ?', [path]);
    const existingTags = existingTagsResult.map(r => r.tag_name.startsWith('#') ? r.tag_name.slice(1) : r.tag_name);
    const allTags = [...new Set([...existingTags, ...newTags])];
    intents.push({
      type: 'setProperty',
      path,
      key: 'tags',
      value: JSON.stringify(allTags),
      valueType: 'tags'
    });
  }

  return intents;
}

async function createLinkIntents(previewResult: PreviewResult, readFileContent: ReadFileContent): Promise<ObsidianEditIntent[]> {
  // Frontmatter link rows describe YAML property values, not body markup; the
  // markdown rewrite below would edit the wrong part of the file for them.
  const touchesFrontmatterLink = [...previewResult.before, ...previewResult.after]
    .some(row => row && row.frontmatter_key != null);
  if (touchesFrontmatterLink) {
    throw new Error('Frontmatter links are read-only through the links table. Update the property via the properties table instead.');
  }

  if (previewResult.op === 'insert') {
    return await createLinkInsertIntents(previewResult, readFileContent);
  }

  if (previewResult.op === 'update') {
    return await createLinkUpdateIntents(previewResult, readFileContent);
  }

  if (previewResult.op === 'delete') {
    return await createLinkDeleteIntents(previewResult, readFileContent);
  }

  return [];
}

async function createLinkUpdateIntents(previewResult: PreviewResult, readFileContent: ReadFileContent): Promise<ObsidianEditIntent[]> {
  const linkChangesByPath = new Map<string, Array<{ oldTarget: string; oldText: string; newTarget: string; newText: string }>>();

  for (let i = 0; i < previewResult.before.length; i++) {
    const before = previewResult.before[i];
    const after = previewResult.after[i];
    if (!before || !after) {
      continue;
    }

    if (before.link_target !== after.link_target || before.link_text !== after.link_text) {
      const path = asStr(after.path);
      const changes = linkChangesByPath.get(path) || [];
      changes.push({
        oldTarget: asStr(before.link_target),
        oldText: asStr(before.link_text),
        newTarget: asStr(after.link_target),
        newText: asStr(after.link_text)
      });
      linkChangesByPath.set(path, changes);
    }
  }

  return await createContentPatchIntents(linkChangesByPath, readFileContent, (content, changes) => {
    for (const change of changes) {
      content = content.replace(formatWikiLink(change.oldTarget, change.oldText), formatWikiLink(change.newTarget, change.newText));
    }
    return content;
  });
}

async function createLinkDeleteIntents(previewResult: PreviewResult, readFileContent: ReadFileContent): Promise<ObsidianEditIntent[]> {
  const linkDeletesByPath = new Map<string, Array<{ target: string; text: string }>>();

  for (const row of previewResult.before) {
    const path = asStr(row.path);
    const links = linkDeletesByPath.get(path) || [];
    links.push({ target: asStr(row.link_target), text: asStr(row.link_text) });
    linkDeletesByPath.set(path, links);
  }

  return await createContentPatchIntents(linkDeletesByPath, readFileContent, (content, linksToDelete) => {
    for (const link of linksToDelete) {
      const linkWithText = formatWikiLink(link.target, link.text);
      const linkSimple = formatWikiLink(link.target, '');
      content = content.includes(linkWithText)
        ? content.replace(linkWithText, '')
        : content.replace(linkSimple, '');
    }
    return content;
  });
}

async function createLinkInsertIntents(previewResult: PreviewResult, readFileContent: ReadFileContent): Promise<ObsidianEditIntent[]> {
  const linksByPath = new Map<string, Array<{ value: string; lineNumber: number | null; insertPosition: string }>>();

  for (const row of previewResult.after) {
    const path = asStr(row.path);
    const links = linksByPath.get(path) || [];
    links.push({
      value: formatWikiLink(asStr(row.link_target), asStr(row.link_text)),
      lineNumber: asNum(row.line_number, null),
      insertPosition: asStr(row.insert_position, 'new_line')
    });
    linksByPath.set(path, links);
  }

  return await createContentPatchIntents(linksByPath, readFileContent,
    (content, links) => insertLineItems(content, links), { warnName: 'createLinkInsertIntents' });
}

function formatWikiLink(target: string, text: string): string {
  return text && text !== target ? `[[${target}|${text}]]` : `[[${target}]]`;
}

function insertLineItems(content: string, items: Array<{ value: string; lineNumber: number | null; insertPosition: string }>): string {
  const lines = content.split('\n');
  const itemsWithPosition = items.filter(item => item.lineNumber !== null);
  const itemsToAppend = items.filter(item => item.lineNumber === null);

  itemsWithPosition.sort((a, b) => (b.lineNumber as number) - (a.lineNumber as number));
  for (const item of itemsWithPosition) {
    const lineIdx = (item.lineNumber as number) - 1;

    if (lineIdx >= 0 && lineIdx < lines.length) {
      switch (item.insertPosition) {
        case 'line_start':
          lines[lineIdx] = item.value + ' ' + lines[lineIdx];
          break;
        case 'line_end':
          lines[lineIdx] = lines[lineIdx] + ' ' + item.value;
          break;
        case 'new_line':
        default:
          lines.splice(lineIdx, 0, item.value);
          break;
      }
    }
    else if (lineIdx >= lines.length) {
      while (lines.length < lineIdx) {
        lines.push('');
      }
      lines.push(item.value);
    }
  }

  if (itemsToAppend.length > 0) {
    const values = itemsToAppend.map(item => item.value).join(' ');
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push(values);
    }
    else {
      lines[lines.length - 1] = values;
    }
  }

  const nextContent = lines.join('\n');
  return nextContent.endsWith('\n') ? nextContent : nextContent + '\n';
}

async function createTableRewriteIntents(previewResult: PreviewResult, queryDatabase: QueryDatabase): Promise<ObsidianEditIntent[] | null> {
  if (previewResult.table === 'table_rows') {
    if (previewResult.op !== 'insert') {
      return null;
    }

    return createTableRewriteIntentsFromCells(await buildCellsForTableRowsInsert(previewResult, queryDatabase));
  }

  return createTableRewriteIntentsFromCells(await buildCellsForTableCellsOperation(previewResult, queryDatabase));
}

async function buildCellsForTableRowsInsert(previewResult: PreviewResult, queryDatabase: QueryDatabase): Promise<TableCellRow[]> {
  const allCells: TableCellRow[] = [];
  const affectedTables = new Set<string>();
  const newCellsByTable = new Map<string, TableCellRow[]>();

  await appendCellsFromTableRows(
    previewResult.after,
    affectedTables,
    newCellsByTable,
    async (path, tableIndex) => {
      return await queryMaxTableRow(queryDatabase, path, tableIndex);
    },
    'ObsidianEditIntentFactory'
  );

  for (const tableKey of affectedTables) {
    const { path, tableIndex } = parseTableKey(tableKey);
    const existingCellRows = await queryExistingTableCells(path, tableIndex, queryDatabase);
    const newCells = newCellsByTable.get(tableKey) || [];
    const explicitRowIndices = newCells.map(c => c.row_index).filter(idx => idx !== undefined && idx !== null);
    const insertAtIndex = explicitRowIndices.length > 0 ? Math.min(...explicitRowIndices) : null;

    for (const cell of existingCellRows) {
      if (insertAtIndex !== null && cell.row_index >= insertAtIndex) {
        cell.row_index = cell.row_index + 1;
      }
      allCells.push(cell);
    }

    allCells.push(...newCells);
  }

  return allCells;
}

async function buildCellsForTableCellsOperation(previewResult: PreviewResult, queryDatabase: QueryDatabase): Promise<TableCellRow[]> {
  const changedCells = previewResult.after.map(toTableCellRow);
  const affectedTables = new Set<string>();

  const rowsForAffectedTables = previewResult.op === 'delete' ? previewResult.before : previewResult.after;
  for (const row of rowsForAffectedTables) {
    const cell = toTableCellRow(row);
    affectedTables.add(createTableKey(cell.path, cell.table_index));
  }

  const allCells: TableCellRow[] = [];
  for (const tableKey of affectedTables) {
    const { path, tableIndex } = parseTableKey(tableKey);
    const existingCellRows = await queryExistingTableCells(path, tableIndex, queryDatabase);

    if (previewResult.op === 'update') {
      const changedCellMap = new Map<string, TableCellRow>();
      for (const cell of changedCells) {
        if (cell.path === path && cell.table_index === tableIndex) {
          changedCellMap.set(createRowColumnKey(cell.row_index, cell.column_name), cell);
        }
      }

      allCells.push(...mergeExistingCells(existingCellRows, changedCellMap, new Set<string>()));
      continue;
    }

    if (previewResult.op === 'insert') {
      allCells.push(...existingCellRows);
      allCells.push(...changedCells.filter(cell => cell.path === path && cell.table_index === tableIndex));
      continue;
    }

    if (previewResult.op === 'delete') {
      const deletedCellKeys = new Set<string>();
      for (const row of previewResult.before) {
        const cell = toTableCellRow(row);
        if (cell.path === path && cell.table_index === tableIndex) {
          deletedCellKeys.add(createRowColumnKey(cell.row_index, cell.column_name));
        }
      }

      allCells.push(...mergeExistingCells(existingCellRows, new Map<string, TableCellRow>(), deletedCellKeys));
    }
  }

  return allCells;
}

async function queryExistingTableCells(path: string, tableIndex: number, queryDatabase: QueryDatabase): Promise<TableCellRow[]> {
  const rows = await queryDatabase<Record<string, unknown>>('SELECT * FROM table_cells WHERE path = ? AND table_index = ? ORDER BY row_index, column_name', [path, tableIndex]);
  return rows.map(toTableCellRow);
}

async function queryMaxTableRow(queryDatabase: QueryDatabase, path: string, tableIndex: number): Promise<number> {
  const rows = await queryDatabase<{ max_row: number }>('SELECT COALESCE(MAX(row_index), -1) as max_row FROM table_cells WHERE path = ? AND table_index = ?', [path, tableIndex]);
  return rows[0].max_row + 1;
}

function createTableRewriteIntentsFromCells(cells: TableCellRow[]): ObsidianEditIntent[] {
  const byTable = new Map<string, TableCellRow[]>();
  for (const cell of cells) {
    const key = createTableKey(cell.path, cell.table_index);
    const tableCells = byTable.get(key) || [];
    tableCells.push(cell);
    byTable.set(key, tableCells);
  }

  return Array.from(byTable.values()).map(tableCells => ({
    type: 'rewriteTable',
    path: tableCells[0].path,
    tableCells
  }));
}

export function createTaskIntents(previewResult: PreviewResult): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    return previewResult.before.map(row => {
      const task = toTaskRow(row);
      return {
        type: 'deleteTask',
        location: entityLocation(task),
        task
      };
    });
  }

  const isNewTasks = previewResult.before.length === 0 ||
    previewResult.after.every(afterRow =>
      !previewResult.before.some(beforeRow => beforeRow.id === afterRow.id)
    );

  return previewResult.after.map(row => {
    const task = toTaskRow(row);
    const beforeRow = previewResult.before.find(before => before.id === row.id);
    const hasMatchingBefore = !!beforeRow;

    if (hasMatchingBefore) {
      copyMissingLocationFields(task, beforeRow);
    }

    if (isNewTasks || !hasMatchingBefore) {
      if (task.line_number == null) {
        task.line_number = -1;
      }

      return {
        type: 'insertTask',
        path: task.path,
        lineNumber: task.line_number,
        task
      };
    }

    return {
      type: 'replaceTask',
      location: entityLocation(task),
      task
    };
  });
}

export function createHeadingIntents(previewResult: PreviewResult): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    return previewResult.before.map(row => {
      const heading = toHeadingRow(row);
      return {
        type: 'deleteHeading',
        location: entityLocation(heading),
        heading
      };
    });
  }

  return previewResult.after.map(row => {
    const heading = toHeadingRow(row);

    if (previewResult.op === 'insert' && heading.line_number == null) {
      heading.line_number = -1;
    }

    if (heading.line_number === -1) {
      return {
        type: 'insertHeading',
        path: heading.path,
        lineNumber: heading.line_number,
        heading
      };
    }

    return {
      type: 'replaceHeading',
      location: entityLocation(heading),
      heading
    };
  });
}

export function createListItemIntents(previewResult: PreviewResult): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    return previewResult.before.map(row => {
      const listItem = toListItemRow(row);
      return {
        type: 'deleteListItem',
        location: entityLocation(listItem),
        listItem
      };
    });
  }

  if (previewResult.op === 'insert') {
    return previewResult.after.map((row, index) => {
      const listItem = toListItemRow(row);
      if (listItem.list_index == null) {
        listItem.list_index = 0;
      }
      if (listItem.item_index == null) {
        listItem.item_index = index;
      }
      if (listItem.line_number == null) {
        listItem.line_number = -1;
      }

      return {
        type: 'insertListItem',
        path: listItem.path,
        lineNumber: listItem.line_number,
        listItem
      };
    });
  }

  return previewResult.after.map(row => {
    const listItem = toListItemRow(row);
    const beforeRow = previewResult.before.find(before => before.id === row.id);
    if (beforeRow) {
      copyMissingLocationFields(listItem, beforeRow);
    }

    return {
      type: 'replaceListItem',
      location: entityLocation(listItem),
      listItem
    };
  });
}

function toPropertyRow(row: Record<string, unknown>): PropertyRow {
  const valueType = asStr(row.value_type, null) ?? asStr(row.type, null);
  return {
    path: asStr(row.path),
    key: asStr(row.key),
    value: asStr(row.value, null),
    type: valueType
  };
}

function createSetPropertyIntent(property: PropertyRow): ObsidianEditIntent {
  return {
    type: 'setProperty',
    path: property.path,
    key: property.key,
    value: property.value,
    valueType: property.type
  };
}

function readRequiredPath(row: Record<string, unknown>, converterName: string): string {
  const path = asStr(row.path);
  if (!path) {
    logger.warn(`ObsidianEditIntentFactory.${converterName}: missing required field "path"`, row);
  }
  return path;
}

function toTaskRow(row: Record<string, unknown>): TaskRow {
  const path = readRequiredPath(row, 'toTaskRow');

  return {
    id: asNum(row.id, -1),
    path,
    task_text: asStr(row.task_text),
    completed: row.completed === 1 ? 1 : 0,
    status: asStr(row.status, null),
    priority: asStr(row.priority, null),
    due_date: asStr(row.due_date, null),
    scheduled_date: asStr(row.scheduled_date, null),
    start_date: asStr(row.start_date, null),
    created_date: asStr(row.created_date, null),
    done_date: asStr(row.done_date, null),
    cancelled_date: asStr(row.cancelled_date, null),
    recurrence: asStr(row.recurrence, null),
    on_completion: asStr(row.on_completion, null),
    task_id: asStr(row.task_id, null),
    depends_on: asStr(row.depends_on, null),
    tags: asStr(row.tags, null),
    ...readLocationFields(row),
    section_heading: asStr(row.section_heading, null)
  };
}

function copyMissingLocationFields(row: {
  start_offset?: number | null;
  end_offset?: number | null;
  anchor_hash?: string | null;
  block_id?: string | null;
}, beforeRow: Record<string, unknown>): void {
  if (row.start_offset == null && beforeRow.start_offset != null) {
    row.start_offset = beforeRow.start_offset as number;
  }
  if (row.end_offset == null && beforeRow.end_offset != null) {
    row.end_offset = beforeRow.end_offset as number;
  }
  if (row.anchor_hash == null && beforeRow.anchor_hash != null) {
    row.anchor_hash = beforeRow.anchor_hash as string;
  }
  if (row.block_id == null && beforeRow.block_id != null) {
    row.block_id = beforeRow.block_id as string;
  }
}

function entityLocation(row: {
  path: string;
  block_id?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  line_number?: number | null;
}): ObsidianEntityLocation {
  return {
    path: row.path,
    blockId: row.block_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    lineNumber: row.line_number
  };
}

function toHeadingRow(row: Record<string, unknown>): HeadingRow {
  const path = readRequiredPath(row, 'toHeadingRow');

  return {
    path,
    level: asNum(row.level, 1),
    heading_text: asStr(row.heading_text),
    ...readLocationFields(row)
  };
}

function toListItemRow(row: Record<string, unknown>): ListItemRow {
  const path = readRequiredPath(row, 'toListItemRow');

  return {
    id: asNum(row.id, -1),
    path,
    list_index: asNum(row.list_index, 0),
    item_index: asNum(row.item_index, 0),
    parent_index: asNum(row.parent_index, null),
    content: asStr(row.content),
    list_type: (row.list_type as 'bullet' | 'number') || 'bullet',
    indent_level: asNum(row.indent_level, 0),
    ...readLocationFields(row)
  };
}

function toTableCellRow(row: Record<string, unknown>): TableCellRow {
  const path = readRequiredPath(row, 'toTableCellRow');

  return {
    path,
    table_index: asNum(row.table_index, 0),
    row_index: asNum(row.row_index, 0),
    column_name: asStr(row.column_name),
    cell_value: asStr(row.cell_value),
    start_offset: asNum(row.start_offset, null),
    end_offset: asNum(row.end_offset, null),
    line_number: asNum(row.line_number, null)
  };
}
