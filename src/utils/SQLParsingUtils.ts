import { scanMarkdownCodeFences } from './MarkdownFenceUtils';
import { TRIGGER_FUNCTION_NAMES } from '../Constants/TriggerFunctionNames';
import { quoteIdentifier, sqliteIdentifierKey } from './SqlIdentifierUtils';

interface SqlDdlHeader {
  operation: string;
  kind: string;
  name: string;
  nameToken: SqlLexToken;
  next: number;
  condition: readonly SqlLexToken[];
}

function readSqlDdlHeader(sql: string, tokens = tokenizeSqlStatement(sql)): SqlDdlHeader | null {
  const operation = tokens[0];
  if (operation?.kind !== 'word' || !['CREATE', 'DROP', 'ALTER'].includes(operation.value)) return null;
  let index = 1;
  if (operation.value === 'CREATE' && (tokenIsWord(tokens[index], 'TEMP') || tokenIsWord(tokens[index], 'TEMPORARY'))) index++;
  if (operation.value === 'CREATE' && tokenIsWord(tokens[index], 'UNIQUE')) index++;
  const kind = tokens[index++];
  if (kind?.kind !== 'word' || !['TABLE', 'VIEW', 'TRIGGER', 'INDEX'].includes(kind.value)) return null;
  const conditionStart = index;

  if (tokenIsWord(tokens[index], 'IF')) {
    const words = operation.value === 'CREATE' ? ['IF', 'NOT', 'EXISTS'] : ['IF', 'EXISTS'];
    if (operation.value === 'ALTER' || !words.every((word, offset) => tokenIsWord(tokens[index + offset], word))) return null;
    index += words.length;
  }

  const condition = tokens.slice(conditionStart, index);
  const object = readQualifiedSqlIdentifier(sql, tokens, index, true);
  if (!object) return null;

  return { operation: operation.value, kind: kind.value, name: object.name, nameToken: tokens[object.next - 1], next: object.next, condition };
}

export function parseSQLObjectName(sql: string, type: 'VIEW' | 'TRIGGER'): string | null {
  const tokens = tokenizeSqlStatement(sql);
  const header = readSqlDdlHeader(sql, tokens);
  if (header?.operation !== 'CREATE' || header.kind !== type) return null;
  let next = header.next;
  if (type === 'VIEW' && tokens[next]?.value === '(') next = skipParenthesizedTokens(tokens, next);
  if (type === 'VIEW' && !tokenIsWord(tokens[next], 'AS')) return null;

  return header.name;
}

export function parseDroppedSQLObjectName(sql: string, type: 'VIEW' | 'TRIGGER'): string | null {
  const header = readSqlDdlHeader(sql);

  return header?.operation === 'DROP' && header.kind === type ? header.name : null;
}

export function stripSqlComments(sql: string): string {
  const parts: string[] = [];
  let offset = 0;

  for (const token of tokenizeSqlStatement(sql, true)) {
    if (token.kind !== 'comment') continue;
    parts.push(sql.slice(offset, token.start), ' ');
    offset = token.end;
  }

  parts.push(sql.slice(offset));

  return parts.join('').trim();
}

export function containsSqlKeywords(sql: string, keywords: string[]): boolean {
  const words = new Set(keywords.map(keyword => keyword.toUpperCase()));

  return tokenizeSqlStatement(sql).some(token => token.kind === 'word' && words.has(token.value));
}

const QUERY_STATEMENT_KEYWORDS: ReadonlySet<string> = new Set(['SELECT', 'VALUES', 'EXPLAIN', 'INSERT', 'UPDATE', 'DELETE']);
const SCHEMA_STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([...QUERY_STATEMENT_KEYWORDS, 'CREATE', 'DROP', 'ALTER']);

export function disallowedSqlStatement(sql: string, allowSchemaChanges = false): string | null {
  const allowed = allowSchemaChanges ? SCHEMA_STATEMENT_KEYWORDS : QUERY_STATEMENT_KEYWORDS;

  for (const statement of splitSqlStatements(sql)) {
    const tokens = tokenizeSqlStatement(statement);
    let start = 0;
    while (tokens[start]?.value === '(') start++;
    const index = findMainStatementToken(tokens.slice(start));
    const token = index < 0 ? undefined : tokens[start + index];
    if (token?.kind !== 'word' || !allowed.has(token.value)) return token?.value ?? 'statement';
  }

  return null;
}

export function rewriteTriggerWithPrefix(triggerSql: string, prefix: string): string {
  const header = readSqlDdlHeader(triggerSql);
  if (header?.operation !== 'CREATE' || header.kind !== 'TRIGGER') return triggerSql;
  let result = triggerSql.slice(0, header.nameToken.start) + quoteIdentifier(prefix + header.name) + triggerSql.slice(header.nameToken.end);

  for (const token of [...header.condition].reverse()) {
    result = result.slice(0, token.start) + result.slice(token.end);
  }

  return result;
}

function ddlRelation(sql: string, tokens: readonly SqlLexToken[], header: SqlDdlHeader): ReturnType<typeof readQualifiedSqlIdentifier> {
  if (header.operation !== 'CREATE' || !['TRIGGER', 'INDEX'].includes(header.kind)) return null;

  for (let index = header.next; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === ';' || tokenIsWord(token, 'BEGIN') || tokenIsWord(token, 'WHEN')) break;
    if (tokenIsWord(token, 'ON')) return readQualifiedSqlIdentifier(sql, tokens, index + 1, true);
  }

  return null;
}

export function rewriteTriggerTarget(sql: string, table: string, replacement: string): string {
  const tokens = tokenizeSqlStatement(sql);
  const header = readSqlDdlHeader(sql, tokens);
  if (header?.kind !== 'TRIGGER') return sql;
  const relation = ddlRelation(sql, tokens, header);
  if (!relation || sqliteIdentifierKey(relation.name) !== sqliteIdentifierKey(table)) return sql;
  const name = tokens[relation.next - 1];

  return sql.slice(0, name.start) + quoteIdentifier(replacement) + sql.slice(name.end);
}

export function sqlUpdatesColumn(sql: string, table: string, column: string): boolean {
  const tokens = tokenizeSqlStatement(sql);

  for (let index = 0; index < tokens.length; index++) {
    if (!tokenIsWord(tokens[index], 'UPDATE')) continue;
    const relation = readQualifiedSqlIdentifier(sql, tokens, dmlTargetStart(tokens, index), true);
    if (!relation || sqliteIdentifierKey(relation.name) !== sqliteIdentifierKey(table)) continue;
    let cursor = relation.next;
    if (tokenIsWord(tokens[cursor], 'AS')) cursor += 2;
    if (tokenIsWord(tokens[cursor], 'INDEXED') && tokenIsWord(tokens[cursor + 1], 'BY')) cursor += 3;
    else if (tokenIsWord(tokens[cursor], 'NOT') && tokenIsWord(tokens[cursor + 1], 'INDEXED')) cursor += 2;
    if (!tokenIsWord(tokens[cursor++], 'SET')) continue;

    while (cursor < tokens.length) {
      const columns: string[] = [];

      if (tokens[cursor]?.value === '(') {
        const after = skipParenthesizedTokens(tokens, cursor);
        if (after < 0) break;

        for (let name = cursor + 1; name < after - 1; name += 2) {
          columns.push(readSqlIdentifier(sql, tokens[name], true) ?? '');
        }

        cursor = after;
      }
      else columns.push(readSqlIdentifier(sql, tokens[cursor++], true) ?? '');
      if (tokens[cursor++]?.value !== '=') break;
      if (columns.some(name => sqliteIdentifierKey(name) === sqliteIdentifierKey(column))) return true;

      let cases = 0;

      while (cursor < tokens.length && (tokens[cursor].value !== ',' || cases > 0)) {
        const token = tokens[cursor];
        if (token.value === ';') break;
        if (tokenIsWord(token, 'CASE')) cases++;
        else if (cases > 0 && tokenIsWord(token, 'END')) cases--;
        else if (cases === 0 && token.kind === 'word' && ['WHERE', 'FROM', 'RETURNING', 'ORDER', 'LIMIT', 'END'].includes(token.value)) break;
        if (token.value === '(') {
          const after = skipParenthesizedTokens(tokens, cursor);
          if (after < 0) break;
          cursor = after;
        }
        else cursor++;
      }

      if (tokens[cursor++]?.value !== ',') break;
    }
  }

  return false;
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

  for (const block of scanMarkdownCodeFences(content)) {
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
  const header = readSqlDdlHeader(sql);

  return header?.operation === 'CREATE' && header.kind === type;
}

export type DmlOperation = "insert" | "update" | "delete";
export type SqlOperation = DmlOperation | "select";

export interface SqlLexToken {
  readonly kind: 'word' | 'identifier' | 'literal' | 'punctuation' | 'comment' | 'number' | 'parameter' | 'blob' | 'placeholder';
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, "");
}

function normalizeSqlStatement(sql: string): string {
  return stripTrailingSemicolon(stripSqlComments(sql));
}

const tokenCache = new Map<string, { tokens: readonly SqlLexToken[]; all: readonly SqlLexToken[]; bytes: number }>();
const TOKEN_CACHE_BYTES = 2 * 1024 * 1024;
let tokenCacheBytes = 0;

function identifierStart(code: number): boolean {
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95 || code > 127;
}

function identifierPart(code: number): boolean {
  return identifierStart(code) || code >= 48 && code <= 57 || code === 36;
}

/** Significant SQL tokens by default; comments are included for source editing and highlighting. */
export function tokenizeSqlStatement(sql: string, includeComments = false): readonly SqlLexToken[] {
  let cached = tokenCache.get(sql);

  if (cached) {
    tokenCache.delete(sql);
    tokenCache.set(sql, cached);
  }
  else {
    const all = tokenizeSqlUncached(sql);
    const tokens = all.filter(token => token.kind !== 'comment');
    const bytes = sql.length * 4 + all.length * 88;
    cached = { tokens, all, bytes };

    if (bytes <= TOKEN_CACHE_BYTES) {
      while (tokenCache.size >= 128 || tokenCacheBytes + bytes > TOKEN_CACHE_BYTES) {
        const oldest = tokenCache.keys().next().value;
        if (oldest === undefined) break;
        tokenCacheBytes -= tokenCache.get(oldest)!.bytes;
        tokenCache.delete(oldest);
      }

      tokenCache.set(sql, cached);
      tokenCacheBytes += bytes;
    }
  }

  return includeComments ? cached.all : cached.tokens;
}

const SQL_NUMBER = /(?:0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|(?:[0-9]+(?:_[0-9]+)*(?:\.[0-9]*(?:_[0-9]+)*)?|\.[0-9]+(?:_[0-9]+)*)(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?)/y;

function consumeSqlQuotedToken(sql: string, start: number): number {
  const close = sql[start] === '[' ? ']' : sql[start];
  let index = start + 1;

  while (index < sql.length) {
    if (sql[index++] !== close) continue;
    if (close !== ']' && sql[index] === close) index++;
    else break;
  }

  return index;
}

function tokenizeSqlUncached(sql: string): readonly SqlLexToken[] {
  const tokens: SqlLexToken[] = [];

  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    const code = sql.charCodeAt(index);
    const start = index;
    let kind: SqlLexToken['kind'] = 'punctuation';

    if (code === 32 || code >= 9 && code <= 13 || code > 127 && /\s/.test(char)) {
      index++;
      continue;
    }

    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end;
      kind = 'comment';
    }
    else if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end < 0 ? sql.length : end + 2;
      kind = 'comment';
    }
    else if (char === "'" || char === '"' || char === '`' || char === '[') {
      index = consumeSqlQuotedToken(sql, index);
      kind = char === "'" ? 'literal' : 'identifier';
    }
    else if ((char === 'x' || char === 'X') && sql[index + 1] === "'") {
      index = consumeSqlQuotedToken(sql, index + 1);
      kind = 'blob';
    }
    else if (char === '{' && sql[index + 1] === '{') {
      const end = sql.indexOf('}}', index + 2);
      index = end < 0 ? sql.length : end + 2;
      kind = 'placeholder';
    }
    else if (char === '?' || [':', '@', '$'].includes(char) && identifierPart(sql.charCodeAt(index + 1))) {
      index++;
      while (index < sql.length && !/\s/.test(sql[index]) && (char === '?' ? /[0-9]/.test(sql[index]) : identifierPart(sql.charCodeAt(index)))) index++;

      // SQLite also accepts Tcl-style $name::suffix(argument) parameters.
      if (char === '$') {
        while (sql.slice(index, index + 2) === '::') {
          index += 2;
          while (index < sql.length && identifierPart(sql.charCodeAt(index)) && !/\s/.test(sql[index])) index++;
        }

        if (sql[index] === '(') {
          const end = sql.indexOf(')', index + 1);
          index = end < 0 ? sql.length : end + 1;
        }
      }

      kind = 'parameter';
    }
    else if (code >= 48 && code <= 57 || char === '.' && /[0-9]/.test(sql[index + 1] ?? '')) {
      SQL_NUMBER.lastIndex = index;
      index += SQL_NUMBER.exec(sql)![0].length;
      kind = 'number';
    }
    else if (identifierStart(code)) {
      index++;
      while (index < sql.length && identifierPart(sql.charCodeAt(index)) && !/\s/.test(sql[index])) index++;
      kind = 'word';
    }
    else index++;

    const raw = sql.slice(start, index);
    tokens.push({ kind, value: kind === 'word' ? raw.replace(/[a-z]/g, letter => letter.toUpperCase()) : raw, start, end: index });
  }

  return tokens;
}

export function tokenIsWord(token: SqlLexToken | undefined, word: string): boolean {
  return token?.kind === 'word' && token.value === word;
}

export function skipParenthesizedTokens(tokens: readonly SqlLexToken[], start: number): number {
  if (tokens[start]?.value !== '(') return -1;

  let depth = 0;

  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === '(') depth++;
    else if (tokens[index].value === ')' && --depth === 0) return index + 1;
  }

  return -1;
}

function findMainStatementToken(tokens: readonly SqlLexToken[]): number {
  if (!tokenIsWord(tokens[0], 'WITH')) return tokens.length > 0 ? 0 : -1;

  let index = tokenIsWord(tokens[1], 'RECURSIVE') ? 2 : 1;

  while (index < tokens.length) {
    if (tokens[index].kind !== 'word' && tokens[index].kind !== 'identifier') return -1;
    index++;

    if (tokens[index]?.value === '(') {
      index = skipParenthesizedTokens(tokens, index);
      if (index < 0) return -1;
    }

    if (!tokenIsWord(tokens[index], 'AS')) return -1;
    index++;

    if (tokenIsWord(tokens[index], 'NOT') && tokenIsWord(tokens[index + 1], 'MATERIALIZED')) {
      index += 2;
    }
    else if (tokenIsWord(tokens[index], 'MATERIALIZED')) {
      index++;
    }

    index = skipParenthesizedTokens(tokens, index);
    if (index < 0) return -1;

    if (tokens[index]?.value !== ',') return index;
    index++;
  }

  return -1;
}

export function detectSqlOperation(sql: string): SqlOperation | null {
  const tokens = tokenizeSqlStatement(sql);
  const operationToken = tokens[findMainStatementToken(tokens)];
  if (operationToken?.kind !== 'word') return null;

  switch (operationToken.value) {
    case 'SELECT': return 'select';
    case 'INSERT': return 'insert';
    case 'UPDATE': return 'update';
    case 'DELETE': return 'delete';
    default: return null;
  }
}

const ACTION_FUNCTIONS = new Set<string>([...TRIGGER_FUNCTION_NAMES, '_vq_sync']);
const NON_FILE_ACTION_FUNCTIONS = new Set(['vq_notify', 'vq_log', 'vq_debounce', 'vq_defer']);

export function hasSqlActionFunctions(sql: string): boolean {
  return [...extractSqlFunctionCalls(sql)].some(name => ACTION_FUNCTIONS.has(name));
}

export function hasSqlFileActionFunctions(sql: string): boolean {
  return [...extractSqlFunctionCalls(sql)].some(name => ACTION_FUNCTIONS.has(name) && !NON_FILE_ACTION_FUNCTIONS.has(name));
}


const selectOnlyCache = new Map<string, boolean>();

export function isSelectOnly(sql: string): boolean {
  const cached = selectOnlyCache.get(sql);
  if (cached !== undefined) return cached;
  const result = classifySelectOnly(sql);
  if (selectOnlyCache.size >= 200) selectOnlyCache.delete(selectOnlyCache.keys().next().value!);
  selectOnlyCache.set(sql, result);

  return result;
}

function classifySelectOnly(sql: string): boolean {
  const statements = splitSqlStatements(sql);
  if (statements.length !== 1) return false;
  let statement = statements[0];
  const tokens = tokenizeSqlStatement(statement);

  if (tokenIsWord(tokens[0], 'EXPLAIN')) {
    const index = tokenIsWord(tokens[1], 'QUERY') && tokenIsWord(tokens[2], 'PLAN') ? 3 : 1;
    if (!tokens[index]) return false;
    statement = statement.slice(tokens[index].start);
  }

  if (detectSqlOperation(statement) !== 'select') return false;

  return !hasSqlActionFunctions(statement);
}

export function isWriteOnly(sql: string): boolean {
  const statements = splitSqlStatements(sql);

  return statements.length > 0 && statements.every(statement => detectDmlOperationInSql(statement) !== null);
}

function stripSqlClause(sql: string, keyword: string): string {
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
  const tokens = tokenizeSqlStatement(cleaned);
  const statements: string[] = [];
  let start = 0;
  let statementToken = 0;
  let inTrigger = false;
  let inBody = false;
  let openCases = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (index === statementToken) {
      let kind = index + 1;
      if (tokenIsWord(tokens[kind], 'TEMP') || tokenIsWord(tokens[kind], 'TEMPORARY')) kind++;
      inTrigger = tokenIsWord(token, 'CREATE') && tokenIsWord(tokens[kind], 'TRIGGER');
    }

    if (inTrigger && token.kind === 'word') {
      if (!inBody && token.value === 'BEGIN') inBody = true;
      else if (inBody && token.value === 'CASE') openCases++;
      else if (inBody && token.value === 'END') {
        if (openCases > 0) openCases--;
        else { inBody = false; inTrigger = false; }
      }
    }

    if (token.value !== ';' || inTrigger) continue;
    const text = cleaned.slice(start, token.start).trim();
    if (text) statements.push(text);
    start = token.end;
    statementToken = index + 1;
  }

  const tail = cleaned.slice(start).trim();
  if (tail) statements.push(tail);

  return statements;
}

function findKeywordOutsideStrings(sql: string, keyword: string): number {
  const tokens = tokenizeSqlStatement(sql);
  const word = keyword.toUpperCase();
  let depth = 0;

  for (const token of tokens) {
    if (token.value === '(') depth++;
    else if (token.value === ')') depth--;
    else if (depth === 0 && tokenIsWord(token, word)) return token.start;
  }

  return -1;
}

export function sqlIdentifierAtCursor(sql: string): { start: number; query: string; qualifier?: string; qualifierSql?: string } | null {
  const tokens = tokenizeSqlStatement(sql);
  let index = tokens.length - 1;
  const last = tokens[index];
  if (!last || last.end !== sql.length) return null;
  const trailingDot = last.kind === 'punctuation' && last.value === '.';
  if (!trailingDot && last.kind !== 'identifier' && last.kind !== 'word') return null;
  const decode = (token: SqlLexToken): string => readSqlIdentifier(sql, token) ?? token.value.slice(1).replace(/""/g, '"').replace(/``/g, '`');
  let query = trailingDot ? '' : decode(last);
  let start = last.start;
  if (!trailingDot) index--;

  if (tokens[index]?.value === '.') {
    const qualifierToken = tokens[index - 1];
    const qualifier = readSqlIdentifier(sql, qualifierToken);

    if (qualifier !== null) {
      start = qualifierToken.start;
      query = `${qualifier}.${query}`;

      return { start, query, qualifier, qualifierSql: sql.slice(start, tokens[index].start) };
    }
  }

  return last.kind === 'identifier' ? { start, query } : null;
}

export function extractSqlReferencedTables(sql: string): Set<string> {
  const tokens = tokenizeSqlStatement(sql);
  const references = new Set<string>();
  const fold = (name: string): string => name.replace(/[A-Z]/g, char => char.toLowerCase());

  const scan = (start: number, end: number, inherited: Set<string>, fromGroup = false): void => {
    const ctes = new Set(inherited);
    let inFrom = fromGroup;
    let expectRelation = fromGroup;

    for (let index = start; index < end; index++) {
      const token = tokens[index];

      if (tokenIsWord(token, 'WITH')) {
        let cursor = index + 1;
        if (tokenIsWord(tokens[cursor], 'RECURSIVE')) cursor++;
        const bodies: Array<[number, number]> = [];

        while (cursor < end) {
          const name = readSqlIdentifier(sql, tokens[cursor++]);
          if (name === null) break;
          if (tokens[cursor]?.value === '(') cursor = skipParenthesizedTokens(tokens, cursor);
          if (cursor < 0 || !tokenIsWord(tokens[cursor++], 'AS')) break;
          if (tokenIsWord(tokens[cursor], 'NOT')) cursor++;
          if (tokenIsWord(tokens[cursor], 'MATERIALIZED')) cursor++;
          if (tokens[cursor]?.value !== '(') break;
          const after = skipParenthesizedTokens(tokens, cursor);
          if (after < 0) break;
          ctes.add(fold(name));
          bodies.push([cursor + 1, after - 1]);
          cursor = after;
          if (tokens[cursor]?.value !== ',') break;
          cursor++;
        }

        if (bodies.length) {
          for (const [bodyStart, bodyEnd] of bodies) {
            scan(bodyStart, bodyEnd, ctes);
          }

          index = cursor - 1;
          continue;
        }
      }

      if (token.kind === 'punctuation' && token.value === '(') {
        const after = skipParenthesizedTokens(tokens, index);
        if (after < 0) return;
        const beginsQuery = tokenIsWord(tokens[index + 1], 'SELECT') || tokenIsWord(tokens[index + 1], 'WITH');
        scan(index + 1, after - 1, ctes, expectRelation && !beginsQuery);
        expectRelation = false;
        index = after - 1;
        continue;
      }

      if (expectRelation) {
        const relation = readQualifiedSqlIdentifier(sql, tokens, index);

        if (relation && tokens[relation.next]?.value !== '(' && !ctes.has(fold(relation.name))) {
          references.add(relation.name);
        }

        expectRelation = false;
        if (relation) { index = relation.next - 1; continue; }
      }

      if (token.kind === 'word') {
        if (token.value === 'FROM' || token.value === 'JOIN') { inFrom = true; expectRelation = true; }
        else if (['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'RETURNING'].includes(token.value)) inFrom = false;
      }
      else if (token.value === ',' && inFrom) expectRelation = true;
      else if (token.value === ';') { inFrom = false; expectRelation = false; ctes.clear(); }
    }
  };

  scan(0, tokens.length, new Set());

  return references;
}

export function extractSqlMutationTarget(sql: string): string | null {
  const tokens = tokenizeSqlStatement(sql);
  const first = tokens[findMainStatementToken(tokens)];
  if (first?.kind !== 'word') return null;
  if (['INSERT', 'UPDATE', 'DELETE'].includes(first.value)) return extractDmlTargetTable(sql);
  if (!['CREATE', 'DROP', 'ALTER', 'REPLACE'].includes(first.value)) return null;
  let cursor = tokens.indexOf(first) + 1;

  if (first.value === 'REPLACE') {
    if (tokenIsWord(tokens[cursor], 'INTO')) cursor++;
  }
  else {
    if (tokenIsWord(tokens[cursor], 'TEMP') || tokenIsWord(tokens[cursor], 'TEMPORARY')) cursor++;
    if (!tokenIsWord(tokens[cursor++], 'TABLE')) return null;

    if (tokenIsWord(tokens[cursor], 'IF')) {
      cursor++;
      if (tokenIsWord(tokens[cursor], 'NOT')) cursor++;
      if (tokenIsWord(tokens[cursor], 'EXISTS')) cursor++;
    }
  }

  return readQualifiedSqlIdentifier(sql, tokens, cursor)?.name ?? null;
}

export function extractSqlDdlObject(sql: string): { kind: string; name: string; relation?: string } | null {
  const tokens = tokenizeSqlStatement(sql);
  const header = readSqlDdlHeader(sql, tokens);
  if (!header) return null;

  return { kind: header.kind, name: header.name, relation: ddlRelation(sql, tokens, header)?.name };
}

export function extractSqlFunctionCalls(sql: string): Set<string> {
  const tokens = tokenizeSqlStatement(sql);
  const names = new Set<string>();

  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index + 1].value !== '(') continue;
    const name = readSqlIdentifier(sql, tokens[index], true);
    if (name !== null) names.add(sqliteIdentifierKey(name));
  }

  return names;
}

export function csvInsertColumns(sql: string): string[] | null {
  const tokens = tokenizeSqlStatement(sql);
  const first = findMainStatementToken(tokens);
  if (!tokenIsWord(tokens[first], 'INSERT')) return [];
  const relation = readQualifiedSqlIdentifier(sql, tokens, dmlTargetStart(tokens, first));
  if (!relation) return null;
  let cursor = relation.next;
  if (tokenIsWord(tokens[cursor], 'AS')) cursor += 2;
  if (tokenIsWord(tokens[cursor], 'DEFAULT') && tokenIsWord(tokens[cursor + 1], 'VALUES')) return [];
  if (tokens[cursor++]?.value !== '(') return null;
  const columns: string[] = [];

  while (cursor < tokens.length) {
    const name = readSqlIdentifier(sql, tokens[cursor++]);
    if (name === null) return null;
    columns.push(name);
    if (tokens[cursor]?.value === ')') return columns;
    if (tokens[cursor++]?.value !== ',') return null;
  }

  return null;
}

export function otherFileWriteStatements(sql: string): Array<{ sql: string; op: DmlOperation }> {
  const statements = splitSqlStatements(sql);
  if (!statements.length) throw new Error('A file write preview requires at least one statement.');

  return statements.map(statement => {
    const tokens = tokenizeSqlStatement(statement);
    const first = findMainStatementToken(tokens);
    const op = tokens[first]?.value.toLowerCase();
    const relation = readQualifiedSqlIdentifier(statement, tokens, dmlTargetStart(tokens, first));

    if (!['insert', 'update', 'delete'].includes(op) || relation?.name.toLowerCase() !== 'other_files'
      || relation.schema && relation.schema.toLowerCase() !== 'main') {
      throw new Error('A file write batch must contain only INSERT, UPDATE, or DELETE targeting main.other_files.');
    }

    if (tokenIsWord(tokens[first + 1], 'OR') || tokens.some((token, i) => tokenIsWord(token, 'ON') && tokenIsWord(tokens[i + 1], 'CONFLICT'))) {
      throw new Error('File writes do not support conflict clauses or implicit overwrites.');
    }

    if (op === 'insert') {
      const columns = csvInsertColumns(statement)?.map(name => name.toLowerCase());

      if (columns?.length !== 2 || !columns.includes('path') || !columns.includes('content')) {
        throw new Error('File INSERT requires exactly the path and content columns.');
      }
    }

    if (op === 'update') {
      const set = tokens.findIndex((token, i) => i > relation.next - 1 && tokenIsWord(token, 'SET'));
      let column = set + 1;
      const tuple = tokens[column]?.value === '(';
      if (tuple) column++;
      const name = readSqlIdentifier(statement, tokens[column]);
      let equal = column + 1;
      if (tuple && tokens[equal++]?.value !== ')') throw new Error('Only file content can be updated.');
      if (set < 0 || name?.toLowerCase() !== 'content' || tokens[equal]?.value !== '=') throw new Error('Only file content can be updated.');
      let depth = 0;

      for (let i = equal + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (depth === 0 && token.kind === 'word' && ['WHERE', 'FROM', 'RETURNING', 'ORDER', 'LIMIT'].includes(token.value)) break;
        if (token.kind !== 'punctuation') continue;
        if (token.value === '(') depth++;
        if (token.value === ')') depth--;
        if (depth === 0 && token.value === ',') throw new Error('Only one content assignment is supported per UPDATE.');
      }
    }

    return { sql: statement, op: op as DmlOperation };
  });
}

export function extractSqlAliasMap(sqlSource: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const tokens = tokenizeSqlStatement(sqlSource);

  const clauses = new Set(['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'NATURAL',
    'ON', 'USING', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT',
    'RETURNING', 'SET', 'VALUES', 'SELECT', 'WINDOW', 'INDEXED', 'NOT', 'DO']);

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'word' || !['FROM', 'JOIN', 'UPDATE', 'INTO'].includes(token.value)) continue;
    const start = token.value === 'UPDATE' ? dmlTargetStart(tokens, index) : index + 1;
    const relation = readQualifiedSqlIdentifier(sqlSource, tokens, start);
    if (!relation) continue;
    aliases.set(relation.name.toLowerCase(), relation.name);
    const aliasIndex = tokenIsWord(tokens[relation.next], 'AS') ? relation.next + 1 : relation.next;
    const aliasToken = tokens[aliasIndex];
    if (aliasToken?.kind === 'word' && clauses.has(aliasToken.value)) continue;
    const alias = readSqlIdentifier(sqlSource, aliasToken);
    if (alias !== null) aliases.set(alias.toLowerCase(), relation.name);
  }

  return aliases;
}

export function stripLeadingCte(sql: string, dmlWords: string[] = ["INSERT", "UPDATE", "DELETE"]): string {
  const trimmed = stripSqlComments(sql).trim();
  const tokens = tokenizeSqlStatement(trimmed);
  if (!tokenIsWord(tokens[0], 'WITH')) return trimmed;
  const operationToken = tokens[findMainStatementToken(tokens)];

  return operationToken?.kind === 'word' && dmlWords.includes(operationToken.value)
    ? trimmed.slice(operationToken.start)
    : trimmed;
}

export function detectDmlOperation(sql: string): DmlOperation | null {
  return detectDmlOperationInSql(sql);
}

export function detectDmlOperationInSql(sql: string): DmlOperation | null {
  const operation = detectSqlOperation(sql);

  return operation === 'insert' || operation === 'update' || operation === 'delete' ? operation : null;
}

export function extractDmlTargetTable(sql: string): string | null {
  const tokens = tokenizeSqlStatement(sql);
  const start = dmlTargetStart(tokens, findMainStatementToken(tokens));

  return readQualifiedSqlIdentifier(sql, tokens, start)?.name ?? null;
}

function dmlTargetStart(tokens: readonly SqlLexToken[], operation: number): number {
  const token = tokens[operation];
  if (token?.kind !== 'word' || !['INSERT', 'UPDATE', 'DELETE'].includes(token.value)) return -1;
  let index = operation + 1;
  if (token.value === 'DELETE') return tokenIsWord(tokens[index], 'FROM') ? index + 1 : -1;

  if (tokenIsWord(tokens[index], 'OR')) {
    const conflict = tokens[index + 1];
    if (conflict?.kind !== 'word' || !['ROLLBACK', 'ABORT', 'REPLACE', 'FAIL', 'IGNORE'].includes(conflict.value)) return -1;
    index += 2;
  }

  if (token.value === 'INSERT' && tokenIsWord(tokens[index], 'INTO')) index++;

  return index;
}

export function readSqlIdentifier(sql: string, token: SqlLexToken | undefined, allowStringLiteral = false): string | null {
  if (token?.kind === 'word') return sql.slice(token.start, token.end);
  if (token?.kind !== 'identifier' && !(allowStringLiteral && token?.kind === 'literal')) return null;
  const quote = token.value[0];
  const close = quote === '[' ? ']' : quote;
  if (token.value.length < 2 || !token.value.endsWith(close)) return null;
  const body = token.value.slice(1, -1);
  if (quote !== '[' && body.split(close + close).join('').includes(close)) return null;

  return quote === '[' ? body : body.split(close + close).join(close);
}

export function readQualifiedSqlIdentifier(sql: string, tokens: readonly SqlLexToken[], start: number, allowStringLiteral = false): { name: string; next: number; schema?: string } | null {
  let name = readSqlIdentifier(sql, tokens[start], allowStringLiteral);
  if (name === null) return null;
  let schema: string | undefined;
  let next = start + 1;

  if (tokens[next]?.kind === 'punctuation' && tokens[next].value === '.') {
    schema = name;
    name = readSqlIdentifier(sql, tokens[next + 1], allowStringLiteral);
    if (name === null) return null;
    next += 2;
  }

  if (tokens[next]?.kind === 'punctuation' && tokens[next].value === '.') return null;

  return { name, next, schema };
}

export function extractDmlTargetSchema(sql: string): string | undefined {
  const tokens = tokenizeSqlStatement(sql);

  return readQualifiedSqlIdentifier(sql, tokens, dmlTargetStart(tokens, findMainStatementToken(tokens)))?.schema;
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
