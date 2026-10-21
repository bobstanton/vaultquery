import type { SchemaTable } from '../Database/SchemaDocumentation';
import type { GeneratedVaultQuery, LlmProvider, LlmReadOutputKind, SqlGenerationAttempt, SqlGenerationProgress } from './LlmTypes';
import { resolveOutput } from './LlmTypes';
import { buildSqlPrompt } from './PromptBuilder';
import { extractGeneratedVaultQuery } from './SqlExtractor';
import { isSelectOnly, isWriteOnly } from '../utils/SQLParsingUtils';
import { getErrorMessage } from '../utils/ErrorMessages';
import { logger as rootLogger } from '../utils/logger';
import { repairPropertyKeys } from './SqlRepair';

const logger = rootLogger.scope('LlmService');

const DEFAULT_MAX_RETRIES = 2;

const RETRY_TEMPERATURE = 0.4;

const UNINDEXED_FEATURE_PATTERN = /table is referenced but .+ is disabled\. Enable it in Settings/i;

export interface GenerateAndRunDeps {
  schema: SchemaTable[];
  provider: LlmProvider;
  runSql: (sql: string) => Promise<unknown>;
  previewWriteSql?: (sql: string) => Promise<unknown>;
  propertyKeys?: string[];
  maxRetries?: number;
  allowWriteOperations?: boolean;
  requestedOutput?: LlmReadOutputKind;
  requestedOutputOptions?: Record<string, string>;
  onProgress?: (progress: SqlGenerationProgress) => void;
}

export class SqlGenerationError extends Error {
  public readonly sql: string;
  public readonly cause?: unknown;

  constructor(message: string, sql: string, cause?: unknown) {
    super(message);
    this.name = 'SqlGenerationError';
    this.sql = sql;
    this.cause = cause;
  }
}

function isUnindexedFeatureError(error: unknown): boolean {
  return UNINDEXED_FEATURE_PATTERN.test(getErrorMessage(error));
}

function validateReadOutput(generated: GeneratedVaultQuery, result: unknown, deps: GenerateAndRunDeps): void {
  const { kind: outputKind, options } = resolveOutput(generated, deps.requestedOutput, deps.requestedOutputOptions);
  const rows = Array.isArray(result) ? result as Array<Record<string, unknown>> : [];
  const columns = rows.length > 0 ? new Set(Object.keys(rows[0])) : new Set<string>();

  if (outputKind === 'chart') {
    const chartType = options.type?.toLowerCase();

    if (!chartType || !['bar', 'line', 'pie', 'doughnut', 'scatter'].includes(chartType)) {
      throw new Error('Chart output requires config with type: bar, line, pie, doughnut, or scatter.');
    }

    if (rows.length > 0 && chartType === 'scatter' && (!columns.has('x') || !columns.has('y'))) {
      throw new Error('Scatter chart output requires query columns named x and y.');
    }

    if (rows.length > 0 && chartType !== 'scatter' && (!columns.has('label') || !columns.has('value'))) {
      throw new Error('Chart output requires query columns named label and value.');
    }
  }

  if (outputKind === 'calendar' && rows.length > 0) {
    const normalizedColumns = new Set([...columns].map(column => column.toLowerCase()));

    if (!normalizedColumns.has('date')) {
      throw new Error('Calendar output requires a query column named date.');
    }
  }
}

export async function generateAndRun(question: string, deps: GenerateAndRunDeps): Promise<GeneratedVaultQuery> {
  const trimmedQuestion = question.trim();

  if (trimmedQuestion.length === 0) {
    throw new Error('Enter a query request.');
  }

  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const previousAttempts: SqlGenerationAttempt[] = [];
  let lastSql = '';
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const reportProgress = (phase: SqlGenerationProgress['phase']) => {
      deps.onProgress?.({ phase, attempt, maxAttempts: maxRetries + 1 });
    };

    reportProgress('preparing-prompt');

    const prompt = buildSqlPrompt({
      question: trimmedQuestion,
      schema: deps.schema,
      previousAttempts,
      propertyKeys: deps.propertyKeys,
      allowWriteOperations: deps.allowWriteOperations,
      requestedOutput: deps.requestedOutput
    });

    reportProgress('waiting-for-model');
    const response = await deps.provider.complete(prompt, { temperature: attempt === 1 ? 0 : RETRY_TEMPERATURE });
    reportProgress('validating-query');
    const generated = extractGeneratedVaultQuery(response);
    const sql = repairPropertyKeys(generated.sql, deps.propertyKeys);
    lastSql = sql;

    logger.debug('Generated SQL', sql);

    if (sql.length === 0) {
      throw new SqlGenerationError('The model did not return any SQL.', sql, null);
    }

    if (generated.statementKind === 'write') {
      if (!deps.allowWriteOperations) {
        throw new SqlGenerationError(
          'The model returned a write operation, but natural-language write operations are disabled. The statement was not run.',
          sql,
          null
        );
      }

      if (!isWriteOnly(sql)) {
        throw new SqlGenerationError(
          'The model returned something other than INSERT, UPDATE, or DELETE statements. The statement was not run.',
          sql,
          null
        );
      }
    }
    else if (!isSelectOnly(sql)) {
      throw new SqlGenerationError(
        'The model returned something other than a single SELECT statement. The statement was not run.',
        sql,
        null
      );
    }

    try {
      if (generated.statementKind === 'write' && !deps.previewWriteSql) {
        throw new Error('Natural-language write preview is not available.');
      }

      reportProgress(generated.statementKind === 'write' ? 'previewing-write' : 'executing-query');

      const result = generated.statementKind === 'write'
        ? await deps.previewWriteSql!(sql)
        : await deps.runSql(sql);

      if (generated.statementKind === 'read') {
        reportProgress('validating-results');
        validateReadOutput({ ...generated, sql }, result, deps);
      }

      return { ...generated, sql };
    }
    catch (error) {
      if (isUnindexedFeatureError(error)) {
        throw error;
      }

      lastError = error;
      previousAttempts.push({ sql, error: getErrorMessage(error) });
    }
  }

  throw new SqlGenerationError(
    `The generated query still failed after ${previousAttempts.length} attempts: ${getErrorMessage(lastError)}`,
    lastSql,
    lastError
  );
}
