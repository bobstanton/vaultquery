import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, EditorState, Transaction, Prec } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { PROVIDER_DEFINITION_LANGUAGES, VAULTQUERY_LANGUAGES } from '../Constants/EditorConstants';

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
  'like', 'between', 'exists', 'case', 'when', 'then', 'else', 'end',
  'as', 'on', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full',
  'union', 'all', 'distinct', 'group', 'by', 'having', 'order', 'asc', 'desc',
  'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'create', 'table', 'drop', 'alter', 'index', 'primary', 'key', 'foreign',
  'references', 'constraint', 'default', 'check', 'unique', 'cascade',
  'with', 'recursive', 'over', 'partition', 'row', 'rows', 'range',
  'preceding', 'following', 'unbounded', 'current', 'first', 'last',
  'nulls', 'filter', 'window', 'lateral', 'natural', 'using',
]);

const SQL_FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'cast',
  'substr', 'substring', 'length', 'upper', 'lower', 'trim', 'ltrim', 'rtrim',
  'replace', 'instr', 'printf', 'typeof', 'abs', 'round', 'random',
  'date', 'time', 'datetime', 'julianday', 'strftime', 'now',
  'ifnull', 'iif', 'glob', 'hex', 'quote', 'zeroblob',
  'total', 'group_concat', 'json', 'json_extract', 'json_array', 'json_object',
]);

const SQL_TYPES = new Set([
  'integer', 'int', 'real', 'text', 'blob', 'numeric', 'boolean', 'varchar',
  'char', 'float', 'double', 'decimal', 'date', 'datetime', 'timestamp',
]);

const SQL_OPERATORS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '||', '+', '-', '*', '/', '%']);

const JS_KEYWORDS = new Set([
  'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'function', 'async', 'await',
  'try', 'catch', 'finally', 'throw', 'new', 'this', 'class', 'extends',
  'import', 'export', 'default', 'typeof', 'instanceof', 'in', 'of',
  'true', 'false', 'null', 'undefined', 'void',
]);

const JS_BUILTINS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Date', 'Map', 'Set', 'Promise', 'Error',
  'results', 'count', 'columns', 'h',
]);

const keywordMark = Decoration.mark({ class: 'cm-keyword' });
const functionMark = Decoration.mark({ class: 'cm-variableName cm-function' });
const typeMark = Decoration.mark({ class: 'cm-typeName' });
const stringMark = Decoration.mark({ class: 'cm-string' });
const numberMark = Decoration.mark({ class: 'cm-number' });
const operatorMark = Decoration.mark({ class: 'cm-operator' });
const commentMark = Decoration.mark({ class: 'cm-comment' });
const propertyMark = Decoration.mark({ class: 'cm-propertyName' });
const labelMark = Decoration.mark({ class: 'cm-meta' });
const noSpellcheckMark = Decoration.mark({
  attributes: {
    spellcheck: 'false',
    autocorrect: 'off',
    autocapitalize: 'off',
    'data-vaultquery-codeblock-text': 'true',
  }
});
const codeBlockLineMark = Decoration.line({
  attributes: {
    spellcheck: 'false',
    autocorrect: 'off',
    autocapitalize: 'off',
    'data-vaultquery-codeblock-line': 'true',
  }
});

interface TokenSink {
  add(start: number, end: number, mark: Decoration): void;
}

function builderTokenSink(baseOffset: number, builder: RangeSetBuilder<Decoration>): TokenSink {
  return {
    add: (start, end, mark) => builder.add(baseOffset + start, baseOffset + end, mark)
  };
}

interface DecorationRange {
  from: number;
  to: number;
  mark: Decoration;
}

function rangeTokenSink(baseOffset: number, ranges: DecorationRange[]): TokenSink {
  return {
    add: (start, end, mark) => ranges.push({ from: baseOffset + start, to: baseOffset + end, mark })
  };
}

function skipWhitespace(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  return pos;
}

function consumeLineComment(text: string, pos: number): number {
  while (pos < text.length && text[pos] !== '\n') pos++;
  return pos;
}

function consumeBlockComment(text: string, pos: number): number {
  pos += 2;
  while (pos < text.length - 1 && !(text[pos] === '*' && text[pos + 1] === '/')) pos++;
  return Math.min(pos + 2, text.length);
}

function consumeEscapedString(text: string, pos: number, quote: string): number {
  pos++;
  while (pos < text.length) {
    if (text[pos] === '\\' && pos + 1 < text.length) {
      pos += 2;
    }
    else if (text[pos] === quote) {
      pos++;
      break;
    }
    else {
      pos++;
    }
  }
  return pos;
}

function consumeSqlSingleQuotedString(text: string, pos: number): number {
  pos++;
  while (pos < text.length) {
    if (text[pos] === "'" && text[pos + 1] === "'") {
      pos += 2;
    }
    else if (text[pos] === "'") {
      pos++;
      break;
    }
    else {
      pos++;
    }
  }
  return pos;
}

function consumeUntilChar(text: string, pos: number, terminator: string): number {
  pos++;
  while (pos < text.length && text[pos] !== terminator) pos++;
  return Math.min(pos + 1, text.length);
}

function consumeWhile(text: string, pos: number, pattern: RegExp): number {
  while (pos < text.length && pattern.test(text[pos])) pos++;
  return pos;
}

function tokenizeComment(text: string, pos: number, sink: TokenSink, linePrefix: string): number | null {
  if (text.startsWith(linePrefix, pos)) {
    const end = consumeLineComment(text, pos);
    sink.add(pos, end, commentMark);
    return end;
  }

  if (text[pos] === '/' && text[pos + 1] === '*') {
    const end = consumeBlockComment(text, pos);
    sink.add(pos, end, commentMark);
    return end;
  }

  return null;
}

function addJsIdentifier(text: string, start: number, end: number, sink: TokenSink): void {
  const word = text.slice(start, end);

  if (JS_KEYWORDS.has(word)) {
    sink.add(start, end, keywordMark);
  }
  else if (JS_BUILTINS.has(word)) {
    sink.add(start, end, typeMark);
  }
  else {
    const lookAhead = skipWhitespace(text, end);
    sink.add(start, end, text[lookAhead] === '(' ? functionMark : propertyMark);
  }
}

function addSqlIdentifier(text: string, start: number, end: number, sink: TokenSink): void {
  const lowerWord = text.slice(start, end).toLowerCase();

  if (SQL_KEYWORDS.has(lowerWord)) {
    sink.add(start, end, keywordMark);
  }
  else if (SQL_FUNCTIONS.has(lowerWord)) {
    sink.add(start, end, functionMark);
  }
  else if (SQL_TYPES.has(lowerWord)) {
    sink.add(start, end, typeMark);
  }
  else {
    sink.add(start, end, propertyMark);
  }
}

type TokenRule = (text: string, pos: number, sink: TokenSink) => number | null;

function tokenizeCharacterStream(text: string, sink: TokenSink, rules: TokenRule[]): void {
  let pos = 0;

  while (pos < text.length) {
    if (/\s/.test(text[pos])) {
      pos++;
      continue;
    }

    const next = rules.reduce<number | null>((matched, rule) => matched ?? rule(text, pos, sink), null);
    pos = next ?? pos + 1;
  }
}

function commentRule(linePrefix: string): TokenRule {
  return (text, pos, sink) => tokenizeComment(text, pos, sink, linePrefix);
}

function numberOrIdentifierRule(isNumberStart: (text: string, pos: number) => boolean, numberPattern: RegExp, identifierStartPattern: RegExp, identifierPattern: RegExp, addIdentifier: (text: string, start: number, end: number, sink: TokenSink) => void): TokenRule {
  return (text, pos, sink) => {
    const char = text[pos];

    if (isNumberStart(text, pos)) {
      const start = pos;
      const end = consumeWhile(text, pos, numberPattern);
      sink.add(start, end, numberMark);
      return end;
    }

    if (identifierStartPattern.test(char)) {
      const start = pos;
      const end = consumeWhile(text, pos, identifierPattern);
      addIdentifier(text, start, end, sink);
      return end;
    }

    return null;
  };
}

function tokenizeSql(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  tokenizeCharacterStream(text, builderTokenSink(baseOffset, builder), [
    commentRule('--'),
    (source, pos, sink) => {
      if (source[pos] !== "'") return null;
      const start = pos;
      const end = consumeSqlSingleQuotedString(source, pos);
      sink.add(start, end, stringMark);
      return end;
    },
    (source, pos, sink) => {
      if (source[pos] !== '"') return null;
      const start = pos;
      const end = consumeUntilChar(source, pos, '"');
      sink.add(start, end, propertyMark);
      return end;
    },
    numberOrIdentifierRule((source, pos) => /\d/.test(source[pos]) || (source[pos] === '.' && /\d/.test(source[pos + 1] || '')), /[\d.eE+-]/, /[a-zA-Z_]/, /[a-zA-Z0-9_]/, addSqlIdentifier),
    (source, pos, sink) => {
      if (source[pos] !== '{' || source[pos + 1] !== '{') return null;
      const start = pos;
      pos += 2;
      while (pos < source.length - 1 && !(source[pos] === '}' && source[pos + 1] === '}')) pos++;
      pos = Math.min(pos + 2, source.length);
      sink.add(start, pos, stringMark);
      return pos;
    },
    (source, pos, sink) => {
      if (!SQL_OPERATORS.has(source[pos])) return null;
      const start = pos;
      const twoChar = source.slice(pos, pos + 2);
      if (SQL_OPERATORS.has(twoChar)) {
        pos += 2;
      }
      else {
        pos++;
      }
      sink.add(start, pos, operatorMark);
      return pos;
    }
  ]);
}

function tokenizeJavaScriptCollect(text: string, baseOffset: number, ranges: DecorationRange[]): void {
  tokenizeJavaScriptTokens(text, rangeTokenSink(baseOffset, ranges), false);
}

function tokenizeJavaScriptTokens(text: string, sink: TokenSink, parseTemplates: boolean): void {
  const templateRule: TokenRule = (source, pos, tokenSink) => {
    if (!parseTemplates || source[pos] !== '`') return null;
    return tokenizeTemplateString(source, pos, tokenSink);
  };

  tokenizeCharacterStream(text, sink, [
    commentRule('//'),
    templateRule,
    (source, pos, tokenSink) => {
      const quote = source[pos];
      if (quote !== "'" && quote !== '"' && quote !== '`') return null;
      const start = pos;
      const end = consumeEscapedString(source, pos, quote);
      tokenSink.add(start, end, stringMark);
      return end;
    },
    numberOrIdentifierRule((source, pos) => /\d/.test(source[pos]), /[\d.eExXa-fA-F_]/, /[a-zA-Z_$]/, /[a-zA-Z0-9_$]/, addJsIdentifier),
    (source, pos, tokenSink) => {
      if (source[pos] === '=' && source[pos + 1] === '>') {
        tokenSink.add(pos, pos + 2, operatorMark);
        return pos + 2;
      }

      if (!/[+\-*/%=<>!&|?:.]/.test(source[pos])) return null;
      const start = pos;
      pos++;
      while (pos < source.length && /[+\-*/%=<>!&|?:]/.test(source[pos])) pos++;
      tokenSink.add(start, pos, operatorMark);
      return pos;
    }
  ]);
}

function tokenizeTemplateString(text: string, pos: number, sink: TokenSink): number {
  const len = text.length;
  const templateRanges: Array<{ from: number; to: number; mark: Decoration }> = [];
  let stringStart = pos;
  pos++;

  while (pos < len) {
    if (text[pos] === '\\' && pos + 1 < len) {
      pos += 2;
    }
    else if (text[pos] === '$' && text[pos + 1] === '{') {
      if (pos > stringStart) {
        templateRanges.push({ from: stringStart, to: pos, mark: stringMark });
      }
      templateRanges.push({ from: pos, to: pos + 2, mark: operatorMark });
      pos += 2;

      let braceDepth = 1;
      const exprStart = pos;
      while (pos < len && braceDepth > 0) {
        if (text[pos] === '{') braceDepth++;
        else if (text[pos] === '}') braceDepth--;
        if (braceDepth > 0) pos++;
      }

      if (pos > exprStart) {
        const exprRanges: DecorationRange[] = [];
        tokenizeJavaScriptCollect(text.slice(exprStart, pos), exprStart, exprRanges);
        templateRanges.push(...exprRanges.map(r => ({ from: r.from, to: r.to, mark: r.mark })));
      }

      if (pos < len && text[pos] === '}') {
        templateRanges.push({ from: pos, to: pos + 1, mark: operatorMark });
        pos++;
      }
      stringStart = pos;
    }
    else if (text[pos] === '`') {
      pos++;
      if (pos > stringStart) {
        templateRanges.push({ from: stringStart, to: pos, mark: stringMark });
      }
      break;
    }
    else {
      pos++;
    }
  }

  templateRanges.sort((a, b) => a.from - b.from);
  for (const range of templateRanges) {
    sink.add(range.from, range.to, range.mark);
  }
  return pos;
}

function tokenizeJavaScript(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  tokenizeJavaScriptTokens(text, builderTokenSink(baseOffset, builder), true);
}

const CHART_TYPE_VALUES = new Set([
  'bar', 'line', 'pie', 'doughnut', 'scatter',
]);

interface YamlEntry {
  key: string;
  keyStart: number;
  keyEnd: number;
  colonIndex: number;
  value: string;
  valueStart: number;
}

function parseYamlEntry(text: string): YamlEntry | null {
  const colonIndex = text.indexOf(':');
  if (colonIndex === -1) return null;

  let keyStart = 0;
  while (keyStart < colonIndex && /\s/.test(text[keyStart])) keyStart++;
  const keyEnd = colonIndex;
  const key = text.slice(keyStart, keyEnd).trim().toLowerCase();

  let valueStart = colonIndex + 1;
  while (valueStart < text.length && /\s/.test(text[valueStart])) valueStart++;
  const value = text.slice(valueStart).trim();

  return { key, keyStart, keyEnd, colonIndex, value, valueStart };
}

function addYamlEntryScaffold(entry: YamlEntry, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  if (entry.keyStart < entry.keyEnd) {
    builder.add(baseOffset + entry.keyStart, baseOffset + entry.keyEnd, propertyMark);
  }

  builder.add(baseOffset + entry.colonIndex, baseOffset + entry.colonIndex + 1, operatorMark);
}

function addYamlValue(entry: YamlEntry, baseOffset: number, builder: RangeSetBuilder<Decoration>, mark: Decoration): void {
  builder.add(baseOffset + entry.valueStart, baseOffset + entry.valueStart + entry.value.length, mark);
}

function tokenizeYamlConfig(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  const entry = parseYamlEntry(text);
  if (!entry) return;

  addYamlEntryScaffold(entry, baseOffset, builder);
  if (!entry.value) return;

  if (entry.key === 'type' && CHART_TYPE_VALUES.has(entry.value.toLowerCase())) {
    addYamlValue(entry, baseOffset, builder, keywordMark);
  }
  else if (/^\d+(\.\d+)?$/.test(entry.value)) {
    addYamlValue(entry, baseOffset, builder, numberMark);
  }
  else {
    addYamlValue(entry, baseOffset, builder, stringMark);
  }
}

function tokenizeGenericYamlConfig(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  const entry = parseYamlEntry(text);
  if (!entry) return;

  addYamlEntryScaffold(entry, baseOffset, builder);
  if (!entry.value) return;

  if (/^(true|false|yes|no)$/i.test(entry.value)) {
    addYamlValue(entry, baseOffset, builder, keywordMark);
  }
  else if (/^\d+(\.\d+)?$/.test(entry.value)) {
    addYamlValue(entry, baseOffset, builder, numberMark);
  }
  else if (/^rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}$/.test(entry.value)) {
    addYamlValue(entry, baseOffset, builder, stringMark);
  }
  else {
    addYamlValue(entry, baseOffset, builder, stringMark);
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  let currentBlock: { language: string; contentStart: number; lines: Array<{ from: number; to: number }> } | null = null;

  const tree = syntaxTree(view.state);

  tree.iterate({
    enter: (node: { name: string; from: number; to: number }) => {
      if (node.name.includes('HyperMD-codeblock-begin')) {
        const lineText = doc.sliceString(node.from, node.to);
        const match = lineText.match(/^```(\S+)/);
        if (match && VAULTQUERY_LANGUAGES.has(match[1])) {
          currentBlock = {
            language: match[1],
            contentStart: node.to + 1, 
            lines: []
          };
        }
        else {
          currentBlock = null;
        }
        return;
      }

      if (node.name.includes('HyperMD-codeblock-end')) {
        if (currentBlock && currentBlock.lines.length > 0) {
          const isProviderDefinitionBlock = PROVIDER_DEFINITION_LANGUAGES.has(currentBlock.language);
          const isConfigCapableBlock = currentBlock.language === 'vaultquery' ||
            currentBlock.language === 'vaultquery-chart' ||
            currentBlock.language === 'vaultquery-markdown' ||
            currentBlock.language === 'vaultquery-calendar';
          const isQueryBlock = currentBlock.language === 'vaultquery';

          let inTemplate = false;
          let inConfig = false;

          for (const line of currentBlock.lines) {
            const content = doc.sliceString(line.from, line.to);
            const trimmed = content.trim();
            builder.add(line.from, line.from, codeBlockLineMark);
            if (line.from < line.to) {
              builder.add(line.from, line.to, noSpellcheckMark);
            }

            if (isProviderDefinitionBlock) {
              tokenizeGenericYamlConfig(content, line.from, builder);
              continue;
            }

            if (isConfigCapableBlock && trimmed.startsWith('config:')) {
              const configStart = content.indexOf('config:');
              builder.add(line.from + configStart, line.from + configStart + 7, labelMark);
              inConfig = true;
              continue;
            }

            if (inConfig) {
              tokenizeYamlConfig(content, line.from, builder);
              continue;
            }

            if (isQueryBlock && trimmed.startsWith('template:')) {
              const templateStart = content.indexOf('template:');
              builder.add(line.from + templateStart, line.from + templateStart + 9, labelMark);

              const afterTemplate = content.slice(templateStart + 9);
              if (afterTemplate.trim()) {
                tokenizeJavaScript(afterTemplate, line.from + templateStart + 9, builder);
              }
              inTemplate = true;
              continue;
            }

            if (inTemplate) {
              tokenizeJavaScript(content, line.from, builder);
            }
            else {
              tokenizeSql(content, line.from, builder);
            }
          }
        }
        currentBlock = null;
        return;
      }

      if (currentBlock && node.name === 'hmd-codeblock') {
        currentBlock.lines.push({ from: node.from, to: node.to });
      }
    },
  });

  return builder.finish();
}

export const sqlHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    public constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

const vaultQueryEditorAttributes = Prec.highest(EditorView.editorAttributes.of({
  spellcheck: 'false',
}));

const vaultQueryContentAttributes = Prec.highest(EditorView.contentAttributes.of({
  spellcheck: 'false',
  autocorrect: 'off',
  autocapitalize: 'off',
  writingsuggestions: 'false',
  translate: 'no',
}));

export const vaultQueryEditorAttributesExtension = [
  vaultQueryEditorAttributes,
  vaultQueryContentAttributes,
];

function isInsideVaultqueryBlock(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  const doc = state.doc;

  let node: SyntaxNode | null = tree.resolveInner(pos, -1);

  while (node) {
    if (node.name.includes('HyperMD-codeblock')) {
      let searchNode: SyntaxNode | null = node;
      while (searchNode?.prevSibling) {
        searchNode = searchNode.prevSibling;
        if (searchNode.name.includes('HyperMD-codeblock-begin')) {
          const lineText = doc.sliceString(searchNode.from, searchNode.to);
          const match = lineText.match(/^```(\S+)/);
          if (match && VAULTQUERY_LANGUAGES.has(match[1])) {
            return true;
          }
          return false;
        }
        if (searchNode.name.includes('HyperMD-codeblock-end')) {
          return false;
        }
      }
    }
    node = node.parent;
  }

  return false;
}

export const disableAutoPairInVaultquery = EditorState.transactionFilter.of((tr: Transaction) => {
  if (!tr.isUserEvent('input.type')) {
    return tr;
  }

  let hasAutoPairedAsterisk = false;
  let asteriskInsertPos = -1;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const insertedText = inserted.toString();
    if (insertedText === '**' && fromA === toA) {
      hasAutoPairedAsterisk = true;
      asteriskInsertPos = fromA;
    }
  });

  if (!hasAutoPairedAsterisk || asteriskInsertPos < 0) {
    return tr;
  }

  if (isInsideVaultqueryBlock(tr.startState, asteriskInsertPos)) {
    return {
      changes: { from: asteriskInsertPos, to: asteriskInsertPos, insert: '*' },
      selection: { anchor: asteriskInsertPos + 1 }
    };
  }

  return tr;
});
