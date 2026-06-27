import { EditorView, WidgetType } from '@codemirror/view';
import { Notice } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { logger as rootLogger } from '../utils/logger';
import { detectDmlOperationInSql, stripSqlComments } from '../utils/SQLParsingUtils';
import { formatResultsAsMarkdown } from '../utils/ResultFormatUtils';
import { isCodeElementInsidePre } from './InlineMarkdownUtils';
import { createInlineDecorationExtension, type InlineSyntax } from './InlineDecorationUtils';
import { setButtonLoading, showQueryFailedNotice } from './InlineDomState';
import { waitForInlineVaultQueryReady } from './InlineVaultQueryReadiness';

const logger = rootLogger.scope('InlineButtons');
const INLINE_BUTTON_LOADING_CLASS = 'vaultquery-inline-button-loading';

interface InlineButtonSpec {
  label: string;
  sql: string;
  customClasses: string[];
  useDefaultStyle: boolean;
}

interface InlineButtonResult {
  applied: boolean;
  isSelect?: boolean;
  notificationOnly?: boolean;
  rowCount?: number;
}

const INLINE_BUTTON_SYNTAX: InlineSyntax<InlineButtonSpec> = {
  regex: /`vq(\.(?:[a-zA-Z_][\w-]*)?(?:\.[a-zA-Z_][\w-]*)*)?\[([^\]\n]+)\]\{([^`\n]+)\}`/g,
  parseMatch: (match) => parseButtonParts(match[1], match[2], match[3]),
};

const INLINE_BUTTON_TEXT_PATTERN = /^vq(\.(?:[a-zA-Z_][\w-]*)?(?:\.[a-zA-Z_][\w-]*)*)?\[([^\]\n]+)\]\{(.+)\}$/s;

function parseButtonParts(classesStr: string | undefined, label: string, sql: string): InlineButtonSpec {
  const hasExplicitDotSyntax = classesStr !== undefined && classesStr.startsWith('.');
  return {
    label,
    sql,
    customClasses: classesStr ? classesStr.split('.').filter(c => c.length > 0) : [],
    useDefaultStyle: !hasExplicitDotSyntax,
  };
}

function parseInlineButtonText(text: string): InlineButtonSpec | null {
  const match = text.match(INLINE_BUTTON_TEXT_PATTERN);
  return match ? parseButtonParts(match[1], match[2], match[3]) : null;
}

function getButtonClasses(spec: Pick<InlineButtonSpec, 'customClasses' | 'useDefaultStyle'>): string {
  return (spec.useDefaultStyle
    ? ['mod-cta', 'vaultquery-inline-button']
    : ['vaultquery-inline-button', ...spec.customClasses]
  ).join(' ');
}

function callsVqNotify(sql: string): boolean {
  return /\bvq_notify\s*\(/i.test(stripSqlComments(sql));
}

async function executeInlineButtonQuery(plugin: VaultQueryPluginContext, sql: string, sourcePath: string): Promise<InlineButtonResult> {
  const api = await waitForInlineVaultQueryReady(plugin);

  if (detectDmlOperationInSql(sql) === null) {
    const notificationOnly = callsVqNotify(sql);
    const results = await api.query(sql, sourcePath);
    await api.processPendingTriggerActions();

    if (notificationOnly) {
      return { applied: false, isSelect: true, notificationOnly, rowCount: results.length };
    }

    const markdown = formatResultsAsMarkdown(results, {
      includeHidden: true,
      emptyResult: '(no results)',
      emptyColumns: '(no columns)',
      newlineReplacement: ' '
    });
    await navigator.clipboard.writeText(markdown);
    return { applied: false, isSelect: true, rowCount: results.length };
  }

  const preview = await api.previewQuery(sql, [], sourcePath);
  const hasChanges = preview.sqlToApply.length > 0 ||
    preview.before.length > 0 ||
    preview.after.length > 0 ||
    (preview.multiResults?.some(r => r.sqlToApply.length > 0 || r.before.length > 0 || r.after.length > 0) ?? false);

  if (!hasChanges) {
    return { applied: false };
  }

  const affectedPaths = await api.applyPreview(preview);
  for (const path of affectedPaths) {
    plugin.indexingStateManager.queueIndexing(path);
  }

  return { applied: true };
}

function showInlineButtonResult(result: InlineButtonResult): void {
  if (result.notificationOnly) {
    if (result.rowCount === 0) {
      new Notice('No matching rows');
    }
  }
  else if (result.isSelect) {
    new Notice(`Copied ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} to clipboard`);
  }
  else if (!result.applied) {
    new Notice('No changes to apply');
  }
  else {
    new Notice('Query executed');
  }
}

function createInlineButtonElement(owner: Document, plugin: VaultQueryPluginContext, spec: InlineButtonSpec, sourcePath: string, debounce = true): HTMLButtonElement {
  const button = owner.createElement('button');
  let lastClickTime = 0;

  button.className = getButtonClasses(spec);
  button.textContent = spec.label;
  button.setAttribute('data-sql', spec.sql);
  button.setAttribute('data-source-path', sourcePath);

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (debounce) {
      const now = Date.now();
      if (now - lastClickTime < plugin.settings.inlineButtonDebounceMs) {
        return;
      }
      lastClickTime = now;
    }

    if (button.disabled) return;
    setButtonLoading(button, INLINE_BUTTON_LOADING_CLASS, true);

    void (async () => {
      try {
        showInlineButtonResult(await executeInlineButtonQuery(plugin, spec.sql, sourcePath));
      }
      catch (error) {
        showQueryFailedNotice(error);
        logger.error('Inline button query failed', error);
      } finally {
        setButtonLoading(button, INLINE_BUTTON_LOADING_CLASS, false);
      }
    })();
  });

  return button;
}

class InlineButtonWidget extends WidgetType {
  public constructor(private spec: InlineButtonSpec, private plugin: VaultQueryPluginContext, private sourcePath: string) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    return createInlineButtonElement(view.dom.ownerDocument, this.plugin, this.spec, this.sourcePath);
  }

  eq(other: InlineButtonWidget): boolean {
    return this.spec.label === other.spec.label &&
      this.spec.sql === other.spec.sql &&
      this.spec.useDefaultStyle === other.spec.useDefaultStyle &&
      this.spec.customClasses.length === other.spec.customClasses.length &&
      this.spec.customClasses.every((c, i) => c === other.spec.customClasses[i]);
  }

  ignoreEvent(event: Event): boolean {
    return ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'touchmove'].includes(event.type);
  }
}

export function createInlineButtonExtension(plugin: VaultQueryPluginContext) {
  return createInlineDecorationExtension({
    plugin,
    enabled: () => plugin.settings.enableInlineButtons && plugin.settings.allowWriteOperations,
    syntax: INLINE_BUTTON_SYNTAX,
    createWidget: (spec, pluginContext, sourcePath) => new InlineButtonWidget(spec, pluginContext, sourcePath),
  });
}

export function processReadingViewInlineButtons(plugin: VaultQueryPluginContext, element: HTMLElement, sourcePath: string): void {
  if (!plugin.settings.enableInlineButtons || !plugin.settings.allowWriteOperations) {
    return;
  }

  const codeElements = element.querySelectorAll('code');

  for (const codeEl of Array.from(codeElements)) {
    if (isCodeElementInsidePre(codeEl)) continue;

    const text = codeEl.textContent?.trim();
    if (!text) continue;

    const spec = parseInlineButtonText(text);
    if (!spec) continue;

    codeEl.replaceWith(createInlineButtonElement(element.ownerDocument, plugin, spec, sourcePath, false));
  }
}
