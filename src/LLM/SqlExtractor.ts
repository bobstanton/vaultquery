import type { GeneratedVaultQuery, LlmReadOutputKind } from './LlmTypes';
import { outputFenceLanguage, READ_OUTPUT_KINDS } from './LlmTypes';
import { parseQueryBlock, splitQuerySections } from '../utils/QueryParsingUtils';
import { detectSqlOperation, isWriteOnly, splitSqlStatements, stripTrailingSemicolon, tokenizeSqlStatement } from '../utils/SQLParsingUtils';
import { scanMarkdownCodeFences } from '../utils/MarkdownFenceUtils';

const STATEMENT_START_WORDS = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE']);

function tidy(sql: string): string {
  return stripTrailingSemicolon(sql.trim()).trim();
}

function firstStatementFromProse(response: string): string {
  const tokens = tokenizeSqlStatement(response);

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const previous = tokens[index - 1];

    if (token.kind === 'literal' && previous?.kind === 'word' && previous.end === token.start) {
      return firstStatementFromProse(response.slice(token.start + 1));
    }

    if (token.kind !== 'word' || !STATEMENT_START_WORDS.has(token.value)) continue;
    if (previous?.value === '.' && !/[\r\n]/.test(response.slice(previous.end, token.start))) continue;
    const [statement] = splitSqlStatements(response.slice(token.start));

    if (statement && detectSqlOperation(statement) !== null) return statement;
  }

  return '';
}

function plainSqlQuery(sql: string): GeneratedVaultQuery {
  return { sql, statementKind: isWriteOnly(sql) ? 'write' : 'read', outputKind: 'table' };
}

const SQL_FENCE_LANGUAGES = new Set(['sql', 'sqlite']);

const OUTPUT_KIND_BY_FENCE = new Map<string, LlmReadOutputKind>([...READ_OUTPUT_KINDS].map(kind => [outputFenceLanguage(kind), kind]));

export function extractGeneratedVaultQuery(response: string): GeneratedVaultQuery {
  const fences = scanMarkdownCodeFences(response).map(fence => ({ ...fence, language: fence.language.toLowerCase() }));
  const supported = fences.find(fence => fence.language === 'vaultquery-write' || OUTPUT_KIND_BY_FENCE.has(fence.language) || SQL_FENCE_LANGUAGES.has(fence.language));

  if (!supported) {
    const fenced = fences.find(fence => fence.language !== 'json')?.source;

    return plainSqlQuery(tidy(fenced?.trim() ? fenced : firstStatementFromProse(response)));
  }

  if (supported.language === 'vaultquery-write') {
    return {
      sql: tidy(splitQuerySections(supported.source).sqlQuery),
      statementKind: 'write',
      outputKind: 'table'
    };
  }

  const outputKind = OUTPUT_KIND_BY_FENCE.get(supported.language);

  if (!outputKind) {
    return plainSqlQuery(tidy(supported.source));
  }

  const parsed = parseQueryBlock(supported.source, { forceOutputKind: outputKind });

  return {
    sql: tidy(parsed.query),
    statementKind: isWriteOnly(parsed.query) ? 'write' : 'read',
    outputKind,
    outputOptions: parsed.output?.options as Record<string, string> | undefined
  };
}
