import { autocompletion, completionStatus, startCompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorState, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { CONFIG_CAPABLE_LANGUAGES, PROVIDER_DEFINITION_LANGUAGES, SQL_EDITOR_LANGUAGES } from '../Constants/EditorConstants';
import { SQL_COMPLETION_KEYWORD_PHRASES, SQL_FUNCTION_TOKENS, SQL_PHRASE_LEAD_WORDS, VAULTQUERY_FUNCTION_SIGNATURES } from '../Constants/SqlCatalog';
import { getConfigKeys, getConfigValues } from '../Constants/BlockConfigCatalog';
import type { ConfigValueSuggestion } from '../Constants/BlockConfigCatalog';
import { logger as rootLogger } from '../utils/logger';
import { extractSqlAliasMap } from '../utils/SQLParsingUtils';
import { skipWhitespace } from '../utils/StringUtils';
import type { ProviderDefinitionCompletionConfig, ProviderDefinitionCompletionItem } from '../Providers/TableProviderTypes';

const logger = rootLogger.scope('Completion');

interface SuggestionItem {
  label: string;
  displayLabel?: string;
  apply: string;
  detail?: string;
  type?: string;
  boost?: number;
  cursorOffset?: number;
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
  propertyPlaceholders: SuggestionItem[];
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

const SQL_KEYWORDS: SuggestionItem[] = SQL_COMPLETION_KEYWORD_PHRASES
  .map((label) => ({ label, apply: label, detail: 'SQL keyword', type: 'keyword' }));

const SQL_FUNCTIONS: SuggestionItem[] = Array.from(SQL_FUNCTION_TOKENS)
  .sort((left, right) => left.localeCompare(right))
  .map((name) => name.toUpperCase())
  .map((name) => ({
    label: `${name}()`,
    apply: `${name}()`,
    detail: 'SQL function',
    type: 'function',
    cursorOffset: name.length + 1,
  }));

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
].map(([label, detail]) => ({ label, apply: label, detail, type: 'variable', boost: 1 }));

PLACEHOLDER_VALUES.push({
  label: '{this.<key>}',
  apply: '{this.}',
  detail: 'Frontmatter property placeholder',
  type: 'variable',
  boost: -1,
  cursorOffset: '{this.'.length,
});

const QUERY_SECTION_SUGGESTIONS: SuggestionItem[] = [
  { label: 'config', apply: 'config:\n', detail: 'Renderer configuration section', type: 'property' },
  { label: 'template', apply: 'template:\nreturn ``', detail: 'Template renderer section', type: 'property' },
];

const VAULTQUERY_FUNCTIONS_BY_SCOPE: Record<'query' | 'trigger', SuggestionItem[]> = {
  query: buildVaultQueryFunctionItems('query'),
  trigger: buildVaultQueryFunctionItems('trigger'),
};

function buildVaultQueryFunctionItems(scope: 'query' | 'trigger'): SuggestionItem[] {
  return VAULTQUERY_FUNCTION_SIGNATURES
    .filter((signature) => signature.scope === scope)
    .map((signature) => ({
      label: signature.name,
      displayLabel: `${signature.name}(${signature.args.join(', ')})`,
      apply: `${signature.name}()`,
      detail: signature.detail,
      type: 'function',
      cursorOffset: signature.name.length + 1,
    }));
}

function getVaultQueryFunctionItems(language: string): SuggestionItem[] {
  return language === 'vaultquery-trigger'
    ? [...VAULTQUERY_FUNCTIONS_BY_SCOPE.trigger, ...VAULTQUERY_FUNCTIONS_BY_SCOPE.query]
    : VAULTQUERY_FUNCTIONS_BY_SCOPE.query;
}

const SCHEMA_CACHE_TTL_MS = 30_000;
const MAX_PROPERTY_KEY_SUGGESTIONS = 300;

function emptySchemaCache(): SchemaCache {
  return {
    loadedAt: 0,
    relations: [],
    columns: [],
    functions: [],
    columnsByRelation: new Map(),
    propertyPlaceholders: [],
  };
}

export class VaultQueryCompletionProvider {
  private schemaCache: SchemaCache = emptySchemaCache();
  private schemaCachePromise: Promise<SchemaCache> | null = null;

  public constructor(private readonly plugin: VaultQueryPluginContext) {}

  public invalidateSchemaCache(): void {
    this.schemaCache = emptySchemaCache();
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
      validFor: /^[\w.{}[\]'"-]*$/u,
      getMatch: getDisplayLabelMatch,
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

    if (CONFIG_CAPABLE_LANGUAGES.has(fence.language)) {
      return this.getVaultQueryBlockContext(state, fence, pos, explicit);
    }

    if (SQL_EDITOR_LANGUAGES.has(fence.language)) {
      return getSqlCompletionContext(state, fence, pos, explicit);
    }

    return null;
  }

  private getVaultQueryBlockContext(state: EditorState, fence: ActiveFence, pos: number, explicit: boolean): VaultQueryCompletionContext | null {
    const line = state.doc.lineAt(pos);

    if (isInTemplateSection(state, fence, line.number)) {
      return null;
    }

    if (isInConfigSection(state, fence, line.number)) {
      return getYamlCompletionContext(state, fence, pos, explicit, this);
    }

    const placeholder = getPlaceholderCompletionContext(state, fence, pos);
    if (placeholder) {
      return placeholder;
    }

    const trimmed = line.text.trim();
    const linePrefix = line.text.slice(0, pos - line.from).trim();
    const typedSectionPrefix = Boolean(linePrefix)
      && ('config'.startsWith(linePrefix.toLowerCase()) || 'template'.startsWith(linePrefix.toLowerCase()));

    const isSectionCandidate = typedSectionPrefix
      || (!trimmed && !isInsideUnterminatedStatement(state, fence, line.number));

    if (isSectionCandidate) {
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

  public async getCompletionItems(state: EditorState, context: VaultQueryCompletionContext): Promise<SuggestionItem[]> {
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
        return this.getPlaceholderSuggestions();
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

    return getConfigKeys(language).map((definition) => ({
      label: definition.key,
      apply: `${definition.key}: `,
      detail: definition.detail,
      type: 'property',
    }));
  }

  private getYamlValues(language: string, key: string): SuggestionItem[] {
    const normalizedKey = key.toLowerCase();
    const providerValues = this.getProviderDefinitionCompletions(language)?.values?.[normalizedKey];
    if (providerValues) {
      return providerValues.map(toSuggestionItemForValue);
    }

    return getConfigValues(language, key).map(toSuggestionItemForConfigValue);
  }

  private async getPlaceholderSuggestions(): Promise<SuggestionItem[]> {
    const schema = await this.getSchemaCache();
    return dedupeItems([...PLACEHOLDER_VALUES, ...schema.propertyPlaceholders]);
  }

  private async getSqlSuggestions(state: EditorState, context: VaultQueryCompletionContext): Promise<SuggestionItem[]> {
    const sqlSource = collectFenceSql(state, context.fence);
    const beforeCursor = getSqlPrefixForCursor(state, context.fence, context.to);
    const sqlContext = getSqlSuggestionContext(beforeCursor);
    const schema = await this.getSchemaCache();
    const aliasMap = extractSqlAliasMap(sqlSource);
    const qualifiedColumns = getQualifiedColumnSuggestions(beforeCursor, aliasMap, schema);
    const primaryColumns = qualifiedColumns.length > 0
      ? qualifiedColumns
      : getPrimaryColumnsForContext(aliasMap, schema);
    const functions = dedupeItems([...getVaultQueryFunctionItems(context.fence.language), ...schema.functions]);

    switch (sqlContext) {
      case 'relation':
        return dedupeItems([...boost(schema.relations, 2), ...SQL_KEYWORDS]);
      case 'column':
        return dedupeItems([
          ...boost(primaryColumns, 2),
          ...boost(schema.columns, 1),
          ...functions,
          ...boost(SQL_KEYWORDS, -1),
          ...boost(schema.relations, -1),
        ]);
      case 'function':
        return dedupeItems([...boost(functions, 2), ...schema.columns, ...boost(SQL_KEYWORDS, -1)]);
      default:
        return dedupeItems([
          ...boost(primaryColumns, 1),
          ...schema.columns,
          ...schema.relations,
          ...functions,
          ...boost(SQL_KEYWORDS, -1),
        ]);
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
          cursorOffset: name.length + 1,
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
        propertyPlaceholders: await this.loadPropertyPlaceholders(relations),
      };
    }
    catch (error) {
      logger.error('Failed to load schema suggestions', error);
      return this.schemaCache;
    }
  }

  private async loadPropertyPlaceholders(relations: SuggestionItem[]): Promise<SuggestionItem[]> {
    if (!this.plugin.api || !relations.some((relation) => relation.label === 'properties')) {
      return [];
    }

    try {
      const rows = await this.plugin.api.query(
        `SELECT DISTINCT key FROM properties ORDER BY key LIMIT ${MAX_PROPERTY_KEY_SUGGESTIONS}`
      );

      return rows
        .map((row) => row.key)
        .filter((key): key is string => typeof key === 'string' && /^[\w-]+$/u.test(key))
        .map((key) => ({
          label: `{this.${key}}`,
          apply: `{this.${key}}`,
          detail: 'Frontmatter property of the current note',
          type: 'variable',
        }));
    }
    catch (error) {
      logger.debug('Frontmatter placeholder suggestions unavailable', error);
      return [];
    }
  }

  private isProviderDefinitionLanguage(language: string): boolean {
    return PROVIDER_DEFINITION_LANGUAGES.has(language);
  }

  public isKnownConfigContext(language: string): boolean {
    return this.isProviderDefinitionLanguage(language) || CONFIG_CAPABLE_LANGUAGES.has(language);
  }

  public isMultiValueProviderKey(language: string, key: string): boolean {
    const normalizedKey = key.toLowerCase();
    return this.getProviderDefinitionCompletions(language)?.multiValueKeys
      ?.some((candidate) => candidate.toLowerCase() === normalizedKey) ?? false;
  }

  public hasYamlValueSuggestions(language: string, key: string): boolean {
    const normalizedKey = key.toLowerCase();
    return Boolean(this.getProviderDefinitionCompletions(language)?.values?.[normalizedKey]?.length)
      || getConfigValues(language, key).length > 0;
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

export function getActiveFence(state: EditorState, pos: number): ActiveFence | null {
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

  const listItem = getYamlListItemContext(state, fence, pos, provider);
  if (listItem) {
    return listItem;
  }

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

function getYamlListItemContext(state: EditorState, fence: ActiveFence, pos: number, provider: VaultQueryCompletionProvider): VaultQueryCompletionContext | null {
  if (!PROVIDER_DEFINITION_LANGUAGES.has(fence.language)) {
    return null;
  }

  const line = state.doc.lineAt(pos);
  const listMatch = line.text.match(/^(\s*)-(\s*)/u);
  if (!listMatch) {
    return null;
  }

  const [, indent = '', spacing = ''] = listMatch;
  const valueStartCh = indent.length + 1 + spacing.length;
  const cursorCh = pos - line.from;
  if (cursorCh < valueStartCh) {
    return null;
  }

  const parentKey = getEnclosingYamlKey(state, fence, line.number, indent.length);
  if (!parentKey) {
    return null;
  }

  const query = line.text.slice(valueStartCh, cursorCh).trim();
  if (!query && !provider.hasYamlValueSuggestions(fence.language, parentKey)) {
    return null;
  }

  return {
    mode: 'yamlValue',
    fence,
    from: line.from + valueStartCh,
    to: pos,
    query,
    key: parentKey,
  };
}

function getEnclosingYamlKey(state: EditorState, fence: ActiveFence, lineNumber: number, indent: number): string | null {
  for (let current = lineNumber - 1; current > fence.startLine; current--) {
    const text = state.doc.line(current).text;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if ((text.match(/^\s*/u)?.[0].length ?? 0) >= indent) {
      continue;
    }

    return trimmed.match(/^([A-Za-z][\w-]*)\s*:/u)?.[1] ?? null;
  }

  return null;
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

function getSqlPrefixForCursor(state: EditorState, fence: ActiveFence, pos: number): string {
  const line = state.doc.lineAt(pos);
  return collectFenceSql(state, fence, { lineNumber: line.number, endCh: pos - line.from });
}

function findPhraseLeadWordStart(text: string): number | null {
  if (!text.endsWith(' ') || text.endsWith('  ')) {
    return null;
  }

  const wordMatch = text.slice(0, -1).match(/([A-Za-z]+)$/u);
  if (!wordMatch) {
    return null;
  }

  return SQL_PHRASE_LEAD_WORDS.has(wordMatch[1].toLowerCase())
    ? text.length - 1 - wordMatch[1].length
    : null;
}

export function findSqlCompletionStart(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const lastChar = text[text.length - 1];
  if (/\s|,|\(/u.test(lastChar)) {
    return findPhraseLeadWordStart(text) ?? text.length;
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

export function getSqlSuggestionContext(beforeCursor: string): SqlSuggestionContext {
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

function collectFenceSql(state: EditorState, fence: ActiveFence, cursor?: { lineNumber: number; endCh: number }): string {
  const lines: string[] = [];
  const lastLine = Math.min(cursor?.lineNumber ?? fence.endLine, fence.endLine, state.doc.lines);
  let inConfig = false;
  let inTemplate = false;

  for (let lineNumber = fence.startLine + 1; lineNumber <= lastLine; lineNumber++) {
    const fullText = state.doc.line(lineNumber).text;
    const text = cursor && lineNumber === cursor.lineNumber ? fullText.slice(0, cursor.endCh) : fullText;
    const trimmed = text.trim();
    if (trimmed.startsWith('```')) {
      continue;
    }
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

function isInsideUnterminatedStatement(state: EditorState, fence: ActiveFence, lineNumber: number): boolean {
  for (let current = lineNumber - 1; current > fence.startLine; current--) {
    const trimmed = state.doc.line(current).text.trim();
    if (!trimmed || trimmed.startsWith('```')) {
      continue;
    }

    return !trimmed.endsWith(';');
  }

  return false;
}

function isInTemplateSection(state: EditorState, fence: ActiveFence, lineNumber: number): boolean {
  for (let line = fence.startLine + 1; line < lineNumber; line++) {
    if (state.doc.line(line).text.trim().startsWith('template:')) {
      return true;
    }
  }

  return false;
}

function isInConfigSection(state: EditorState, fence: ActiveFence, lineNumber: number): boolean {
  let foundConfig = false;

  for (let line = fence.startLine + 1; line <= lineNumber; line++) {
    const trimmed = state.doc.line(line).text.trim();
    if (trimmed === 'config:') {
      foundConfig = true;
      continue;
    }
    if (trimmed.startsWith('template:')) {
      return false;
    }
  }

  return foundConfig;
}

export function isInsideQuotedString(text: string): boolean {
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

function boost(items: SuggestionItem[], value: number): SuggestionItem[] {
  return items.map((item) => ({ ...item, boost: value }));
}

function dedupeItems(items: SuggestionItem[]): SuggestionItem[] {
  const seen = new Set<string>();
  const deduped: SuggestionItem[] = [];

  for (const item of items) {
    const key = `${item.label}::${item.displayLabel ?? ''}::${item.apply}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function getDisplayLabelMatch(completion: Completion, matched?: readonly number[]): readonly number[] {
  const displayLabel = completion.displayLabel;
  if (!matched || !displayLabel || !displayLabel.startsWith(completion.label)) {
    return [];
  }

  return matched;
}

function toCompletion(item: SuggestionItem): Completion {
  const { apply, cursorOffset } = item;

  return {
    label: item.label,
    displayLabel: item.displayLabel,
    apply: cursorOffset === undefined
      ? apply
      : (view, _completion, from, to) => {
        view.dispatch({
          changes: { from, to, insert: apply },
          selection: { anchor: from + cursorOffset },
          userEvent: 'input.complete',
        });
      },
    detail: item.detail,
    type: item.type,
    boost: item.boost,
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

function toSuggestionItemForConfigValue(item: ConfigValueSuggestion): SuggestionItem {
  return {
    label: item.label,
    displayLabel: item.displayLabel,
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
        window.clearTimeout(this.pendingStart);
      }

      this.pendingStart = window.setTimeout(() => {
        this.pendingStart = null;
        if (completionStatus(update.view.state) === null) {
          startCompletion(update.view);
        }
      }, 0);
    }

    destroy(): void {
      if (this.pendingStart !== null) {
        window.clearTimeout(this.pendingStart);
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
