import { EditorView, WidgetType } from '@codemirror/view';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { detectDmlOperationInSql } from '../utils/SQLParsingUtils';
import { logger as rootLogger } from '../utils/logger';
import { scalarFromResults } from '../utils/ResultFormatUtils';
import { isCodeElementInsidePre } from './InlineMarkdownUtils';
import { createInlineDecorationExtension, type InlineSyntax } from './InlineDecorationUtils';
import { createInlineSpan, setInlineSpanError, setInlineSpanValue } from './InlineDomState';
import { waitForInlineVaultQueryReady } from './InlineVaultQueryReadiness';

const logger = rootLogger.scope('InlineQueries');
const INLINE_QUERY_CLASS = 'vaultquery-inline-query';
const INLINE_QUERY_SYNTAX: InlineSyntax<string> = {
  regex: /`vq\{([^`\n]+)\}`/g,
  parseMatch: (match) => match[1].trim(),
};

function isReadOnlyQuery(sql: string): boolean {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
    return false;
  }

  return detectDmlOperationInSql(sql) === null;
}

async function resolveInlineQuery(plugin: VaultQueryPluginContext, sql: string, sourcePath: string): Promise<string> {
  if (!isReadOnlyQuery(sql)) {
    throw new Error('Inline queries only support SELECT/WITH statements');
  }

  const api = await waitForInlineVaultQueryReady(plugin);
  const results = await api.query(sql, sourcePath);
  return scalarFromResults(results);
}

class InlineQueryWidget extends WidgetType {
  public constructor(private sql: string, private plugin: VaultQueryPluginContext, private sourcePath: string) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const span = createInlineSpan(view.dom.ownerDocument, INLINE_QUERY_CLASS, this.sql);

    void (async () => {
      try {
        const value = await resolveInlineQuery(this.plugin, this.sql, this.sourcePath);
        setInlineSpanValue(span, INLINE_QUERY_CLASS, value);
      }
      catch (error) {
        logger.error('Inline query failed', error);
        setInlineSpanError(span, INLINE_QUERY_CLASS, error, 'Query error');
      }
    })();

    return span;
  }

  eq(other: InlineQueryWidget): boolean {
    return this.sql === other.sql && this.sourcePath === other.sourcePath;
  }
}

export function createInlineQueryExtension(plugin: VaultQueryPluginContext) {
  return createInlineDecorationExtension({
    plugin,
    syntax: INLINE_QUERY_SYNTAX,
    createWidget: (sql, pluginContext, sourcePath) => new InlineQueryWidget(sql, pluginContext, sourcePath),
  });
}

export function processReadingViewInlineQueries(plugin: VaultQueryPluginContext, element: HTMLElement, sourcePath: string): void {
  const codeElements = element.querySelectorAll('code');

  for (const codeEl of Array.from(codeElements)) {
    if (isCodeElementInsidePre(codeEl)) continue;

    const text = codeEl.textContent?.trim();
    if (!text?.startsWith('vq{') || !text.endsWith('}')) continue;

    const sql = text.substring(3, text.length - 1).trim();
    const span = createInlineSpan(element.ownerDocument, INLINE_QUERY_CLASS, sql);

    codeEl.replaceWith(span);

    void (async () => {
      try {
        const value = await resolveInlineQuery(plugin, sql, sourcePath);
        setInlineSpanValue(span, INLINE_QUERY_CLASS, value);
      }
      catch (error) {
        logger.error('Reading view inline query failed', error);
        setInlineSpanError(span, INLINE_QUERY_CLASS, error, 'Query error');
      }
    })();
  }
}
