import type { CliData, CliFlags } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { detectDmlOperationInSql, splitSqlStatements } from '../utils/SQLParsingUtils';
import { formatResults } from '../utils/ResultExport';
import type { ExportFormat } from '../utils/ResultExport';
import { logger as rootLogger } from '../utils/logger';

type QueryFormat = ExportFormat;
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
    await plugin.indexingStateManager.waitForIndexingComplete();
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
  const dataFileColumns = await api.getDataFileColumnNames(results);

  return formatResults(results, format, { dataFileColumns });
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
