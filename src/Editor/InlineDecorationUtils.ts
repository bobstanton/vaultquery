import { RangeSetBuilder, EditorState } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { findCodeBlockRanges, isInsideCodeBlock } from '../utils/MarkdownFenceUtils';
import { getActiveSourcePath } from './InlineMarkdownUtils';

export interface InlineMatch<T> {
  from: number;
  to: number;
  value: T;
}

export interface InlineSyntax<T> {
  regex: RegExp;
  parseMatch: (match: RegExpExecArray) => T | null;
}

interface InlineExtensionOptions<T> {
  plugin: VaultQueryPluginContext;
  enabled?: () => boolean;
  syntax: InlineSyntax<T>;
  createWidget: (value: T, plugin: VaultQueryPluginContext, sourcePath: string) => WidgetType;
}

function findInlineMatches<T>(state: EditorState, syntax: InlineSyntax<T>, cursorPos: number): InlineMatch<T>[] {
  const matches: InlineMatch<T>[] = [];
  const text = state.doc.toString();
  const regex = new RegExp(syntax.regex.source, syntax.regex.flags.includes('g') ? syntax.regex.flags : `${syntax.regex.flags}g`);
  const rawMatches: Array<{ match: RegExpExecArray; from: number; to: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    rawMatches.push({ match, from, to });
  }

  if (rawMatches.length === 0) {
    return matches;
  }

  const codeBlockRanges = findCodeBlockRanges(text);
  for (const { match, from, to } of rawMatches) {
    if (isInsideCodeBlock(from, codeBlockRanges) || (cursorPos >= from && cursorPos <= to)) {
      continue;
    }

    const value = syntax.parseMatch(match);
    if (value) {
      matches.push({ from, to, value });
    }
  }

  return matches;
}

export function createInlineDecorationExtension<T>(options: InlineExtensionOptions<T>) {
  const { plugin } = options;

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private sourcePath = '';

      public constructor(view: EditorView) {
        this.sourcePath = getActiveSourcePath(plugin);
        this.decorations = this.buildDecorations(view, options.enabled?.() ?? true);
      }

      update(update: ViewUpdate) {
        const isEnabled = options.enabled?.() ?? true;
        if (!isEnabled) {
          this.decorations = Decoration.none;
          return;
        }

        this.sourcePath = getActiveSourcePath(plugin);
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view, isEnabled);
        }
      }

      private buildDecorations(view: EditorView, isEnabled: boolean): DecorationSet {
        if (!isEnabled || !view.state.field(editorLivePreviewField)) {
          return Decoration.none;
        }

        const builder = new RangeSetBuilder<Decoration>();
        const cursorPos = view.state.selection.main.head;
        for (const match of findInlineMatches(view.state, options.syntax, cursorPos)) {
          builder.add(match.from, match.to, Decoration.replace({
            widget: options.createWidget(match.value, plugin, this.sourcePath),
            inclusive: false,
          }));
        }
        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
