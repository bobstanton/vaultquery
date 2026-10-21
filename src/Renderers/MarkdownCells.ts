import { parseBooleanOption } from '../utils/ConfigParsingUtils';

const MARKDOWN_RULES: ReadonlyMap<string, RegExp> = new Map([
  ['wikilink', /\[\[/],
  ['image', /!\[/],
  ['link', /\[[^\]]*\]\(/],
  ['code', /`/],
  ['bullet-list', /^\s{0,3}[-*+]\s/m],
  ['ordered-list', /^\s{0,3}\d+\.\s/m],
  ['heading', /^\s{0,3}#{1,6}\s/m],
  ['quote', /^\s{0,3}>/m],
  ['strikethrough', /~~/],
  ['strong-asterisk', /\*\*/],
  ['strong-underscore', /(^|[^A-Za-z0-9_])__/],
  ['emphasis-asterisk', /(^|[^A-Za-z0-9_])\*\S[^*\n]*\*/],
  ['emphasis-underscore', /(^|[^A-Za-z0-9_])_\S[^_\n]*_([^A-Za-z0-9_]|$)/],
  ['url', /https?:\/\//],
]);

export interface MarkdownColumnSelection {
  all: boolean;
  columns: ReadonlySet<string>;
}

export const NO_MARKDOWN_COLUMNS: MarkdownColumnSelection = { all: false, columns: new Set<string>() };

const ALL_MARKDOWN_COLUMNS: MarkdownColumnSelection = { all: true, columns: new Set<string>() };

export function parseMarkdownColumns(options?: Record<string, unknown>): MarkdownColumnSelection {
  const value = typeof options?.markdown === 'string' ? options.markdown.trim().toLowerCase() : '';

  if (!value) {
    return NO_MARKDOWN_COLUMNS;
  }

  if (value === 'all') {
    return ALL_MARKDOWN_COLUMNS;
  }

  if (value === 'none') {
    return NO_MARKDOWN_COLUMNS;
  }

  const flag = parseBooleanOption(value);

  if (flag !== undefined) {
    return flag ? ALL_MARKDOWN_COLUMNS : NO_MARKDOWN_COLUMNS;
  }

  const columns = value.split(',').map(column => column.trim()).filter(Boolean);

  return columns.length > 0 ? { all: false, columns: new Set(columns) } : NO_MARKDOWN_COLUMNS;
}

export function markdownColumnsSignature(selection: MarkdownColumnSelection): string {
  return selection.all ? 'all' : Array.from(selection.columns).sort().join(',');
}

export function shouldRenderMarkdownColumn(selection: MarkdownColumnSelection, column: string): boolean {
  return selection.all || selection.columns.has(column.toLowerCase());
}

export function markdownCellSource(value: unknown): string | undefined {
  if (typeof value !== 'string' || !looksLikeMarkdown(value)) return;

  return value.replace(/```vaultquery[^\n]*/g, '```sql');
}

function looksLikeMarkdown(value: string): boolean {
  for (const rule of MARKDOWN_RULES.values()) {
    if (rule.test(value)) return true;
  }

  return false;
}
