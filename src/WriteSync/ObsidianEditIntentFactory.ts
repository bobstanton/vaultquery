import { stringifyYaml } from 'obsidian';
import { createRowColumnKey, createTableKey, escapeRegex, parseTableKey, processEscapeSequences } from '../utils/StringUtils';
import { logger as rootLogger } from '../utils/logger';
import { asNum, asStr, readLocationFields } from './types';
import { appendCellsFromTableRows } from './TableUtils';
import { formatUnknownValue } from '../utils/ResultFormatUtils';
import { ContentLocationService } from '../Services/ContentLocationService';
import { INSERT_NEW_LINE } from '../EditPlanner';

import type { PreviewResult } from '../Services/PreviewService';
import type { ObsidianEditIntent, ObsidianEntityLocation } from './ObsidianEditIntent';
import type { HeadingRow, ListItemRow, Range, TableCellRow, TaskRow } from '../Services/ContentLocationService';

const logger = rootLogger.scope('WriteSync');

type QueryDescendants = (rows: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
type QueryDatabase = <T>(sql: string, params?: (string | number | null)[]) => Promise<T[]>;
type ReadFileContent = (path: string) => Promise<string | null>;
type TableCellMapByTable = Map<string, Map<string, TableCellRow>>;
type TableCellKeySetByTable = Map<string, Set<string>>;
type NewRowsByTable = Map<string, TableCellRow[]>;
type Row = Record<string, unknown>;

export interface IntentCreationResult {
  intents: ObsidianEditIntent[];
  warnings: string[];
}

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

const NOTES_CORE_COLUMNS = ['path', 'title', 'content', 'created', 'modified', 'size'];

function createPropertyIntents(previewResult: PreviewResult): ObsidianEditIntent[] {
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

function createNoteIntents(previewResult: PreviewResult, allowDeleteNotes: boolean): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    if (!allowDeleteNotes) {
      throw new Error('DELETE FROM notes is disabled. Enable "Allow file deletion" in VaultQuery settings to delete files.');
    }

    return previewResult.before.map(row => ({
      type: 'deleteNote',
      path: asStr(row.path)
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
        path: asStr(row.path),
        content: processEscapeSequences(asStr(row.content))
      }));
  }

  if (previewResult.op === 'insert') {
    const isFromPropertiesView = previewResult.table === 'notes_with_properties';

    return previewResult.after.map(row => {
      const path = asStr(row.path);
      let content = processEscapeSequences(asStr(row.content));

      const title = asStr(row.title, null);
      if (!content && title) {
        content = `# ${title}\n\n`;
      }

      if (isFromPropertiesView) {
        const properties: Record<string, string> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!NOTES_CORE_COLUMNS.includes(key) && value !== null && value !== undefined) {
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

function canDirectlyApplyPreviewResult(previewResult: PreviewResult): boolean {
  if (previewResult.op === 'multi') {
    return previewResult.multiResults?.every(canDirectlyApplyPreviewResult) ?? false;
  }

  return DIRECT_TABLES.has(previewResult.table);
}

export async function createDirectlyApplicableIntents(previewResult: PreviewResult, allowDeleteNotes: boolean, queryListItemDescendants?: QueryDescendants,
  queryDatabase?: QueryDatabase, readFileContent?: ReadFileContent): Promise<IntentCreationResult | null> {
  if (!canDirectlyApplyPreviewResult(previewResult)) {
    return null;
  }

  const warnings: string[] = [];
  const intents = await createIntentsForResult(previewResult, allowDeleteNotes, queryListItemDescendants, queryDatabase, readFileContent, warnings);
  if (!intents) {
    return null;
  }

  return { intents, warnings };
}

async function createIntentsForResult(previewResult: PreviewResult, allowDeleteNotes: boolean, queryListItemDescendants: QueryDescendants | undefined,
  queryDatabase: QueryDatabase | undefined, readFileContent: ReadFileContent | undefined, warnings: string[]): Promise<ObsidianEditIntent[] | null> {
  if (previewResult.op === 'multi') {
    if (!queryDatabase) {
      throw new Error('Multi-statement writes require database lookup.');
    }
    return await createMultiStatementIntents(previewResult, allowDeleteNotes, queryListItemDescendants, queryDatabase, readFileContent, warnings);
  }

  if (previewResult.table === 'notes' || previewResult.table === 'notes_with_properties') {
    if (previewResult.table === 'notes_with_properties' && previewResult.op === 'update') {
      return createNotesWithPropertiesUpdateIntents(previewResult);
    }
    return createNoteIntents(previewResult, allowDeleteNotes);
  }

  if (previewResult.table === 'tasks' || previewResult.table === 'tasks_view') {
    return createTaskIntents(previewResult, warnings);
  }

  if (previewResult.table === 'headings' || previewResult.table === 'headings_view') {
    return createHeadingIntents(previewResult, warnings);
  }

  if (previewResult.table === 'list_items' || previewResult.table === 'list_items_view') {
    if (previewResult.table === 'list_items_view' && previewResult.op === 'delete') {
      if (!queryListItemDescendants) {
        throw new Error('DELETE FROM list_items_view requires descendant lookup.');
      }

      const rowsToDelete = await queryListItemDescendants(previewResult.before);
      return createListItemIntents({ ...previewResult, before: rowsToDelete }, warnings);
    }

    return createListItemIntents(previewResult, warnings);
  }

  if (previewResult.table === 'table_cells' || previewResult.table === 'table_rows') {
    if (!queryDatabase) {
      throw new Error(`${previewResult.table} writes require table cell lookup.`);
    }
    return await createTableRewriteIntents(previewResult, queryDatabase, warnings);
  }

  if (previewResult.table === 'tags') {
    if (!queryDatabase || !readFileContent) {
      throw new Error('tags writes require note content and tag lookup.');
    }
    return await createTagIntents(previewResult, queryDatabase, readFileContent, warnings);
  }

  if (previewResult.table === 'links') {
    if (!readFileContent) {
      throw new Error('links writes require note content lookup.');
    }
    return await createLinkIntents(previewResult, readFileContent, warnings);
  }

  return createPropertyIntents(previewResult);
}

async function createMultiStatementIntents(previewResult: PreviewResult, allowDeleteNotes: boolean, queryListItemDescendants: QueryDescendants | undefined,
  queryDatabase: QueryDatabase, readFileContent: ReadFileContent | undefined, warnings: string[]): Promise<ObsidianEditIntent[] | null> {
  const intents: ObsidianEditIntent[] = [];
  const changedCellsByTable: TableCellMapByTable = new Map();
  const deletedCellsByTable: TableCellKeySetByTable = new Map();
  const affectedTables = new Set<string>();
  const newRowsByTable: NewRowsByTable = new Map();

  for (const result of previewResult.multiResults ?? []) {
    if (result.table === 'table_cells') {
      collectTableCellStatement(result, changedCellsByTable, deletedCellsByTable, affectedTables, warnings);
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

    const resultIntents = await createIntentsForResult(result, allowDeleteNotes, queryListItemDescendants, queryDatabase, readFileContent, warnings);
    if (!resultIntents) {
      return null;
    }
    intents.push(...resultIntents);
  }

  const tableCells = await buildMultiStatementTableCells(affectedTables, changedCellsByTable, deletedCellsByTable, newRowsByTable, queryDatabase, warnings);
  intents.push(...createTableRewriteIntentsFromCells(tableCells));
  return intents;
}

function collectTableCellStatement(previewResult: PreviewResult, changedCellsByTable: TableCellMapByTable,
  deletedCellsByTable: TableCellKeySetByTable, affectedTables: Set<string>, warnings: string[]): void {
  if (previewResult.op === 'delete') {
    for (const cell of convertRows(previewResult.before, row => toTableCellRow(row, warnings))) {
      const tableKey = createTableKey(cell.path, cell.table_index);
      const cellKey = createRowColumnKey(cell.row_index, cell.column_name);
      const deletedCells = deletedCellsByTable.get(tableKey) || new Set<string>();
      deletedCells.add(cellKey);
      deletedCellsByTable.set(tableKey, deletedCells);
      affectedTables.add(tableKey);
    }
    return;
  }

  for (const cell of convertRows(previewResult.after, row => toTableCellRow(row, warnings))) {
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
  deletedCellsByTable: TableCellKeySetByTable, newRowsByTable: NewRowsByTable, queryDatabase: QueryDatabase, warnings: string[]): Promise<TableCellRow[]> {
  const allTableCells: TableCellRow[] = [];

  for (const tableKey of affectedTables) {
    const { path, tableIndex } = parseTableKey(tableKey);
    const changedCells = changedCellsByTable.get(tableKey) || new Map<string, TableCellRow>();
    const deletedCells = deletedCellsByTable.get(tableKey) || new Set<string>();
    const existingCellRows = await queryExistingTableCells(path, tableIndex, queryDatabase, warnings);

    allTableCells.push(...mergeExistingCells(existingCellRows, changedCells, deletedCells));

    const newRows = newRowsByTable.get(tableKey);
    if (newRows) {
      allTableCells.push(...newRows);
    }
  }

  return allTableCells;
}

function createNotesWithPropertiesUpdateIntents(previewResult: PreviewResult): ObsidianEditIntent[] {
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
      if (NOTES_CORE_COLUMNS.includes(key)) {
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

async function createTagIntents(previewResult: PreviewResult, queryDatabase: QueryDatabase, readFileContent: ReadFileContent, warnings: string[]): Promise<ObsidianEditIntent[]> {
  if (previewResult.op === 'insert') {
    return await createTagInsertIntents(previewResult, queryDatabase, readFileContent, warnings);
  }

  if (previewResult.op === 'update') {
    return await createTagUpdateIntents(previewResult, readFileContent, warnings);
  }

  if (previewResult.op === 'delete') {
    return await createTagDeleteIntents(previewResult, readFileContent, warnings);
  }

  return [];
}

// Insert builders pass allowEmptyBaseline: an empty file is a legitimate
// insert target, while update/delete builders also skip empty files (nothing
// can be located in them). Files that cannot be read at all are always
// skipped, with a user-visible warning. Intents are only produced when the
// mutation actually changed something.
async function createContentPatchIntents<T>(entriesByPath: Map<string, T[]>, readFileContent: ReadFileContent,
  mutateContent: (content: string, entries: T[], warn: (message: string) => void) => string,
  warnings: string[], allowEmptyBaseline?: boolean): Promise<ObsidianEditIntent[]> {
  const intents: ObsidianEditIntent[] = [];

  for (const [path, entries] of entriesByPath) {
    const warn = (message: string): void => {
      warnings.push(`${path}: ${message}`);
    };

    const baselineContent = await readFileContent(path);
    if (baselineContent === null) {
      warn(`skipped ${entries.length} change(s): file could not be read`);
      continue;
    }
    if (!allowEmptyBaseline && !baselineContent) {
      warn(`skipped ${entries.length} change(s): file is empty`);
      continue;
    }

    const content = mutateContent(baselineContent, entries, warn);
    if (content === baselineContent) {
      continue;
    }
    intents.push({ type: 'replaceNoteContent', path, content, baselineContent });
  }

  return intents;
}

const TAG_BOUNDARY = '(?=\\s|$|[^\\w-])';

function replaceTagOnLine(content: string, pattern: RegExp, lineNumber: number | null, replacement: string): string | null {
  if (lineNumber == null || lineNumber < 1) {
    return null;
  }

  const lines = content.split('\n');
  if (lineNumber > lines.length) {
    return null;
  }

  const line = lines[lineNumber - 1];
  if (!pattern.test(line)) {
    return null;
  }

  lines[lineNumber - 1] = line.replace(pattern, replacement);
  return lines.join('\n');
}

async function createTagUpdateIntents(previewResult: PreviewResult, readFileContent: ReadFileContent, warnings: string[]): Promise<ObsidianEditIntent[]> {
  const tagChangesByPath = new Map<string, Array<{ oldTag: string; newTag: string; lineNumber: number | null }>>();

  for (let i = 0; i < previewResult.before.length; i++) {
    const before = previewResult.before[i];
    const after = previewResult.after[i];
    if (before && after && before.tag_name !== after.tag_name) {
      const path = asStr(after.path);
      const changes = tagChangesByPath.get(path) || [];
      changes.push({
        oldTag: asStr(before.tag_name),
        newTag: asStr(after.tag_name),
        lineNumber: asNum(before.line_number, null)
      });
      tagChangesByPath.set(path, changes);
    }
  }

  return await createContentPatchIntents(tagChangesByPath, readFileContent, (content, changes, warn) => {
    for (const change of changes) {
      const pattern = new RegExp(escapeRegex(change.oldTag) + TAG_BOUNDARY);
      const next = replaceTagOnLine(content, pattern, change.lineNumber, change.newTag);
      if (next === null) {
        warn(`could not find tag ${change.oldTag} on line ${change.lineNumber ?? '?'}; change skipped`);
        continue;
      }
      content = next;
    }
    return content;
  }, warnings);
}

async function createTagDeleteIntents(previewResult: PreviewResult, readFileContent: ReadFileContent, warnings: string[]): Promise<ObsidianEditIntent[]> {
  const tagDeletesByPath = new Map<string, Array<{ tag: string; lineNumber: number | null }>>();

  for (const row of previewResult.before) {
    const path = asStr(row.path);
    const tags = tagDeletesByPath.get(path) || [];
    tags.push({ tag: asStr(row.tag_name), lineNumber: asNum(row.line_number, null) });
    tagDeletesByPath.set(path, tags);
  }

  return await createContentPatchIntents(tagDeletesByPath, readFileContent, (content, tagsToDelete, warn) => {
    for (const entry of tagsToDelete) {
      const pattern = new RegExp(escapeRegex(entry.tag) + '(\\s?)' + TAG_BOUNDARY);
      const next = replaceTagOnLine(content, pattern, entry.lineNumber, '');
      if (next === null) {
        warn(`could not find tag ${entry.tag} on line ${entry.lineNumber ?? '?'}; delete skipped`);
        continue;
      }
      content = next;
    }
    return content;
  }, warnings);
}

async function createTagInsertIntents(previewResult: PreviewResult, queryDatabase: QueryDatabase, readFileContent: ReadFileContent, warnings: string[]): Promise<ObsidianEditIntent[]> {
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
    }))), warnings, true);

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

async function createLinkIntents(previewResult: PreviewResult, readFileContent: ReadFileContent, warnings: string[]): Promise<ObsidianEditIntent[]> {
  // Frontmatter link rows describe YAML property values, not body markup; the
  // markdown rewrite below would edit the wrong part of the file for them.
  const touchesFrontmatterLink = [...previewResult.before, ...previewResult.after]
    .some(row => row && row.frontmatter_key != null);
  if (touchesFrontmatterLink) {
    throw new Error('Frontmatter links are read-only through the links table. Update the property via the properties table instead.');
  }

  if (previewResult.op === 'insert') {
    return await createLinkInsertIntents(previewResult, readFileContent, warnings);
  }

  if (previewResult.op === 'update') {
    return await createLinkUpdateIntents(previewResult, readFileContent, warnings);
  }

  if (previewResult.op === 'delete') {
    return await createLinkDeleteIntents(previewResult, readFileContent, warnings);
  }

  return [];
}

interface LinkRowFields {
  target: string;
  text: string;
  original: string | null;
  lineNumber: number | null;
  startOffset: number | null;
  endOffset: number | null;
}

function readLinkRowFields(row: Row): LinkRowFields {
  return {
    target: asStr(row.link_target),
    text: asStr(row.link_text),
    original: asStr(row.original, null),
    lineNumber: asNum(row.line_number, null),
    startOffset: asNum(row.start_offset, null),
    endOffset: asNum(row.end_offset, null)
  };
}

function linkCandidates(link: LinkRowFields): string[] {
  if (link.original) {
    return [link.original];
  }
  return [...new Set([formatWikiLink(link.target, link.text), formatWikiLink(link.target, '')])];
}

function locateLink(content: string, link: LinkRowFields): Range | null {
  const candidates = linkCandidates(link);

  if (link.startOffset != null && link.endOffset != null &&
      link.startOffset >= 0 && link.startOffset < link.endOffset && link.endOffset <= content.length) {
    const slice = content.slice(link.startOffset, link.endOffset);
    if (candidates.includes(slice)) {
      return { start: link.startOffset, end: link.endOffset };
    }
  }

  if (link.lineNumber != null && link.lineNumber >= 1) {
    const lineStart = ContentLocationService.getLineStartOffset(content, link.lineNumber - 1);
    const lineEnd = ContentLocationService.getLineEndOffset(content, link.lineNumber - 1);
    const line = content.slice(lineStart, lineEnd);
    for (const candidate of candidates) {
      const index = line.indexOf(candidate);
      if (index >= 0) {
        return { start: lineStart + index, end: lineStart + index + candidate.length };
      }
    }
  }

  for (const candidate of candidates) {
    const first = content.indexOf(candidate);
    if (first >= 0 && content.indexOf(candidate, first + candidate.length) < 0) {
      return { start: first, end: first + candidate.length };
    }
  }

  return null;
}

const MARKDOWN_LINK_PATTERN = /^\[[^\]]*\]\([^)]*\)$/;

function renderUpdatedLink(originalText: string | null, newTarget: string, newText: string): string {
  if (originalText && MARKDOWN_LINK_PATTERN.test(originalText)) {
    return `[${newText}](${newTarget})`;
  }
  return formatWikiLink(newTarget, newText);
}

function describeLink(link: LinkRowFields): string {
  return link.original ?? formatWikiLink(link.target, link.text);
}

function applyLinkReplacements(content: string, replacements: Array<{ link: LinkRowFields; replacement: string }>,
  warn: (message: string) => void): string {
  const located: Array<{ range: Range; replacement: string; link: LinkRowFields }> = [];
  for (const { link, replacement } of replacements) {
    const range = locateLink(content, link);
    if (!range) {
      warn(`could not locate link ${describeLink(link)}${link.lineNumber != null ? ` on line ${link.lineNumber}` : ''}; change skipped`);
      continue;
    }
    located.push({ range, replacement, link });
  }

  located.sort((a, b) => b.range.start - a.range.start);

  let result = content;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const { range, replacement, link } of located) {
    if (range.end > previousStart) {
      warn(`link ${describeLink(link)} overlaps another edit; change skipped`);
      continue;
    }
    result = result.slice(0, range.start) + replacement + result.slice(range.end);
    previousStart = range.start;
  }

  return result;
}

async function createLinkUpdateIntents(previewResult: PreviewResult, readFileContent: ReadFileContent, warnings: string[]): Promise<ObsidianEditIntent[]> {
  const linkChangesByPath = new Map<string, Array<{ link: LinkRowFields; replacement: string }>>();

  for (let i = 0; i < previewResult.before.length; i++) {
    const before = previewResult.before[i];
    const after = previewResult.after[i];
    if (!before || !after) {
      continue;
    }

    if (before.link_target !== after.link_target || before.link_text !== after.link_text) {
      const path = asStr(after.path);
      const link = readLinkRowFields(before);
      const changes = linkChangesByPath.get(path) || [];
      changes.push({
        link,
        replacement: renderUpdatedLink(link.original, asStr(after.link_target), asStr(after.link_text))
      });
      linkChangesByPath.set(path, changes);
    }
  }

  return await createContentPatchIntents(linkChangesByPath, readFileContent,
    (content, changes, warn) => applyLinkReplacements(content, changes, warn), warnings);
}

async function createLinkDeleteIntents(previewResult: PreviewResult, readFileContent: ReadFileContent, warnings: string[]): Promise<ObsidianEditIntent[]> {
  const linkDeletesByPath = new Map<string, Array<{ link: LinkRowFields; replacement: string }>>();

  for (const row of previewResult.before) {
    const path = asStr(row.path);
    const links = linkDeletesByPath.get(path) || [];
    links.push({ link: readLinkRowFields(row), replacement: '' });
    linkDeletesByPath.set(path, links);
  }

  return await createContentPatchIntents(linkDeletesByPath, readFileContent,
    (content, links, warn) => applyLinkReplacements(content, links, warn), warnings);
}

async function createLinkInsertIntents(previewResult: PreviewResult, readFileContent: ReadFileContent, warnings: string[]): Promise<ObsidianEditIntent[]> {
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
    (content, links) => insertLineItems(content, links), warnings, true);
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

async function createTableRewriteIntents(previewResult: PreviewResult, queryDatabase: QueryDatabase, warnings: string[]): Promise<ObsidianEditIntent[] | null> {
  if (previewResult.table === 'table_rows') {
    if (previewResult.op !== 'insert') {
      return null;
    }

    return createTableRewriteIntentsFromCells(await buildCellsForTableRowsInsert(previewResult, queryDatabase, warnings));
  }

  return createTableRewriteIntentsFromCells(await buildCellsForTableCellsOperation(previewResult, queryDatabase, warnings));
}

async function buildCellsForTableRowsInsert(previewResult: PreviewResult, queryDatabase: QueryDatabase, warnings: string[]): Promise<TableCellRow[]> {
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
    const existingCellRows = await queryExistingTableCells(path, tableIndex, queryDatabase, warnings);
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

async function buildCellsForTableCellsOperation(previewResult: PreviewResult, queryDatabase: QueryDatabase, warnings: string[]): Promise<TableCellRow[]> {
  const changedCells = convertRows(previewResult.after, row => toTableCellRow(row, warnings));
  const affectedTables = new Set<string>();

  const rowsForAffectedTables = previewResult.op === 'delete' ? previewResult.before : previewResult.after;
  for (const cell of convertRows(rowsForAffectedTables, row => toTableCellRow(row, warnings))) {
    affectedTables.add(createTableKey(cell.path, cell.table_index));
  }

  const allCells: TableCellRow[] = [];
  for (const tableKey of affectedTables) {
    const { path, tableIndex } = parseTableKey(tableKey);
    const existingCellRows = await queryExistingTableCells(path, tableIndex, queryDatabase, warnings);

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
      for (const cell of convertRows(previewResult.before, row => toTableCellRow(row, warnings))) {
        if (cell.path === path && cell.table_index === tableIndex) {
          deletedCellKeys.add(createRowColumnKey(cell.row_index, cell.column_name));
        }
      }

      allCells.push(...mergeExistingCells(existingCellRows, new Map<string, TableCellRow>(), deletedCellKeys));
    }
  }

  return allCells;
}

async function queryExistingTableCells(path: string, tableIndex: number, queryDatabase: QueryDatabase, warnings: string[]): Promise<TableCellRow[]> {
  const rows = await queryDatabase<Record<string, unknown>>('SELECT * FROM table_cells WHERE path = ? AND table_index = ? ORDER BY row_index, column_name', [path, tableIndex]);
  return convertRows(rows, row => toTableCellRow(row, warnings));
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

function createTaskIntents(previewResult: PreviewResult, warnings: string[]): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    return convertRows(previewResult.before, row => toTaskRow(row, warnings)).map(task => ({
      type: 'deleteTask',
      location: entityLocation(task),
      task
    }));
  }

  const isNewTasks = previewResult.before.length === 0 ||
    previewResult.after.every(afterRow =>
      !previewResult.before.some(beforeRow => beforeRow.id === afterRow.id)
    );

  const intents: ObsidianEditIntent[] = [];
  for (const row of previewResult.after) {
    const task = toTaskRow(row, warnings);
    if (!task) {
      continue;
    }

    const beforeRow = previewResult.before.find(before => before.id === row.id);
    const hasMatchingBefore = !!beforeRow;

    if (beforeRow) {
      copyMissingLocationFields(task, beforeRow);
    }

    if (isNewTasks || !hasMatchingBefore) {
      if (task.line_number == null) {
        task.line_number = INSERT_NEW_LINE;
      }

      intents.push({
        type: 'insertTask',
        path: task.path,
        lineNumber: task.line_number,
        task
      });
      continue;
    }

    intents.push({
      type: 'replaceTask',
      location: entityLocation(task),
      task
    });
  }

  return intents;
}

function createHeadingIntents(previewResult: PreviewResult, warnings: string[]): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    return convertRows(previewResult.before, row => toHeadingRow(row, warnings)).map(heading => ({
      type: 'deleteHeading',
      location: entityLocation(heading),
      heading
    }));
  }

  const intents: ObsidianEditIntent[] = [];
  for (const row of previewResult.after) {
    const heading = toHeadingRow(row, warnings);
    if (!heading) {
      continue;
    }

    if (previewResult.op === 'insert' && heading.line_number == null) {
      heading.line_number = INSERT_NEW_LINE;
    }

    if (heading.line_number === INSERT_NEW_LINE) {
      intents.push({
        type: 'insertHeading',
        path: heading.path,
        lineNumber: heading.line_number,
        heading
      });
      continue;
    }

    intents.push({
      type: 'replaceHeading',
      location: entityLocation(heading),
      heading
    });
  }

  return intents;
}

function createListItemIntents(previewResult: PreviewResult, warnings: string[]): ObsidianEditIntent[] {
  if (previewResult.op === 'delete') {
    return convertRows(previewResult.before, row => toListItemRow(row, warnings)).map(listItem => ({
      type: 'deleteListItem',
      location: entityLocation(listItem),
      listItem
    }));
  }

  if (previewResult.op === 'insert') {
    const intents: ObsidianEditIntent[] = [];
    for (let index = 0; index < previewResult.after.length; index++) {
      const listItem = toListItemRow(previewResult.after[index], warnings);
      if (!listItem) {
        continue;
      }

      if (listItem.list_index == null) {
        listItem.list_index = 0;
      }
      if (listItem.item_index == null) {
        listItem.item_index = index;
      }
      if (listItem.line_number == null) {
        listItem.line_number = INSERT_NEW_LINE;
      }

      intents.push({
        type: 'insertListItem',
        path: listItem.path,
        lineNumber: listItem.line_number,
        listItem
      });
    }
    return intents;
  }

  const intents: ObsidianEditIntent[] = [];
  for (const row of previewResult.after) {
    const listItem = toListItemRow(row, warnings);
    if (!listItem) {
      continue;
    }

    const beforeRow = previewResult.before.find(before => before.id === row.id);
    if (beforeRow) {
      copyMissingLocationFields(listItem, beforeRow);
    }

    intents.push({
      type: 'replaceListItem',
      location: entityLocation(listItem),
      listItem
    });
  }

  return intents;
}

function toPropertyRow(row: Row): PropertyRow {
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

function convertRows<T>(rows: Row[], convert: (row: Row) => T | null): T[] {
  const converted: T[] = [];
  for (const row of rows) {
    const result = convert(row);
    if (result !== null) {
      converted.push(result);
    }
  }
  return converted;
}

function readRequiredPath(row: Row, converterName: string, warnings: string[]): string | null {
  const path = asStr(row.path);
  if (!path) {
    logger.warn(`ObsidianEditIntentFactory.${converterName}: missing required field "path"`, row);
    warnings.push(`skipped a row with no "path" value (${converterName})`);
    return null;
  }
  return path;
}

function toTaskRow(row: Row, warnings: string[]): TaskRow | null {
  const path = readRequiredPath(row, 'toTaskRow', warnings);
  if (path === null) {
    return null;
  }

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
}, beforeRow: Row): void {
  const beforeLocation = readLocationFields(beforeRow);
  row.start_offset ??= beforeLocation.start_offset;
  row.end_offset ??= beforeLocation.end_offset;
  row.anchor_hash ??= beforeLocation.anchor_hash;
  row.block_id ??= beforeLocation.block_id;
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

function toHeadingRow(row: Row, warnings: string[]): HeadingRow | null {
  const path = readRequiredPath(row, 'toHeadingRow', warnings);
  if (path === null) {
    return null;
  }

  return {
    path,
    level: asNum(row.level, 1),
    heading_text: asStr(row.heading_text),
    ...readLocationFields(row)
  };
}

function toListItemRow(row: Row, warnings: string[]): ListItemRow | null {
  const path = readRequiredPath(row, 'toListItemRow', warnings);
  if (path === null) {
    return null;
  }

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

function toTableCellRow(row: Row, warnings: string[]): TableCellRow | null {
  const path = readRequiredPath(row, 'toTableCellRow', warnings);
  if (path === null) {
    return null;
  }

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
