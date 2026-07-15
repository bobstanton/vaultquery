import { EditorView, WidgetType } from '@codemirror/view';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { detectDmlOperationInSql } from '../utils/SQLParsingUtils';
import { logger as rootLogger } from '../utils/logger';
import { scalarFromResults } from '../utils/ResultFormatUtils';
import { processReadingViewInlineCode } from './InlineMarkdownUtils';
import { createInlineDecorationExtension } from './InlineDecorationUtils';
import type { InlineSyntax } from './InlineDecorationUtils';
import { createInlineSpan, setInlineSpanError, setInlineSpanValue } from './InlineDomState';
import { waitForInlineVaultQueryReady } from './InlineVaultQueryReadiness';

const logger = rootLogger.scope('InlineQueries');
const INLINE_QUERY_CLASS = 'vaultquery-inline-query';
const INLINE_QUERY_SYNTAX: InlineSyntax<string> = {
  regex: /`vq\{([^`\n]+)\}`/g,
  parseMatch: (match) => match[1].trim(),
};

function parseInlineQueryText(text: string): string | null {
  const match = text.match(/^vq\{([^`\n]+)\}$/);
  return match?.[1].trim() || null;
}

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

function createInlineQueryElement(owner: Document, plugin: VaultQueryPluginContext, sql: string, sourcePath: string, errorLabel: string): HTMLElement {
  const span = createInlineSpan(owner, INLINE_QUERY_CLASS, sql);

  void (async () => {
    try {
      const value = await resolveInlineQuery(plugin, sql, sourcePath);
      setInlineSpanValue(span, INLINE_QUERY_CLASS, value);
    }
    catch (error) {
      logger.error('Inline query failed', error);
      setInlineSpanError(span, INLINE_QUERY_CLASS, error, errorLabel);
    }
  })();

  return span;
}

class InlineQueryWidget extends WidgetType {
  public constructor(private sql: string, private plugin: VaultQueryPluginContext, private sourcePath: string) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    return createInlineQueryElement(view.dom.ownerDocument, this.plugin, this.sql, this.sourcePath, 'Query error');
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
  processReadingViewInlineCode(element, (text) => {
    const sql = parseInlineQueryText(text);
    return sql ? createInlineQueryElement(element.ownerDocument, plugin, sql, sourcePath, 'Query error') : null;
  });
}
