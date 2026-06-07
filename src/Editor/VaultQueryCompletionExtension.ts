import {
  autocompletion,
  completionStatus,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { PROVIDER_DEFINITION_LANGUAGES } from '../Constants/EditorConstants';
import { logger as rootLogger } from '../utils/logger';
import { extractSqlAliasMap } from '../utils/SQLParsingUtils';
import type { ProviderDefinitionCompletionConfig, ProviderDefinitionCompletionItem } from '../Providers/TableProviderTypes';

const logger = rootLogger.scope('Completion');
declare const activeWindow: Window;

interface SuggestionItem {
  label: string;
  apply: string;
  detail?: string;
  type?: string;
}

interface ActiveFence {
  language: string;
  startLine: number;
  endLine: number;
}

interface SchemaCache {
  loadedAt: number;
  relations: SuggestionItem[];
  columns: SuggestionItem[];
  functions: SuggestionItem[];
  columnsByRelation: Map<string, SuggestionItem[]>;
}

type CompletionMode = 'yamlKey' | 'yamlValue' | 'sql' | 'section' | 'placeholder';
type SqlSuggestionContext = 'relation' | 'column' | 'function' | 'generic';

interface VaultQueryCompletionContext {
  mode: CompletionMode;
  fence: ActiveFence;
  from: number;
  to: number;
  query: string;
  key?: string;
}

const QUERY_BLOCK_LANGUAGES = new Set([
  'vaultquery',
  'vaultquery-chart',
  'vaultquery-markdown',
  'vaultquery-calendar',
]);

const SQL_LANGUAGES = new Set([
  'vaultquery',
  'vaultquery-chart',
  'vaultquery-markdown',
  'vaultquery-calendar',
  'vaultquery-write',
  'vaultquery-view',
  'vaultquery-trigger',
]);

const SQL_KEYWORDS: SuggestionItem[] = [
  'SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'LIMIT',
  'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE VIEW', 'CREATE TRIGGER',
  'WITH',
].map((label) => ({ label, apply: label, detail: 'SQL keyword', type: 'keyword' }));

const SQL_FUNCTIONS: SuggestionItem[] = [
  'COUNT()', 'SUM()', 'AVG()', 'MIN()', 'MAX()', 'COALESCE()', 'NULLIF()',
  'SUBSTR()', 'LENGTH()', 'UPPER()', 'LOWER()', 'TRIM()', 'REPLACE()',
  'ABS()', 'ROUND()', 'DATE()', 'TIME()', 'DATETIME()', 'STRFTIME()',
  'JSON_EXTRACT()', 'JSON_OBJECT()', 'JSON_ARRAY()', 'GROUP_CONCAT()',
].map((label) => ({ label, apply: label, detail: 'SQL function', type: 'function' }));

const PLACEHOLDER_VALUES: SuggestionItem[] = [
  ['{this.path}', 'Current note path'],
  ['{this.folder}', 'Current note folder'],
  ['{this.title}', 'Current note title'],
  ['{this.content}', 'Current note content'],
  ['{this.created}', 'Created timestamp'],
  ['{this.modified}', 'Modified timestamp'],
  ['{this.size}', 'File size'],
  ['{this.vault}', 'Vault name'],
  ['{this.today}', 'Today ISO date'],
  ['{this.now}', 'Current ISO datetime'],
  ['{this.year}', 'Current year'],
  ['{this.month}', 'Current month'],
  ['{this.day}', 'Current day of month'],
  ['{this.outgoingLinks}', 'Outgoing links list'],
  ['{this.tags}', 'Tags list'],
  ['{this.headings}', 'Headings list'],
].map(([label, detail]) => ({ label, apply: label, detail, type: 'variable' }));

PLACEHOLDER_VALUES.push({
  label: '{this.<key>}',
  apply: '{this.}',
  detail: 'Frontmatter property placeholder',
  type: 'variable',
});

const QUERY_SECTION_SUGGESTIONS: SuggestionItem[] = [
  { label: 'config', apply: 'config:\n', detail: 'Renderer configuration section', type: 'property' },
  { label: 'template', apply: 'template:\nreturn ``', detail: 'Template renderer section', type: 'property' },
];

const TABLE_CONFIG_KEYS: SuggestionItem[] = [
  { label: 'height', apply: 'height: ', detail: 'Fixed grid height', type: 'property' },
  { label: 'minHeight', apply: 'minHeight: ', detail: 'Minimum grid height', type: 'property' },
  { label: 'maxHeight', apply: 'maxHeight: ', detail: 'Maximum grid height', type: 'property' },
];

const MARKDOWN_CONFIG_KEYS: SuggestionItem[] = [
  { label: 'columns', apply: 'columns: ', detail: 'Column selection', type: 'property' },
  { label: 'alignment', apply: 'alignment: ', detail: 'Column alignment', type: 'property' },
];

const CHART_CONFIG_KEYS: SuggestionItem[] = [
  { label: 'type', apply: 'type: ', detail: 'Chart type', type: 'property' },
  { label: 'title', apply: 'title: ', detail: 'Chart title', type: 'property' },
  { label: 'datasetLabel', apply: 'datasetLabel: ', detail: 'Dataset label', type: 'property' },
  { label: 'xLabel', apply: 'xLabel: ', detail: 'X axis label', type: 'property' },
  { label: 'yLabel', apply: 'yLabel: ', detail: 'Y axis label', type: 'property' },
  { label: 'datasetBackgroundColor', apply: 'datasetBackgroundColor: ', detail: 'Dataset color', type: 'property' },
  { label: 'datasetBorderColor', apply: 'datasetBorderColor: ', detail: 'Dataset border color', type: 'property' },
];

const CALENDAR_CONFIG_KEYS: SuggestionItem[] = [
  { label: 'initialView', apply: 'initialView: ', detail: 'Calendar starting view', type: 'property' },
  { label: 'initialDate', apply: 'initialDate: ', detail: 'Calendar starting date', type: 'property' },
  { label: 'firstDay', apply: 'firstDay: ', detail: 'Week start day', type: 'property' },
  { label: 'weekNumbers', apply: 'weekNumbers: ', detail: 'Show week numbers', type: 'property' },
  { label: 'visibleWeeks', apply: 'visibleWeeks: ', detail: 'Month view visible weeks', type: 'property' },
  { label: 'skipBlankPeriods', apply: 'skipBlankPeriods: ', detail: 'Skip blank calendar periods when navigating', type: 'property' },
  { label: 'dayMaxEvents', apply: 'dayMaxEvents: ', detail: 'Maximum visible events per day cell', type: 'property' },
  { label: 'dayMaxEventRows', apply: 'dayMaxEventRows: ', detail: 'Maximum event rows per day cell', type: 'property' },
  { label: 'dayMinHeight', apply: 'dayMinHeight: ', detail: 'Minimum day cell height', type: 'property' },
  { label: 'eventMaxStack', apply: 'eventMaxStack: ', detail: 'Maximum stacked timed events', type: 'property' },
  { label: 'height', apply: 'height: ', detail: 'Calendar height', type: 'property' },
  { label: 'contentHeight', apply: 'contentHeight: ', detail: 'Calendar content height', type: 'property' },
  { label: 'aspectRatio', apply: 'aspectRatio: ', detail: 'Calendar aspect ratio', type: 'property' },
  { label: 'expandRows', apply: 'expandRows: ', detail: 'Expand rows to fill height', type: 'property' },
  { label: 'slotMinTime', apply: 'slotMinTime: ', detail: 'First visible slot time', type: 'property' },
  { label: 'slotMaxTime', apply: 'slotMaxTime: ', detail: 'Last visible slot time', type: 'property' },
  { label: 'slotDuration', apply: 'slotDuration: ', detail: 'Slot duration', type: 'property' },
];

const BOOLEAN_VALUES = ['true', 'false'].map((label) => ({ label, apply: label, detail: 'Boolean value', type: 'constant' }));
const CHART_TYPE_VALUES = ['bar', 'line', 'pie', 'doughnut', 'scatter'].map((label) => ({ label, apply: label, detail: 'Chart type', type: 'enum' }));
const CALENDAR_VIEW_VALUES = ['dayGridMonth', 'timeGridWeek', 'timeGridDay', 'month', 'week', 'day'].map((label) => ({ label, apply: label, detail: 'Calendar view', type: 'enum' }));
const CALENDAR_INITIAL_DATE_VALUES = [
  { label: 'first', apply: 'first', detail: 'Earliest event date', type: 'enum' },
  { label: 'last', apply: 'last', detail: 'Latest event date', type: 'enum' },
];
const SCHEMA_CACHE_TTL_MS = 30_000;

class VaultQueryCompletionProvider {
  private schemaCache: SchemaCache = {
    loadedAt: 0,
    relations: [],
    columns: [],
    functions: [],
    columnsByRelation: new Map(),
  };
  private schemaCachePromise: Promise<SchemaCache> | null = null;

  public constructor(private readonly plugin: VaultQueryPluginContext) {}

  public invalidateSchemaCache(): void {
    this.schemaCache = {
      loadedAt: 0,
      relations: [],
      columns: [],
      functions: [],
      columnsByRelation: new Map(),
    };
    this.schemaCachePromise = null;
  }

  public async source(context: CompletionContext): Promise<CompletionResult | null> {
    const completionContext = this.getCompletionContext(context.state, context.pos, context.explicit);
    if (!completionContext) {
      return null;
    }

    const options = await this.getCompletionItems(context.state, completionContext);
    if (options.length === 0) {
      return null;
    }

    return {
      from: completionContext.from,
      to: completionContext.to,
      options: this.filterItems(options, completionContext.query).map(toCompletion),
      validFor: /^[\w.{}[\]'",\s-]*$/u,
    };
  }

  public getCompletionContext(state: EditorState, pos: number, explicit: boolean): VaultQueryCompletionContext | null {
    const fence = getActiveFence(state, pos);
    if (!fence) {
      return null;
    }

    const line = state.doc.lineAt(pos);
    if (line.number >= fence.endLine) {
      return null;
    }

    if (this.isProviderDefinitionLanguage(fence.language)) {
      return getYamlCompletionContext(state, fence, pos, explicit, this);
    }

    if (QUERY_BLOCK_LANGUAGES.has(fence.language)) {
      return this.getVaultQueryBlockContext(state, fence, pos, explicit);
    }

    if (SQL_LANGUAGES.has(fence.language)) {
      return getSqlCompletionContext(state, fence, pos, explicit);
    }

    return null;
  }

  private getVaultQueryBlockContext(state: EditorState, fence: ActiveFence, pos: number, explicit: boolean): VaultQueryCompletionContext | null {
    const line = state.doc.lineAt(pos);
    const inConfig = isInConfigSection(state, fence, line.number);

    if (inConfig) {
      return getYamlCompletionContext(state, fence, pos, explicit, this);
    }

    const placeholder = getPlaceholderCompletionContext(state, fence, pos);
    if (placeholder) {
      return placeholder;
    }

    const trimmed = line.text.trim();
    const linePrefix = line.text.slice(0, pos - line.from).trim();
    if (!trimmed || 'config'.startsWith(linePrefix.toLowerCase()) || 'template'.startsWith(linePrefix.toLowerCase())) {
      return {
        mode: 'section',
        fence,
        from: line.from + line.text.match(/^\s*/u)![0].length,
        to: pos,
        query: linePrefix,
      };
    }

    return getSqlCompletionContext(state, fence, pos, explicit);
  }

  private async getCompletionItems(state: EditorState, context: VaultQueryCompletionContext): Promise<SuggestionItem[]> {
    switch (context.mode) {
      case 'yamlKey':
        return this.getYamlKeys(context.fence.language);
      case 'yamlValue':
        return this.getYamlValues(context.fence.language, context.key ?? '');
      case 'section':
        return context.fence.language === 'vaultquery'
          ? QUERY_SECTION_SUGGESTIONS
          : QUERY_SECTION_SUGGESTIONS.filter((item) => item.label === 'config');
      case 'placeholder':
        return PLACEHOLDER_VALUES;
      case 'sql':
        return this.getSqlSuggestions(state, context);
      default:
        return [];
    }
  }

  private getYamlKeys(language: string): SuggestionItem[] {
    const providerCompletions = this.getProviderDefinitionCompletions(language);
    if (providerCompletions) {
      return providerCompletions.keys.map(toSuggestionItemForKey);
    }

    if (language === 'vaultquery') {
      return TABLE_CONFIG_KEYS;
    }
    if (language === 'vaultquery-markdown') {
      return MARKDOWN_CONFIG_KEYS;
    }
    if (language === 'vaultquery-chart') {
      return CHART_CONFIG_KEYS;
    }
    if (language === 'vaultquery-calendar') {
      return CALENDAR_CONFIG_KEYS;
    }
    return [];
  }

  private getYamlValues(language: string, key: string): SuggestionItem[] {
    const normalizedKey = key.toLowerCase();
    const providerValues = this.getProviderDefinitionCompletions(language)?.values?.[normalizedKey];
    if (providerValues) {
      return providerValues.map(toSuggestionItemForValue);
    }

    switch (normalizedKey) {
      case 'type':
        return CHART_TYPE_VALUES;
      case 'initialview':
        return CALENDAR_VIEW_VALUES;
      case 'initialdate':
        return CALENDAR_INITIAL_DATE_VALUES;
      case 'weeknumbers':
      case 'expandrows':
      case 'skipblankperiods':
        return BOOLEAN_VALUES;
      default:
        return [];
    }
  }

  private async getSqlSuggestions(state: EditorState, context: VaultQueryCompletionContext): Promise<SuggestionItem[]> {
    const sqlSource = getSqlSourceBeforeCursor(state, context.fence, context.to);
    const beforeCursor = getLinePrefix(state, context.to);
    const sqlContext = getSqlSuggestionContext(beforeCursor);
    const schema = await this.getSchemaCache();
    const aliasMap = extractSqlAliasMap(sqlSource);
    const qualifiedColumns = getQualifiedColumnSuggestions(beforeCursor, aliasMap, schema);
    const primaryColumns = qualifiedColumns.length > 0
      ? qualifiedColumns
      : getPrimaryColumnsForContext(aliasMap, schema);

    switch (sqlContext) {
      case 'relation':
        return dedupeItems([...schema.relations, ...SQL_KEYWORDS]);
      case 'column':
        return dedupeItems([...primaryColumns, ...schema.columns, ...schema.functions, ...SQL_KEYWORDS, ...schema.relations]);
      case 'function':
        return dedupeItems([...schema.functions, ...schema.columns, ...SQL_KEYWORDS]);
      default:
        return dedupeItems([...primaryColumns, ...schema.columns, ...schema.relations, ...schema.functions, ...SQL_KEYWORDS]);
    }
  }

  private async getSchemaCache(): Promise<SchemaCache> {
    if (this.schemaCache.relations.length > 0 && (Date.now() - this.schemaCache.loadedAt) < SCHEMA_CACHE_TTL_MS) {
      return this.schemaCache;
    }

    if (this.schemaCachePromise) {
      return this.schemaCachePromise;
    }

    this.schemaCachePromise = this.loadSchemaCache();

    try {
      this.schemaCache = await this.schemaCachePromise;
      return this.schemaCache;
    }
    finally {
      this.schemaCachePromise = null;
    }
  }

  private async loadSchemaCache(): Promise<SchemaCache> {
    if (!this.plugin.api) {
      return this.schemaCache;
    }

    try {
      const schema = await this.plugin.api.getAutocompleteSchema();
      const relations = schema.relations.map((row) => ({
        label: row.name,
        apply: row.name,
        detail: row.type === 'view' ? 'View' : 'Table',
        type: row.type,
      }));

      const functions = dedupeItems([
        ...SQL_FUNCTIONS,
        ...schema.functions.map((name) => ({
          label: `${name}()`,
          apply: `${name}()`,
          detail: 'User-defined SQL function',
          type: 'function',
        })),
      ]);

      const columnItems = new Map<string, SuggestionItem>();
      for (const column of schema.columns) {
        const columnType = column.type || 'Column';
        columnItems.set(`${column.relation}:${column.name}`, {
          label: column.name,
          apply: column.name,
          detail: `${columnType} column`,
          type: 'field',
        });
        columnItems.set(`${column.relation}:${column.relation}.${column.name}`, {
          label: `${column.relation}.${column.name}`,
          apply: `${column.relation}.${column.name}`,
          detail: `${columnType} column`,
          type: 'field',
        });
      }

      return {
        loadedAt: Date.now(),
        relations,
        columns: Array.from(columnItems.values()).sort((a, b) => a.label.localeCompare(b.label)),
        functions,
        columnsByRelation: buildColumnsByRelation(schema.columns),
      };
    }
    catch (error) {
      logger.error('Failed to load schema suggestions', error);
      return this.schemaCache;
    }
  }

  private isProviderDefinitionLanguage(language: string): boolean {
    return PROVIDER_DEFINITION_LANGUAGES.has(language);
  }

  public isKnownConfigContext(language: string): boolean {
    return this.isProviderDefinitionLanguage(language)
      || language === 'vaultquery'
      || language === 'vaultquery-markdown'
      || language === 'vaultquery-chart'
      || language === 'vaultquery-calendar';
  }

  public isMultiValueProviderKey(language: string, key: string): boolean {
    const normalizedKey = key.toLowerCase();
    return this.getProviderDefinitionCompletions(language)?.multiValueKeys
      ?.some((candidate) => candidate.toLowerCase() === normalizedKey) ?? false;
  }

  public hasYamlValueSuggestions(language: string, key: string): boolean {
    const normalizedKey = key.toLowerCase();
    return Boolean(this.getProviderDefinitionCompletions(language)?.values?.[normalizedKey]?.length)
      || ['type', 'initialview', 'weeknumbers', 'expandrows'].includes(normalizedKey);
  }

  private getProviderDefinitionCompletions(language: string): ProviderDefinitionCompletionConfig | null {
    return this.plugin.api?.getProviderDefinitionCompletions(language) ?? null;
  }

  private filterItems(items: SuggestionItem[], query: string): SuggestionItem[] {
    const normalizedQuery = query.toLowerCase();
    if (!normalizedQuery) {
      return items;
    }

    return items.filter((item) => item.label.toLowerCase().includes(normalizedQuery));
  }
}

function getActiveFence(state: EditorState, pos: number): ActiveFence | null {
  const line = state.doc.lineAt(pos);

  for (let lineNumber = line.number; lineNumber >= 1; lineNumber--) {
    const text = state.doc.line(lineNumber).text.trim();
    const match = text.match(/^```(\S+)/u);
    if (!match) {
      continue;
    }

    if (lineNumber === line.number) {
      return null;
    }

    const language = match[1];
    for (let endLine = lineNumber + 1; endLine <= state.doc.lines; endLine++) {
      if (state.doc.line(endLine).text.trim().startsWith('```')) {
        return endLine >= line.number ? { language, startLine: lineNumber, endLine } : null;
      }
    }

    return { language, startLine: lineNumber, endLine: state.doc.lines };
  }

  return null;
}

function getYamlCompletionContext(state: EditorState, fence: ActiveFence, pos: number, explicit: boolean, provider: VaultQueryCompletionProvider): VaultQueryCompletionContext | null {
  const line = state.doc.lineAt(pos);
  const cursorCh = pos - line.from;
  const beforeCursor = line.text.slice(0, cursorCh);
  const keyMatch = line.text.match(/^(\s*)([A-Za-z][\w-]*)?\s*(?::\s*(.*))?$/u);
  if (!keyMatch) {
    return null;
  }

  const [, indent = '', rawKey = ''] = keyMatch;
  const colonIndex = line.text.indexOf(':');

  if (colonIndex === -1 || cursorCh <= colonIndex) {
    const keyStartCh = indent.length;
    const query = beforeCursor.slice(keyStartCh).trim();
    if (!query && !explicit && !provider.isKnownConfigContext(fence.language)) {
      return null;
    }

    return {
      mode: 'yamlKey',
      fence,
      from: line.from + keyStartCh,
      to: pos,
      query,
    };
  }

  const key = rawKey.trim();
  if (!key) {
    return null;
  }

  const valueStartCh = colonIndex + 1;
  const segmentStartCh = provider.isMultiValueProviderKey(fence.language, key) && beforeCursor.lastIndexOf(',') >= valueStartCh
    ? beforeCursor.lastIndexOf(',') + 1
    : valueStartCh;
  const triggerStartCh = skipWhitespace(line.text, segmentStartCh);
  const query = beforeCursor.slice(triggerStartCh).trim();

  if (!query && !provider.hasYamlValueSuggestions(fence.language, key)) {
    return null;
  }

  return {
    mode: 'yamlValue',
    fence,
    from: line.from + triggerStartCh,
    to: pos,
    query,
    key,
  };
}

function getPlaceholderCompletionContext(state: EditorState, fence: ActiveFence, pos: number): VaultQueryCompletionContext | null {
  const line = state.doc.lineAt(pos);
  const cursorCh = pos - line.from;
  const beforeCursor = line.text.slice(0, cursorCh);
  const braceIndex = beforeCursor.lastIndexOf('{');
  if (braceIndex === -1 || beforeCursor.lastIndexOf('}') > braceIndex || /\s/u.test(beforeCursor.slice(braceIndex))) {
    return null;
  }

  return {
    mode: 'placeholder',
    fence,
    from: line.from + braceIndex,
    to: pos,
    query: beforeCursor.slice(braceIndex).trim(),
  };
}

function getSqlCompletionContext(state: EditorState, fence: ActiveFence, pos: number, explicit: boolean): VaultQueryCompletionContext | null {
  const placeholder = getPlaceholderCompletionContext(state, fence, pos);
  if (placeholder) {
    return placeholder;
  }

  const line = state.doc.lineAt(pos);
  const beforeCursor = line.text.slice(0, pos - line.from);
  if (isInsideQuotedString(beforeCursor)) {
    return null;
  }

  const tokenStart = findSqlCompletionStart(beforeCursor);
  const query = beforeCursor.slice(tokenStart).trim();

  if (!query && !explicit) {
    const lastChar = beforeCursor[beforeCursor.length - 1] ?? '';
    if (lastChar !== '.' && !/\s|,|\(/u.test(lastChar)) {
      return null;
    }
  }

  return {
    mode: 'sql',
    fence,
    from: line.from + tokenStart,
    to: pos,
    query,
  };
}

function getLinePrefix(state: EditorState, pos: number): string {
  const line = state.doc.lineAt(pos);
  return line.text.slice(0, pos - line.from);
}

function findSqlCompletionStart(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const lastChar = text[text.length - 1];
  if (/\s|,|\(/u.test(lastChar)) {
    return text.length;
  }

  let index = text.length;
  while (index > 0) {
    const char = text[index - 1];
    if (/[A-Za-z0-9_.]/u.test(char)) {
      index--;
      continue;
    }

    if (char === '"' || char === '`' || char === '[') {
      index--;
    }
    break;
  }

  return index;
}

function getSqlSuggestionContext(beforeCursor: string): SqlSuggestionContext {
  if (/\b(from|join|update|into|table|view)\s+["`[\w.]*$/iu.test(beforeCursor)) {
    return 'relation';
  }

  if (/(?:select|where|and|or|on|having|set)[\s\S]*\b[a-z_][a-z0-9_]*\(\s*$/iu.test(beforeCursor)) {
    return 'function';
  }

  if (/\b(select|where|and|or|on|group by|order by|having|set)\s+["`[\w.,\s]*$/iu.test(beforeCursor)) {
    return 'column';
  }

  return 'generic';
}

function getSqlSourceBeforeCursor(state: EditorState, fence: ActiveFence, pos: number): string {
  const cursorLine = state.doc.lineAt(pos);
  const lines: string[] = [];
  let inConfig = false;
  let inTemplate = false;

  for (let lineNumber = fence.startLine + 1; lineNumber <= cursorLine.number; lineNumber++) {
    let text = state.doc.line(lineNumber).text;
    if (lineNumber === cursorLine.number) {
      text = text.slice(0, pos - cursorLine.from);
    }

    const trimmed = text.trim();
    if (trimmed === 'config:') {
      inConfig = true;
      continue;
    }
    if (trimmed.startsWith('template:')) {
      inTemplate = true;
      continue;
    }
    if (inConfig || inTemplate) {
      continue;
    }

    lines.push(text);
  }

  return lines.join('\n');
}

function getQualifiedColumnSuggestions(beforeCursor: string, aliasMap: Map<string, string>, schema: SchemaCache): SuggestionItem[] {
  const qualifierMatch = beforeCursor.match(/([A-Za-z_][\w]*)\.\s*[A-Za-z0-9_]*$/u);
  if (!qualifierMatch) {
    return [];
  }

  const qualifier = qualifierMatch[1];
  const relation = aliasMap.get(qualifier.toLowerCase()) ?? qualifier;
  const relationColumns = schema.columnsByRelation.get(relation.toLowerCase()) ?? [];

  return relationColumns.map((column) => ({
    label: `${qualifier}.${column.apply}`,
    apply: `${qualifier}.${column.apply}`,
    detail: `${relation} ${(column.detail ?? 'column').toLowerCase()}`,
    type: 'field',
  }));
}

function getPrimaryColumnsForContext(aliasMap: Map<string, string>, schema: SchemaCache): SuggestionItem[] {
  const seenRelations = new Set<string>();
  const orderedRelations: string[] = [];

  for (const relation of aliasMap.values()) {
    const normalized = relation.toLowerCase();
    if (seenRelations.has(normalized)) {
      continue;
    }
    seenRelations.add(normalized);
    orderedRelations.push(relation);
  }

  return orderedRelations.flatMap((relation) => schema.columnsByRelation.get(relation.toLowerCase()) ?? []);
}

function buildColumnsByRelation(columns: Array<{ relation: string; name: string; type: string }>): Map<string, SuggestionItem[]> {
  const map = new Map<string, SuggestionItem[]>();

  for (const column of columns) {
    const relation = column.relation.toLowerCase();
    const items = map.get(relation) ?? [];
    items.push({
      label: column.name,
      apply: column.name,
      detail: `${column.type || 'Column'} column`,
      type: 'field',
    });
    map.set(relation, items);
  }

  for (const [relation, items] of map) {
    items.sort((a, b) => a.label.localeCompare(b.label));
    map.set(relation, items);
  }

  return map;
}

function isInConfigSection(state: EditorState, fence: ActiveFence, lineNumber: number): boolean {
  let foundConfig = false;

  for (let line = fence.startLine + 1; line <= lineNumber; line++) {
    const trimmed = state.doc.line(line).text.trim();
    if (trimmed === 'config:') {
      foundConfig = true;
      continue;
    }
    if ((trimmed === 'template:' || trimmed.startsWith('template:')) && line <= lineNumber) {
      return false;
    }
  }

  return foundConfig;
}

function skipWhitespace(line: string, start: number): number {
  let index = start;
  while (index < line.length && /\s/u.test(line[index])) {
    index++;
  }
  return index;
}

function isInsideQuotedString(text: string): boolean {
  let singleQuotes = 0;
  let doubleQuotes = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'" && text[index - 1] !== '\\') {
      singleQuotes++;
    }
    else if (char === '"' && text[index - 1] !== '\\') {
      doubleQuotes++;
    }
  }

  return (singleQuotes % 2) === 1 || (doubleQuotes % 2) === 1;
}

function dedupeItems(items: SuggestionItem[]): SuggestionItem[] {
  const seen = new Set<string>();
  const deduped: SuggestionItem[] = [];

  for (const item of items) {
    const key = `${item.label}::${item.apply}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function toCompletion(item: SuggestionItem): Completion {
  return {
    label: item.label,
    apply: item.apply,
    detail: item.detail,
    type: item.type,
  };
}

function toSuggestionItemForKey(item: ProviderDefinitionCompletionItem): SuggestionItem {
  return {
    label: item.label,
    apply: item.apply ?? `${item.label}: `,
    detail: item.detail,
    type: item.type ?? 'property',
  };
}

function toSuggestionItemForValue(item: ProviderDefinitionCompletionItem): SuggestionItem {
  return {
    label: item.label,
    apply: item.apply ?? item.label,
    detail: item.detail,
    type: item.type ?? 'enum',
  };
}

function shouldStartCompletionAfterUpdate(update: ViewUpdate, provider: VaultQueryCompletionProvider): boolean {
  if (!update.docChanged || completionStatus(update.state) !== null) {
    return false;
  }

  const selection = update.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) {
    return false;
  }

  const context = provider.getCompletionContext(update.state, selection.main.head, false);
  return Boolean(context && context.query === '' && (context.mode === 'yamlKey' || context.mode === 'yamlValue' || context.mode === 'sql'));
}

function completionStarter(provider: VaultQueryCompletionProvider): Extension {
  return ViewPlugin.fromClass(class {
    private pendingStart: number | null = null;

    update(update: ViewUpdate): void {
      if (!shouldStartCompletionAfterUpdate(update, provider)) {
        return;
      }

      if (this.pendingStart !== null) {
        activeWindow.clearTimeout(this.pendingStart);
      }

      this.pendingStart = activeWindow.setTimeout(() => {
        this.pendingStart = null;
        if (completionStatus(update.view.state) === null) {
          startCompletion(update.view);
        }
      }, 0);
    }

    destroy(): void {
      if (this.pendingStart !== null) {
        activeWindow.clearTimeout(this.pendingStart);
      }
    }
  });
}

export function createVaultQueryCompletionExtension(plugin: VaultQueryPluginContext): { extension: Extension; invalidateSchemaCache: () => void } {
  const provider = new VaultQueryCompletionProvider(plugin);
  const source = (context: CompletionContext): Promise<CompletionResult | null> => provider.source(context);

  return {
    extension: [
      autocompletion(),
      EditorState.languageData.of(() => [{ autocomplete: source }]),
      Prec.lowest(completionStarter(provider)),
    ],
    invalidateSchemaCache: () => provider.invalidateSchemaCache(),
  };
}
