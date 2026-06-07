import { extractMarkdownCodeFences } from './MarkdownFenceUtils';

interface SqlScanState {
  inSingleQuote: boolean;
  inDoubleQuote: boolean;
  inBacktick: boolean;
  inBracket: boolean;
}

export interface SqlScanContext extends SqlScanState {
  index: number;
  char: string;
  next: string;
  inQuotedToken: boolean;
}

export function scanSql(sql: string, visit: (context: SqlScanContext) => number | void): void {
  const state: SqlScanState = {
    inSingleQuote: false,
    inDoubleQuote: false,
    inBacktick: false,
    inBracket: false,
  };

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1] || '';

    if (c === "'" && !state.inDoubleQuote && !state.inBacktick && !state.inBracket) {
      if (next === "'") {
        const jumpTo = visit({ ...state, index: i, char: c, next, inQuotedToken: true });
        i = typeof jumpTo === 'number' ? jumpTo : i + 1;
        continue;
      }
      state.inSingleQuote = !state.inSingleQuote;
      const jumpTo = visit({ ...state, index: i, char: c, next, inQuotedToken: true });
      if (typeof jumpTo === 'number') i = jumpTo;
      continue;
    }
    if (c === '"' && !state.inSingleQuote && !state.inBacktick && !state.inBracket) {
      state.inDoubleQuote = !state.inDoubleQuote;
      const jumpTo = visit({ ...state, index: i, char: c, next, inQuotedToken: true });
      if (typeof jumpTo === 'number') i = jumpTo;
      continue;
    }
    if (c === '`' && !state.inSingleQuote && !state.inDoubleQuote && !state.inBracket) {
      state.inBacktick = !state.inBacktick;
      const jumpTo = visit({ ...state, index: i, char: c, next, inQuotedToken: true });
      if (typeof jumpTo === 'number') i = jumpTo;
      continue;
    }
    if (c === '[' && !state.inSingleQuote && !state.inDoubleQuote && !state.inBacktick && !state.inBracket) {
      state.inBracket = true;
      const jumpTo = visit({ ...state, index: i, char: c, next, inQuotedToken: true });
      if (typeof jumpTo === 'number') i = jumpTo;
      continue;
    }
    if (c === ']' && state.inBracket) {
      state.inBracket = false;
      const jumpTo = visit({ ...state, index: i, char: c, next, inQuotedToken: true });
      if (typeof jumpTo === 'number') i = jumpTo;
      continue;
    }

    const inQuotedToken = state.inSingleQuote || state.inDoubleQuote || state.inBacktick || state.inBracket;
    const jumpTo = visit({ ...state, index: i, char: c, next, inQuotedToken });
    if (typeof jumpTo === 'number') i = jumpTo;
  }
}

export function parseSQLObjectName(sql: string, type: 'VIEW' | 'TRIGGER'): string | null {
  const suffix = type === 'VIEW' ? '\\s+AS' : '';
  const pattern = new RegExp(
    `CREATE\\s+${type}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"([^"]+)"|'([^']+)'|\`([^\`]+)\`|\\[([^\\]]+)\\]|(\\w+))${suffix}`,
    'i'
  );
  const match = sql.match(pattern);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? null;
}

export function stripSqlComments(sql: string): string {
  let result = '';

  scanSql(sql, ({ index, char, next, inQuotedToken }) => {
    if (inQuotedToken) {
      result += char;
      if (char === "'" && next === "'") {
        result += next;
      }
      return;
    }

    if (char === '-' && next === '-') {
      const lineEnd = sql.indexOf('\n', index);
      return lineEnd === -1 ? sql.length : lineEnd - 1;
    }

    if (char === '/' && next === '*') {
      const commentEnd = sql.indexOf('*/', index + 2);
      return commentEnd === -1 ? sql.length : commentEnd + 1;
    }

    result += char;
  });

  return result.split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .join('\n')
    .trim();
}

export function containsSqlKeywords(sql: string, keywords: string[]): boolean {
  const queryWithoutStrings = stripSqlComments(sql)
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, '""');

  return keywords.some(keyword => new RegExp(`\\b${keyword}\\b`, 'i').test(queryWithoutStrings));
}

export function containsBlockedSql(sql: string, allowSchemaChanges: boolean = false): boolean {
  const sqlWithoutComments = stripSqlComments(sql);

  const alwaysBlocked = [
    /ATTACH\s+DATABASE/i,
    /PRAGMA/i,
    /\.load/i,
    /\.shell/i,
    /\.system/i,
    /LOAD_EXTENSION/i
  ];

  const schemaChanges = [
    /DROP\s+TABLE/i,
    /ALTER\s+TABLE/i,
    /CREATE\s+TABLE/i,
    /CREATE\s+INDEX/i,
    /DROP\s+INDEX/i,
    /CREATE\s+VIEW/i,
    /DROP\s+VIEW/i
  ];

  return alwaysBlocked.some(pattern => pattern.test(sqlWithoutComments)) ||
    (!allowSchemaChanges && schemaChanges.some(pattern => pattern.test(sqlWithoutComments)));
}

export function rewriteTriggerWithPrefix(triggerSql: string, prefix: string): string {
  return triggerSql.replace(
    /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|'[^']+'|`[^`]+`|\[[^\]]+\]|\w+)/i,
    (match) => {
      const createPart = match.match(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?/i)?.[0] ?? 'CREATE TRIGGER ';
      const name = parseSQLObjectName(triggerSql, 'TRIGGER');
      return `${createPart.replace(/IF\s+NOT\s+EXISTS\s+/i, '')}"${prefix}${name}"`;
    }
  );
}

export function parseFunctionName(source: string): string | null {
  const match = source.match(/^\s*function\s+(\w+)\s*\(/);
  return match?.[1] ?? null;
}

interface ExtractedCodeBlocks {
  views: string[];
  functions: string[];
  triggers: string[];
}

export function extractAllCodeBlocks(content: string): ExtractedCodeBlocks {
  const result: ExtractedCodeBlocks = {
    views: [],
    functions: [],
    triggers: []
  };

  for (const block of extractMarkdownCodeFences(content)) {
    const match = /^vaultquery-(view|function|trigger)$/.exec(block.language);
    if (!match) continue;

    switch (match[1]) {
      case 'view':
        result.views.push(block.source);
        break;
      case 'function':
        result.functions.push(block.source);
        break;
      case 'trigger':
        result.triggers.push(block.source);
        break;
    }
  }

  return result;
}

export function validateSQLObjectStart(sql: string, type: 'VIEW' | 'TRIGGER'): boolean {
  const pattern = new RegExp(`^\\s*CREATE\\s+${type}`, 'i');
  return pattern.test(sql);
}

export type DmlOperation = "insert" | "update" | "delete";

export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, "");
}

export function normalizeSqlStatement(sql: string): string {
  return stripTrailingSemicolon(stripSqlComments(sql));
}

export function stripSqlClause(sql: string, keyword: string): string {
  const statement = normalizeSqlStatement(sql);
  const keywordPos = findKeywordOutsideStrings(statement, keyword);
  return keywordPos >= 0 ? statement.substring(0, keywordPos).replace(/\s+$/, '') : statement;
}

export function appendOrReplaceReturning(sql: string, returningList: string): string {
  const statement = normalizeSqlStatement(sql);
  const returningPos = findKeywordOutsideStrings(statement, 'returning');

  if (returningPos >= 0) {
    return `${statement.substring(0, returningPos)}RETURNING ${returningList}`;
  }

  return `${statement} RETURNING ${returningList}`;
}

export function stripReturningClause(sql: string): string {
  return stripSqlClause(sql, 'returning');
}

export function splitSqlStatements(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const statements: string[] = [];
  let current = '';

  scanSql(cleaned, ({ char, next, inQuotedToken }) => {
    if (char === "'" && next === "'" && inQuotedToken) {
      current += "''";
      return;
    }

    if (char === ';' && !inQuotedToken) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      return;
    }

    current += char;
  });

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }

  return statements;
}

export function findKeywordOutsideStrings(sql: string, keyword: string): number {
  const keywordUpper = keyword.toUpperCase();
  const keywordLen = keyword.length;
  let found = -1;

  scanSql(sql, ({ index, inQuotedToken }) => {
    if (inQuotedToken || found >= 0) {
      return;
    }

    if (index + keywordLen <= sql.length) {
      const slice = sql.substring(index, index + keywordLen);
      if (slice.toUpperCase() === keywordUpper) {
        const charBefore = index > 0 ? sql[index - 1] : ' ';
        const charAfter = index + keywordLen < sql.length ? sql[index + keywordLen] : ' ';

        if (!isSqlWordChar(charBefore) && !isSqlWordChar(charAfter)) {
          found = index;
        }
      }
    }
  });

  return found;
}

export function consumeSqlSingleQuotedString(text: string, pos: number): number {
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

export function extractSqlAliasMap(sqlSource: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const relationPattern = /\b(?:from|join|update|into)\s+("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w.]*))(?:\s+(?:as\s+)?([A-Za-z_][\w]*))?/giu;
  let match: RegExpExecArray | null;

  while ((match = relationPattern.exec(sqlSource)) !== null) {
    const relation = match[2] || match[3] || match[4] || match[5];
    const alias = match[6];
    if (!relation) {
      continue;
    }

    aliases.set(relation.toLowerCase(), relation);
    if (alias) {
      aliases.set(alias.toLowerCase(), relation);
    }
  }

  return aliases;
}

export function stripLeadingCte(sql: string, dmlWords: string[] = ["INSERT", "UPDATE", "DELETE"]): string {
  const trimmed = stripSqlComments(sql).trim();
  if (!/^(WITH)\b/i.test(trimmed)) return trimmed;

  const idx = findTopLevelKeyword(trimmed, dmlWords);
  return idx >= 0 ? trimmed.slice(idx) : trimmed;
}

export function detectDmlOperation(sql: string): DmlOperation | null {
  const up = sql.trim().toUpperCase();
  if (up.startsWith("INSERT")) return "insert";
  if (up.startsWith("UPDATE")) return "update";
  if (up.startsWith("DELETE")) return "delete";
  return null;
}

export function detectDmlOperationInSql(sql: string): DmlOperation | null {
  return detectDmlOperation(stripLeadingCte(sql));
}

export function extractDmlTargetTable(sql: string): string | null {
  const body = stripLeadingCte(stripTrailingSemicolon(sql));
  const op = detectDmlOperation(body);
  if (!op) return null;

  if (op === "insert") {
    const m = /^\s*INSERT\s+(?:OR\s+\w+\s+)?(?:INTO\s+)?([`"[\]\w.]+)/i.exec(body);
    return m ? unquoteSqlIdentifier(lastSqlIdentifier(m[1])) : null;
  }

  if (op === "update") {
    const m = /^\s*UPDATE\s+(?:OR\s+\w+\s+)?([`"[\]\w.]+)/i.exec(body);
    return m ? unquoteSqlIdentifier(lastSqlIdentifier(m[1])) : null;
  }

  const m = /^\s*DELETE\s+FROM\s+([`"[\]\w.]+)/i.exec(body);
  return m ? unquoteSqlIdentifier(lastSqlIdentifier(m[1])) : null;
}

function findTopLevelKeyword(sql: string, words: string[]): number {
  const patterns = words.map(word => new RegExp("^" + word + "\\b", "i"));
  let found = -1;

  scanSql(sql, ({ index, inQuotedToken }) => {
    if (inQuotedToken || found >= 0) {
      return;
    }

    for (const pattern of patterns) {
      if (pattern.test(sql.slice(index))) {
        found = index;
        return;
      }
    }
  });

  return found;
}

function isSqlWordChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char);
}

function lastSqlIdentifier(qname: string): string {
  const parts = qname.split(".");
  return parts[parts.length - 1] ?? qname;
}

function unquoteSqlIdentifier(name: string): string {
  return name
    .replace(/^["`[]/, "").replace(/["`\]]$/, "")
    .replace(/""/g, '"');
}

export function validateFunctionSyntax(source: string): { valid: boolean; error?: string } {
  const trimmed = source.trim();

  if (!trimmed.startsWith('function')) {
    return { valid: false, error: 'Function must start with "function" keyword' };
  }

  let braceCount = 0;
  for (const char of trimmed) {
    if (char === '{') braceCount++;
    if (char === '}') braceCount--;
  }

  if (braceCount !== 0) {
    return { valid: false, error: 'Mismatched braces in function definition' };
  }

  return { valid: true };
}
