import { RangeSetBuilder, EditorState } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { editorLivePreviewField, Notice } from 'obsidian';
import type VaultQueryPlugin from '../main';

declare const activeDocument: Document;

function findCodeBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const codeBlockRegex = /^(```|~~~).*\n[\s\S]*?^\1\s*$/gm;

  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  return ranges;
}

function isInsideCodeBlock(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) {
      return true;
    }
  }
  return false;
}

// Debounce tracking across all buttons together
// Obsidian's debounce() isn't used here because it would debounce per-individual button
let lastClickTime = 0;

class InlineButtonWidget extends WidgetType {
  public constructor(private label: string, private sql: string, private plugin: VaultQueryPlugin, private sourcePath: string, private customClasses: string[] = [], private useDefaultStyle: boolean = true) {
    super();
  }

  toDOM(): HTMLElement {
    const button = activeDocument.createElement('button');
    // Use mod-cta only when no explicit class syntax was used
    // vq[Label] → mod-cta (default)
    // vq.[Label] → plain button (no mod-cta)
    // vq.foo[Label] → custom classes (no mod-cta)
    const baseClasses = this.useDefaultStyle
      ? ['mod-cta', 'vaultquery-inline-button']
      : ['vaultquery-inline-button', ...this.customClasses];
    button.className = baseClasses.join(' ');
    button.textContent = this.label;
    button.setAttribute('data-sql', this.sql);

    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const debounceMs = this.plugin.settings.inlineButtonDebounceMs;
      const now = Date.now();
      if (now - lastClickTime < debounceMs) {
        return;
      }
      lastClickTime = now;

      if (button.disabled) {
        return;
      }
      button.disabled = true;
      button.classList.add('vaultquery-inline-button-loading');

      try {
        const result = await this.executeQuery();
        
        if (result.isSelect) {
          new Notice(`Copied ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} to clipboard`);
        }
        else if (!result.applied) {
          new Notice('No changes to apply');
        }

      }

      catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Query failed: ${message}`, 5000);
        console.error('[VaultQuery InlineButton] Error:', error);
      } finally {
        button.disabled = false;
        button.classList.remove('vaultquery-inline-button-loading');
      }
    });

    return button;
  }

  private async executeQuery(): Promise<{ applied: boolean; isSelect?: boolean; rowCount?: number }> {
    const api = this.plugin.api;
    if (!api) {
      throw new Error('VaultQuery API not initialized');
    }

    await this.plugin.indexingStateManager.waitForIndexingComplete();

    const trimmedSql = this.sql.trim().toUpperCase();
    const isWriteOperation = /\b(INSERT|UPDATE|DELETE)\b/.test(trimmedSql);
    const isSelect = !isWriteOperation;

    if (isSelect) {
      const results = await api.query(this.sql, this.sourcePath);
      const markdown = this.resultsToMarkdown(results);
      await navigator.clipboard.writeText(markdown);
      return { applied: false, isSelect: true, rowCount: results.length };
    }

    const preview = await api.previewQuery(this.sql, [], this.sourcePath);

    const hasChanges = preview.sqlToApply.length > 0 ||
      preview.before.length > 0 ||
      preview.after.length > 0 ||
      (preview.multiResults && preview.multiResults.some(r =>
        r.sqlToApply.length > 0 || r.before.length > 0 || r.after.length > 0));

    if (!hasChanges) {
      return { applied: false };
    }

    const affectedPaths = await api.applyPreview(preview);

    for (const path of affectedPaths) {
      this.plugin.indexingStateManager.queueIndexing(path);
    }

    return { applied: true };
  }

  private resultsToMarkdown(results: Record<string, unknown>[]): string {
    if (results.length === 0) {
      return '(no results)';
    }

    const columns = Object.keys(results[0]);
    if (columns.length === 0) {
      return '(no columns)';
    }

    const headerRow = '| ' + columns.join(' | ') + ' |';
    const separatorRow = '| ' + columns.map(() => '---').join(' | ') + ' |';
    const dataRows = results.map(row => {
      const cells = columns.map(col => {
        const value = row[col];
        const str = value == null ? '' : String(value);
        return str.replace(/\|/g, '\\|').replace(/\n/g, ' '); //escape pipes and new lines in content
      });
      return '| ' + cells.join(' | ') + ' |';
    });

    return [headerRow, separatorRow, ...dataRows].join('\n');
  }

  eq(other: InlineButtonWidget): boolean {
    return this.label === other.label &&
      this.sql === other.sql &&
      this.useDefaultStyle === other.useDefaultStyle &&
      this.customClasses.length === other.customClasses.length &&
      this.customClasses.every((c, i) => c === other.customClasses[i]);
  }

  // Ignore mouse/touch events so clicking the button doesn't move the cursor
  // This prevents the button from being replaced with raw text when clicked
  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'mouseup' || event.type === 'click' || event.type === 'touchstart' || event.type === 'touchend' || event.type === 'touchmove';
  }
}

function findInlineButtonsByRegex(state: EditorState, plugin: VaultQueryPlugin, sourcePath: string, cursorPos: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  // eslint-disable-next-line obsidianmd/no-object-to-string -- CodeMirror Text.toString() returns document content
  const text = doc.toString();

  const codeBlockRanges = findCodeBlockRanges(text);

  // Match `vq.class1.class2[Label]{SQL}` - backtick, vq with optional classes, pattern, backtick
  // Classes are optional and can be chained: .class1.class2
  // A single dot with no class name (vq.[Label]) means plain button, don't add mod-cta
  // Must be on a single line - newlines break the pattern to avoid invalid decoration positions
  const regex = /`vq(\.(?:[a-zA-Z_][\w-]*)?(?:\.[a-zA-Z_][\w-]*)*)?\[([^\]\n]+)\]\{([^`\n]+)\}`/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const fullMatch = match[0];
    const classesStr = match[1]; // e.g., ".danger.large" or "." or undefined
    const label = match[2];
    const sql = match[3];
    const from = match.index;
    const to = from + fullMatch.length;

    const hasExplicitDotSyntax = classesStr !== undefined && classesStr.startsWith('.');
    const useDefaultStyle = !hasExplicitDotSyntax;

    // Parse classes from the dot-separated string (e.g., ".danger.large" -> ["danger", "large"])
    const customClasses = classesStr
      ? classesStr.split('.').filter(c => c.length > 0)
      : [];

    if (isInsideCodeBlock(from, codeBlockRanges)) {
      continue;
    }

    if (cursorPos >= from && cursorPos <= to) {
      continue;
    }

    const widget = new InlineButtonWidget(label, sql, plugin, sourcePath, customClasses, useDefaultStyle);
    const deco = Decoration.replace({
      widget,
      inclusive: false,
    });

    builder.add(from, to, deco);
  }

  return builder.finish();
}

export function createInlineButtonExtension(plugin: VaultQueryPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private sourcePath: string = '';

      public constructor(view: EditorView) {
        this.sourcePath = this.getSourcePath(view);
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (!plugin.settings.enableInlineButtons || !plugin.settings.allowWriteOperations) {
          this.decorations = Decoration.none;
          return;
        }

        const newSourcePath = this.getSourcePath(update.view);
        if (newSourcePath !== this.sourcePath) {
          this.sourcePath = newSourcePath;
        }

        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      private buildDecorations(view: EditorView): DecorationSet {
        if (!plugin.settings.enableInlineButtons || !plugin.settings.allowWriteOperations) {
          return Decoration.none;
        }

        const isLivePreview = view.state.field(editorLivePreviewField);
        if (!isLivePreview) {
          return Decoration.none;
        }

        const cursorPos = view.state.selection.main.head;

        return findInlineButtonsByRegex(view.state, plugin, this.sourcePath, cursorPos);
      }

      private getSourcePath(_view: EditorView): string {
        const activeFile = plugin.app.workspace.getActiveFile();
        return activeFile?.path || '';
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

/**
 * Process inline buttons in Reading View.
 * Finds code elements matching pattern: vq[Label]{SQL}
 * and replaces them with clickable buttons.
 */
export function processReadingViewInlineButtons(plugin: VaultQueryPlugin, element: HTMLElement, sourcePath: string): void {
  // Skip if inline buttons are disabled or write operations are disabled
  if (!plugin.settings.enableInlineButtons || !plugin.settings.allowWriteOperations) {
    return;
  }

  // Pattern: vq[Label]{SQL} - matches inline code containing this syntax
  const pattern = /^vq\[([^\]]+)\]\{(.+)\}$/s;

  const codeElements = element.querySelectorAll('code');

  for (const codeEl of Array.from(codeElements)) {
    const text = codeEl.textContent?.trim();
    if (!text) continue;

    const match = text.match(pattern);
    if (!match) continue;

    const label = match[1];
    const sql = match[2];

    const button = activeDocument.createElement('button');
    button.className = 'vaultquery-inline-button';
    button.textContent = label;
    button.setAttribute('data-sql', sql);
    button.setAttribute('data-source-path', sourcePath);

    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (button.disabled) return;
      button.disabled = true;
      button.classList.add('vaultquery-inline-button-loading');

      try {
        await executeReadingViewQuery(plugin, sql, sourcePath);
        new Notice('Query executed successfully');
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Query failed: ${message}`, 5000);
        console.error('[VaultQuery] Reading view inline button error:', error);
      } finally {
        button.disabled = false;
        button.classList.remove('vaultquery-inline-button-loading');
      }
    });

    codeEl.replaceWith(button);
  }
}

/**
 * Execute an inline query in Reading View without preview.
 */
async function executeReadingViewQuery(plugin: VaultQueryPlugin, sql: string, sourcePath: string): Promise<void> {
  const api = plugin.api;
  if (!api) {
    throw new Error('VaultQuery API not initialized');
  }

  const preview = await api.previewQuery(sql, [], sourcePath);

  const hasChanges = preview.before.length > 0 || preview.after.length > 0 ||
    (preview.multiResults && preview.multiResults.some(r => r.before.length > 0 || r.after.length > 0));

  if (!hasChanges) {
    new Notice('No changes to apply');
    return;
  }

  const affectedPaths = await api.applyPreview(preview);

  for (const path of affectedPaths) {
    plugin.indexingStateManager.queueIndexing(path);
  }
}
