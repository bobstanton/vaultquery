import type { CliData, CliFlags } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { detectDmlOperationInSql, splitSqlStatements } from '../utils/SQLParsingUtils';
import { formatResultsAsDelimited, formatResultsAsMarkdown, scalarFromResults } from '../utils/ResultFormatUtils';
import { logger as rootLogger } from '../utils/logger';

type QueryFormat = 'json' | 'csv' | 'tsv' | 'md' | 'scalar';
interface CliStatementClassification {
  hasDml: boolean;
  hasNonDml: boolean;
}

const QUERY_FLAGS: CliFlags = {
  sql: {
    value: '<sql>',
    description: 'SQL query to execute',
    required: true
  },
  path: {
    value: '<path>',
    description: 'Vault-relative note path used for {this.*} placeholders'
  },
  format: {
    value: '<json|csv|tsv|md|scalar>',
    description: 'Output format for SELECT/WITH queries. Default: json'
  }
};

const DEBUG_LOG_FLAGS: CliFlags = {
  clear: {
    value: '<true|false>',
    description: 'Clear the in-memory debug log after exporting it'
  }
};

function normalizeFormat(value: string | undefined): QueryFormat {
  const format = (value || 'json').toLowerCase();
  if (format === 'json' || format === 'csv' || format === 'tsv' || format === 'md' || format === 'scalar') {
    return format;
  }

  throw new Error(`Unsupported format: ${value}. Use json, csv, tsv, md, or scalar.`);
}

function formatResults(results: Record<string, unknown>[], format: QueryFormat): string {
  if (format === 'json') {
    return JSON.stringify(results, null, 2);
  }

  if (format === 'csv') {
    return formatResultsAsDelimited(results, ',');
  }

  if (format === 'tsv') {
    return formatResultsAsDelimited(results, '\t');
  }

  if (format === 'md') {
    return formatResultsAsMarkdown(results, { scanAllRows: true });
  }

  return scalarFromResults(results);
}

function classifyCliStatements(sql: string): CliStatementClassification {
  const statements = splitSqlStatements(sql);
  const normalizedStatements = statements.length > 0 ? statements : [sql.trim()];

  return normalizedStatements.reduce<CliStatementClassification>((classification, statement) => {
    if (detectDmlOperationInSql(statement)) {
      classification.hasDml = true;
    }
    else {
      classification.hasNonDml = true;
    }
    return classification;
  }, { hasDml: false, hasNonDml: false });
}

async function runCliQuery(plugin: VaultQueryPluginContext, params: CliData): Promise<string> {
  if (!plugin.settings.enableCli) {
    throw new Error('VaultQuery CLI is disabled. Enable it in VaultQuery settings.');
  }

  const sql = typeof params.sql === 'string' ? params.sql.trim() : '';
  if (!sql) {
    throw new Error('Missing required sql=<query> parameter.');
  }

  const path = typeof params.path === 'string' ? params.path : undefined;

  const api = plugin.api;
  if (!api) {
    throw new Error('VaultQuery is not ready. The plugin may have been unloaded.');
  }

  await plugin.indexingStateManager.waitForIndexingComplete();

  const statementClassification = classifyCliStatements(sql);
  if (statementClassification.hasDml) {
    if (statementClassification.hasNonDml) {
      throw new Error('VaultQuery CLI write statements cannot be mixed with read-only statements. Run SELECT/WITH queries separately from INSERT, UPDATE, and DELETE statements.');
    }

    if (!plugin.settings.enableCliWriteOperations) {
      throw new Error('VaultQuery CLI write operations are disabled.');
    }

    const preview = await api.previewQuery(sql, [], path);
    const affectedPaths = await api.applyPreview(preview);
    for (const affectedPath of affectedPaths) {
      plugin.indexingStateManager.queueIndexing(affectedPath);
    }

    return JSON.stringify({
      applied: affectedPaths.length > 0,
      affectedPaths
    }, null, 2);
  }

  const format = normalizeFormat(typeof params.format === 'string' ? params.format : undefined);
  const results = await api.query(sql, path);
  return formatResults(results, format);
}

function runCliDebugLog(params: CliData): string {
  const output = rootLogger.formatForExport();
  if (params.clear === 'true' || params.clear === '1') {
    rootLogger.clear();
  }
  return output;
}

export function registerVaultQueryCliHandlers(plugin: VaultQueryPluginContext): void {
  plugin.registerCliHandler(
    'vaultquery:query',
    'Run a VaultQuery SQL query',
    QUERY_FLAGS,
    params => runCliQuery(plugin, params)
  );

  plugin.registerCliHandler(
    'vaultquery:debug-log',
    'Print the VaultQuery debug log',
    DEBUG_LOG_FLAGS,
    params => runCliDebugLog(params)
  );
}
