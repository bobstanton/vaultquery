import { readQualifiedSqlIdentifier, readSqlIdentifier, skipParenthesizedTokens, tokenIsWord, tokenizeSqlStatement } from '../utils/SQLParsingUtils';
import type { SqlLexToken } from '../utils/SQLParsingUtils';
import { escapeSqlString, sqliteIdentifierKey } from '../utils/SqlIdentifierUtils';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('LlmRepair');

const SOURCE_BOUNDARIES = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'RETURNING', 'SET']);
const JOIN_WORDS = new Set(['JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING', 'INDEXED', 'NOT']);
const OPERAND_STARTS = new Set(['WHERE', 'ON', 'HAVING', 'AND', 'OR', 'NOT', 'WHEN', 'THEN', 'ELSE']);
const OPERAND_ENDS = new Set([...SOURCE_BOUNDARIES, ...JOIN_WORDS, 'AND', 'OR', 'WHEN', 'THEN', 'ELSE', 'END']);

interface QuerySources {
  aliases: Map<string, boolean>;
  count: number;
  complete: boolean;
}

function querySources(sql: string, tokens: readonly SqlLexToken[]): QuerySources {
  const sources: QuerySources = { aliases: new Map(), count: 0, complete: true };

  const addSource = (start: number): void => {
    sources.count++;
    const relation = readQualifiedSqlIdentifier(sql, tokens, start);

    if (!relation || tokens[relation.next]?.value === '(') {
      sources.complete = false;

      return;
    }

    const aliasIndex = tokenIsWord(tokens[relation.next], 'AS') ? relation.next + 1 : relation.next;
    const aliasToken = tokens[aliasIndex];

    const alias = aliasToken?.kind === 'word' && (SOURCE_BOUNDARIES.has(aliasToken.value) || JOIN_WORDS.has(aliasToken.value))
      ? null : readSqlIdentifier(sql, aliasToken);

    const name = sqliteIdentifierKey(alias ?? relation.name);
    const isProperties = sqliteIdentifierKey(relation.name) === 'properties' && (!relation.schema || sqliteIdentifierKey(relation.schema) === 'main');
    sources.aliases.set(name, !sources.aliases.has(name) && isProperties);
  };

  if (tokenIsWord(tokens[0], 'UPDATE')) {
    addSource(tokenIsWord(tokens[1], 'OR') ? 3 : 1);
  }

  let inFrom = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token.value === '(') {
      const after = skipParenthesizedTokens(tokens, index);
      if (after < 0) break;
      index = after - 1;
      continue;
    }

    if (tokenIsWord(token, 'FROM') || tokenIsWord(token, 'JOIN')) {
      inFrom = true;
      addSource(index + 1);
    }
    else if (token.kind === 'word' && SOURCE_BOUNDARIES.has(token.value)) inFrom = false;
    else if (token.value === ',' && inFrom) addSource(index + 1);
  }

  return sources;
}

function propertyKeyEnd(sql: string, tokens: readonly SqlLexToken[], start: number, sources: QuerySources): number | null {
  if (!sources.complete) return null;
  const names: string[] = [];
  let index = start;

  while (index < tokens.length) {
    const name = readSqlIdentifier(sql, tokens[index]);
    if (name === null) return null;
    names.push(sqliteIdentifierKey(name));
    index++;
    if (tokens[index]?.value !== '.') break;
    index++;
    if (index === tokens.length) return null;
  }

  if (names[names.length - 1] !== 'key') return null;
  if (names.length === 1) return sources.count === 1 && [...sources.aliases.values()][0] === true ? index : null;
  if (names.length === 2) return sources.aliases.get(names[0]) === true ? index : null;
  if (names.length === 3 && names[0] === 'main' && names[1] === 'properties' && sources.aliases.get('properties') === true) return index;

  return null;
}

function comparisonEnd(tokens: readonly SqlLexToken[], start: number): number | null {
  const first = tokens[start]?.value;
  const second = tokens[start + 1]?.value;
  const adjacent = tokens[start + 1]?.start === tokens[start]?.start + 1;
  if (first === '=') return second === '=' && adjacent ? start + 2 : start + 1;
  if (adjacent && (first === '!' && second === '=' || first === '<' && second === '>')) return start + 2;

  return null;
}

function operandBoundary(token: SqlLexToken | undefined, before: boolean): boolean {
  if (!token) return true;
  if (token.kind === 'punctuation') return before ? token.value === '(' : token.value === ')' || token.value === ',';

  return token.kind === 'word' && (before ? OPERAND_STARTS : OPERAND_ENDS).has(token.value);
}

/** Expressions and IN subqueries are not literal lists. */
function predicateLiterals(sql: string, tokens: readonly SqlLexToken[], sources: QuerySources): SqlLexToken[] {
  const literals: SqlLexToken[] = [];
  let inPredicate = false;
  let depth = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (depth === 0 && token.kind === 'word') {
      if (['WHERE', 'ON', 'HAVING'].includes(token.value)) inPredicate = true;
      else if (SOURCE_BOUNDARIES.has(token.value) || token.value === 'JOIN') inPredicate = false;
    }

    if (token.value === '(') depth++;
    else if (token.value === ')') depth--;
    if (!inPredicate || !operandBoundary(tokens[index - 1], true)) continue;
    const keyEnd = propertyKeyEnd(sql, tokens, index, sources);

    if (keyEnd !== null) {
      const right = comparisonEnd(tokens, keyEnd);

      if (right !== null && tokens[right]?.kind === 'literal' && operandBoundary(tokens[right + 1], false)) {
        literals.push(tokens[right]);
      }

      const inIndex = tokenIsWord(tokens[keyEnd], 'NOT') ? keyEnd + 1 : keyEnd;

      if (tokenIsWord(tokens[inIndex], 'IN') && tokens[inIndex + 1]?.value === '(') {
        let cursor = inIndex + 2;
        const list: SqlLexToken[] = [];

        while (tokens[cursor]?.kind === 'literal') {
          list.push(tokens[cursor++]);
          if (tokens[cursor]?.value !== ',' || tokens[cursor + 1]?.kind !== 'literal') break;
          cursor++;
        }

        if (tokens[cursor]?.value === ')' && operandBoundary(tokens[cursor + 1], false)) literals.push(...list);
      }
    }
    else if (token.kind === 'literal') {
      const right = comparisonEnd(tokens, index + 1);
      const end = right === null ? null : propertyKeyEnd(sql, tokens, right, sources);
      if (end !== null && operandBoundary(tokens[end], false)) literals.push(token);
    }
  }

  return literals;
}

function queryLiterals(sql: string, tokens: readonly SqlLexToken[]): SqlLexToken[] {
  if (!['SELECT', 'UPDATE', 'DELETE'].some(word => tokenIsWord(tokens[0], word))) return [];
  if (tokens.some(token => token.kind === 'word' && ['WITH', 'UNION', 'INTERSECT', 'EXCEPT'].includes(token.value))) return [];
  const literals: SqlLexToken[] = [];
  const local: SqlLexToken[] = [];

  const collect = (start: number, end: number): boolean => {
    for (let index = start; index < end; index++) {
      const token = tokens[index];
      local.push(token);
      if (token.value === ')') return false;
      if (token.value !== '(') continue;
      const after = skipParenthesizedTokens(tokens, index);
      if (after < 0 || after > end) return false;

      if (tokenIsWord(tokens[index + 1], 'SELECT')) literals.push(...queryLiterals(sql, tokens.slice(index + 1, after - 1)));
      else if (!collect(index + 1, after - 1)) return false;
      local.push(tokens[after - 1]);
      index = after - 1;
    }

    return true;
  };

  if (!collect(0, tokens.length)) return [];

  return [...literals, ...predicateLiterals(sql, local, querySources(sql, local))];
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildKeyLookup(keys: string[]): Map<string, string | null> {
  const lookup = new Map<string, string | null>();

  for (const key of new Set(keys)) {
    const normalised = normalise(key);
    if (normalised.length === 0) continue;
    lookup.set(normalised, lookup.has(normalised) ? null : key);
  }

  return lookup;
}

export function repairPropertyKeys(sql: string, keys: string[] | undefined): string {
  if (!keys?.length) return sql;
  const tokens = tokenizeSqlStatement(sql);
  const lookup = buildKeyLookup(keys);
  const literals: SqlLexToken[] = [];
  let start = 0;

  for (let index = 0; index <= tokens.length; index++) {
    if (index < tokens.length && tokens[index].value !== ';') continue;
    literals.push(...queryLiterals(sql, tokens.slice(start, index)));
    start = index + 1;
  }

  const parts: string[] = [];
  let offset = 0;

  for (const literal of literals.sort((a, b) => a.start - b.start)) {
    const raw = literal.value;
    if (literal.start < offset || raw.length < 2 || !raw.endsWith("'") || raw.slice(1, -1).replace(/''/g, '').includes("'")) continue;
    const value = raw.slice(1, -1).replace(/''/g, "'");
    const stored = lookup.get(normalise(value));
    if (!stored || stored === value) continue;
    logger.debug('Corrected a frontmatter name', `${value} to ${stored}`);
    parts.push(sql.slice(offset, literal.start), `'${escapeSqlString(stored)}'`);
    offset = literal.start + raw.length;
  }

  parts.push(sql.slice(offset));

  return parts.join('');
}
