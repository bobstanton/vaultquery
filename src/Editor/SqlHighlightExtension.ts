import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, EditorState, Transaction } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { VAULTQUERY_LANGUAGES } from '../Constants/EditorConstants';

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

function tokenizeSql(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const char = text[pos];

    if (/\s/.test(char)) {
      pos++;
      continue;
    }

    if (char === '-' && text[pos + 1] === '-') {
      const start = pos;
      while (pos < len && text[pos] !== '\n') pos++;
      builder.add(baseOffset + start, baseOffset + pos, commentMark);
      continue;
    }

    if (char === '/' && text[pos + 1] === '*') {
      const start = pos;
      pos += 2;
      while (pos < len - 1 && !(text[pos] === '*' && text[pos + 1] === '/')) pos++;
      pos += 2;
      builder.add(baseOffset + start, baseOffset + pos, commentMark);
      continue;
    }

    if (char === "'") {
      const start = pos;
      pos++;
      while (pos < len) {
        if (text[pos] === "'" && text[pos + 1] === "'") {
          pos += 2; // Escaped quote
        }
        else if (text[pos] === "'") {
          pos++;
          break;
        }
        else {
          pos++;
        }
      }
      builder.add(baseOffset + start, baseOffset + pos, stringMark);
      continue;
    }

    if (char === '"') {
      const start = pos;
      pos++;
      while (pos < len && text[pos] !== '"') pos++;
      pos++;
      builder.add(baseOffset + start, baseOffset + pos, propertyMark);
      continue;
    }

    if (/\d/.test(char) || (char === '.' && /\d/.test(text[pos + 1] || ''))) {
      const start = pos;
      while (pos < len && /[\d.eE+-]/.test(text[pos])) pos++;
      builder.add(baseOffset + start, baseOffset + pos, numberMark);
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      const start = pos;
      while (pos < len && /[a-zA-Z0-9_]/.test(text[pos])) pos++;
      const word = text.slice(start, pos);
      const lowerWord = word.toLowerCase();

      if (SQL_KEYWORDS.has(lowerWord)) {
        builder.add(baseOffset + start, baseOffset + pos, keywordMark);
      }
      else if (SQL_FUNCTIONS.has(lowerWord)) {
        builder.add(baseOffset + start, baseOffset + pos, functionMark);
      }
      else if (SQL_TYPES.has(lowerWord)) {
        builder.add(baseOffset + start, baseOffset + pos, typeMark);
      }
      else {
        builder.add(baseOffset + start, baseOffset + pos, propertyMark);
      }
      continue;
    }

    if (char === '{' && text[pos + 1] === '{') {
      const start = pos;
      pos += 2;
      while (pos < len - 1 && !(text[pos] === '}' && text[pos + 1] === '}')) pos++;
      pos += 2;
      builder.add(baseOffset + start, baseOffset + pos, stringMark);
      continue;
    }

    if (SQL_OPERATORS.has(char)) {
      const start = pos;
      const twoChar = text.slice(pos, pos + 2);
      if (SQL_OPERATORS.has(twoChar)) {
        pos += 2;
      }
      else {
        pos++;
      }
      builder.add(baseOffset + start, baseOffset + pos, operatorMark);
      continue;
    }

    pos++;
  }
}

interface DecorationRange {
  from: number;
  to: number;
  mark: Decoration;
}

function tokenizeJavaScriptCollect(text: string, baseOffset: number, ranges: DecorationRange[]): void {
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const char = text[pos];

    if (/\s/.test(char)) {
      pos++;
      continue;
    }

    if (char === '/' && text[pos + 1] === '/') {
      const start = pos;
      while (pos < len && text[pos] !== '\n') pos++;
      ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: commentMark });
      continue;
    }

    if (char === '/' && text[pos + 1] === '*') {
      const start = pos;
      pos += 2;
      while (pos < len - 1 && !(text[pos] === '*' && text[pos + 1] === '/')) pos++;
      pos += 2;
      ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: commentMark });
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      const start = pos;
      pos++;
      while (pos < len) {
        if (text[pos] === '\\' && pos + 1 < len) {
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
      ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: stringMark });
      continue;
    }

    if (/\d/.test(char)) {
      const start = pos;
      while (pos < len && /[\d.eExXa-fA-F_]/.test(text[pos])) pos++;
      ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: numberMark });
      continue;
    }

    if (/[a-zA-Z_$]/.test(char)) {
      const start = pos;
      while (pos < len && /[a-zA-Z0-9_$]/.test(text[pos])) pos++;
      const word = text.slice(start, pos);

      if (JS_KEYWORDS.has(word)) {
        ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: keywordMark });
      }
      else if (JS_BUILTINS.has(word)) {
        ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: typeMark });
      }
      else {
        let lookAhead = pos;
        while (lookAhead < len && /\s/.test(text[lookAhead])) lookAhead++;
        if (text[lookAhead] === '(') {
          ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: functionMark });
        }
        else {
          ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: propertyMark });
        }
      }
      continue;
    }

    if (char === '=' && text[pos + 1] === '>') {
      ranges.push({ from: baseOffset + pos, to: baseOffset + pos + 2, mark: operatorMark });
      pos += 2;
      continue;
    }

    if (/[+\-*/%=<>!&|?:.]/.test(char)) {
      const start = pos;
      pos++;
      while (pos < len && /[+\-*/%=<>!&|?:]/.test(text[pos])) pos++;
      ranges.push({ from: baseOffset + start, to: baseOffset + pos, mark: operatorMark });
      continue;
    }

    pos++;
  }
}

function tokenizeJavaScript(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const char = text[pos];

    if (/\s/.test(char)) {
      pos++;
      continue;
    }

    if (char === '/' && text[pos + 1] === '/') {
      const start = pos;
      while (pos < len && text[pos] !== '\n') pos++;
      builder.add(baseOffset + start, baseOffset + pos, commentMark);
      continue;
    }

    if (char === '/' && text[pos + 1] === '*') {
      const start = pos;
      pos += 2;
      while (pos < len - 1 && !(text[pos] === '*' && text[pos + 1] === '/')) pos++;
      pos += 2;
      builder.add(baseOffset + start, baseOffset + pos, commentMark);
      continue;
    }

    if (char === '`') {
      const templateRanges: Array<{ from: number; to: number; mark: Decoration }> = [];
      let stringStart = pos;
      pos++; 

      while (pos < len) {
        if (text[pos] === '\\' && pos + 1 < len) {
          pos += 2; 
        }
        else if (text[pos] === '$' && text[pos + 1] === '{') {
          // Add string segment before ${
          if (pos > stringStart) {
            templateRanges.push({ from: baseOffset + stringStart, to: baseOffset + pos, mark: stringMark });
          }
          // Add ${ operator
          templateRanges.push({ from: baseOffset + pos, to: baseOffset + pos + 2, mark: operatorMark });
          pos += 2;

          // Find matching } and collect interpolation content
          let braceDepth = 1;
          const exprStart = pos;
          while (pos < len && braceDepth > 0) {
            if (text[pos] === '{') braceDepth++;
            else if (text[pos] === '}') braceDepth--;
            if (braceDepth > 0) pos++;
          }

          if (pos > exprStart) {
            const exprRanges: Array<{ from: number; to: number; mark: Decoration }> = [];
            tokenizeJavaScriptCollect(text.slice(exprStart, pos), baseOffset + exprStart, exprRanges);
            templateRanges.push(...exprRanges);
          }

          // Add closing }
          if (pos < len && text[pos] === '}') {
            templateRanges.push({ from: baseOffset + pos, to: baseOffset + pos + 1, mark: operatorMark });
            pos++;
          }

          // Start new string segment
          stringStart = pos;
        }
        else if (text[pos] === '`') {
          // Add final string segment including closing backtick
          pos++;
          if (pos > stringStart) {
            templateRanges.push({ from: baseOffset + stringStart, to: baseOffset + pos, mark: stringMark });
          }
          break;
        }
        else {
          pos++;
        }
      }

      templateRanges.sort((a, b) => a.from - b.from);
      for (const range of templateRanges) {
        builder.add(range.from, range.to, range.mark);
      }
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      const start = pos;
      pos++;
      while (pos < len) {
        if (text[pos] === '\\' && pos + 1 < len) {
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
      builder.add(baseOffset + start, baseOffset + pos, stringMark);
      continue;
    }

    if (/\d/.test(char)) {
      const start = pos;
      while (pos < len && /[\d.eExXa-fA-F_]/.test(text[pos])) pos++;
      builder.add(baseOffset + start, baseOffset + pos, numberMark);
      continue;
    }

    if (/[a-zA-Z_$]/.test(char)) {
      const start = pos;
      while (pos < len && /[a-zA-Z0-9_$]/.test(text[pos])) pos++;
      const word = text.slice(start, pos);

      if (JS_KEYWORDS.has(word)) {
        builder.add(baseOffset + start, baseOffset + pos, keywordMark);
      }
      else if (JS_BUILTINS.has(word)) {
        builder.add(baseOffset + start, baseOffset + pos, typeMark);
      }
      else {
        let lookAhead = pos;
        while (lookAhead < len && /\s/.test(text[lookAhead])) lookAhead++;
        if (text[lookAhead] === '(') {
          builder.add(baseOffset + start, baseOffset + pos, functionMark);
        }
        else {
          builder.add(baseOffset + start, baseOffset + pos, propertyMark);
        }
      }
      continue;
    }

    if (char === '=' && text[pos + 1] === '>') {
      builder.add(baseOffset + pos, baseOffset + pos + 2, operatorMark);
      pos += 2;
      continue;
    }

    if (/[+\-*/%=<>!&|?:.]/.test(char)) {
      const start = pos;
      pos++;
      while (pos < len && /[+\-*/%=<>!&|?:]/.test(text[pos])) pos++;
      builder.add(baseOffset + start, baseOffset + pos, operatorMark);
      continue;
    }

    pos++;
  }
}

const CHART_CONFIG_KEYS = new Set([
  'type', 'title', 'xlabel', 'ylabel', 'datasetlabel',
  'datasetbackgroundcolor', 'datasetbordercolor',
  'xLabel', 'yLabel', 'datasetLabel', 'datasetBackgroundColor', 'datasetBorderColor',
]);

const CHART_TYPE_VALUES = new Set([
  'bar', 'line', 'pie', 'doughnut', 'scatter',
]);

function tokenizeYamlConfig(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  const colonIndex = text.indexOf(':');
  if (colonIndex === -1) return;

  let keyStart = 0;
  while (keyStart < colonIndex && /\s/.test(text[keyStart])) keyStart++;
  const keyEnd = colonIndex;
  const key = text.slice(keyStart, keyEnd).trim().toLowerCase();

  if (key && CHART_CONFIG_KEYS.has(key)) {
    builder.add(baseOffset + keyStart, baseOffset + keyEnd, propertyMark);
  }
  else if (key) {
    builder.add(baseOffset + keyStart, baseOffset + keyEnd, propertyMark);
  }

  builder.add(baseOffset + colonIndex, baseOffset + colonIndex + 1, operatorMark);

  let valueStart = colonIndex + 1;
  while (valueStart < text.length && /\s/.test(text[valueStart])) valueStart++;
  const valueEnd = text.length;
  const value = text.slice(valueStart, valueEnd).trim();

  if (!value) return;

  if (key === 'type' && CHART_TYPE_VALUES.has(value.toLowerCase())) {
    builder.add(baseOffset + valueStart, baseOffset + valueStart + value.length, keywordMark);
  }
  else if (/^\d+(\.\d+)?$/.test(value)) {
    builder.add(baseOffset + valueStart, baseOffset + valueStart + value.length, numberMark);
  }
  else {
    builder.add(baseOffset + valueStart, baseOffset + valueStart + value.length, stringMark);
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
          const isChartBlock = currentBlock.language === 'vaultquery-chart';
          const isQueryBlock = currentBlock.language === 'vaultquery';

          let inTemplate = false;
          let inConfig = false;
          let inChartYamlHeader = isChartBlock;

          for (const line of currentBlock.lines) {
            const content = doc.sliceString(line.from, line.to);
            const trimmed = content.trim();
            const trimmedUpper = trimmed.toUpperCase();

            if (isChartBlock && trimmed.startsWith('config:')) {
              const configStart = content.indexOf('config:');
              builder.add(line.from + configStart, line.from + configStart + 7, labelMark);
              inConfig = true;
              inChartYamlHeader = false; // No longer in header
              continue;
            }

            if (inConfig) {
              tokenizeYamlConfig(content, line.from, builder);
              continue;
            }

            if (inChartYamlHeader) {
              const sqlStart = trimmedUpper.startsWith('SELECT') ||
                               trimmedUpper.startsWith('WITH') ||
                               trimmedUpper.startsWith('INSERT') ||
                               trimmedUpper.startsWith('UPDATE') ||
                               trimmedUpper.startsWith('DELETE');
              if (sqlStart) {
                inChartYamlHeader = false;
                tokenizeSql(content, line.from, builder);
                continue;
              }

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
    // eslint-disable-next-line obsidianmd/no-object-to-string -- inserted is CodeMirror Text object with proper toString()
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
