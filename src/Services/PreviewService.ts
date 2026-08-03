import { Database } from 'sql.js';
import { ERROR_MESSAGES, friendlySqliteError } from '../utils/ErrorMessages';
import { collectStatementRows } from '../Database/StatementRows';
import { logger as rootLogger } from '../utils/logger';
import { appendOrReplaceReturning, detectDmlOperation, extractDmlTargetTable, splitSqlStatements, stripLeadingCte, stripReturningClause, stripTrailingSemicolon } from '../utils/SQLParsingUtils';
import type { DmlOperation } from '../utils/SQLParsingUtils';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';
import { formatUnknownValue } from '../utils/ResultFormatUtils';
import { expandListItemViewDeletesSync } from '../WriteSync/ListItemDescendants';

const logger = rootLogger.scope('Preview');

type Row = Record<string, unknown>;
type SqlAndParams = { sql: string; params?: unknown[] };
type ValidatedStatement = { sql: string; op: DmlOperation; table: string; pkCols: string[] };

export type PreviewResult = {
  op: "insert" | "update" | "delete" | "multi";
  table: string;
  pkCols: string[];
  ids: unknown[][];
  rowids?: number[];
  before: Row[];
  after: Row[];
  sqlToApply: SqlAndParams[];
  multiResults?: PreviewResult[];
};

export function previewRowCount(result: Pick<PreviewResult, 'before' | 'after'>): number {
  return Math.max(result.before.length, result.after.length);
}

export function previewTotalRowCount(results: readonly Pick<PreviewResult, 'before' | 'after'>[]): number {
  return results.reduce((sum, result) => sum + previewRowCount(result), 0);
}

export class PreviewService {
  public constructor(private db: Database) {}

  public previewDmlFromSql(sql: string, params: unknown[] = []): PreviewResult {

    const statements = splitSqlStatements(sql);

    if (statements.length > 1) {
      return this.previewMultiStatementDml(statements, params);
    }

    const cleanedSql = statements.length === 1 ? statements[0] : sql;

    this.db.exec('PRAGMA defer_foreign_keys = ON');
    try {
      return this.previewSingleStatementDml(cleanedSql, params);
    }
    finally {
      this.resetDeferredForeignKeys();
    }
  }

  private previewSingleStatementDml(sql: string, params: unknown[] = []): PreviewResult {
    const strippedSql = stripLeadingCte(sql);
    const op = detectDmlOperation(strippedSql);
    if (!op) throw new Error(ERROR_MESSAGES.DML_UNSUPPORTED_OPERATION);

    const table = extractTargetTableViaExplain(this.db, sql);
    if (!table) throw new Error(ERROR_MESSAGES.DML_TABLE_NOT_FOUND);

    const pkCols = getPrimaryKeyCols(this.db, table);
    return this.previewStatementReadOnly({ sql, op, table, pkCols }, params);
  }

  private previewMultiStatementDml(statements: string[], params: unknown[] = []): PreviewResult {
    const validatedStatements: ValidatedStatement[] = [];
    
    for (const stmt of statements) {
      const op = detectDmlOperation(stripLeadingCte(stmt));
      if (!op) {
        throw new Error(ERROR_MESSAGES.DML_INVALID_STATEMENT(previewStatementLabel(stmt)));
      }
      
      const table = extractTargetTableViaExplain(this.db, stmt);
      if (!table) {
        throw new Error(ERROR_MESSAGES.DML_TABLE_NOT_DETERMINED(previewStatementLabel(stmt)));
      }
      
      validatedStatements.push({ sql: stmt, op, table, pkCols: getPrimaryKeyCols(this.db, table) });
    }

    const multiResults: PreviewResult[] = [];
    const savepoint = "multi_preview";
    this.db.exec(`SAVEPOINT ${savepoint}`);
    this.db.exec('PRAGMA defer_foreign_keys = ON');
    let activeStatement = validatedStatements[0];

    try {
      for (const statement of validatedStatements) {
        activeStatement = statement;
        const result = this.previewStatementAndApplyToTransaction(statement, params);
        multiResults.push(result);
      }

      this.db.exec(`ROLLBACK TO ${savepoint}`);
      this.db.exec(`RELEASE ${savepoint}`);
      this.resetDeferredForeignKeys();

      const allSqlToApply = multiResults.flatMap(r => r.sqlToApply);
      
      return {
        op: "multi",
        table: `${validatedStatements.length} tables`,
        pkCols: [],
        ids: [],
        before: [],
        after: [],
        sqlToApply: allSqlToApply,
        multiResults
      };
    }
    catch (e) {
      try {
        this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      }
      catch (rollbackError) {
        // Savepoint rollback is best-effort; preserve the original error below.
        logger.info('Savepoint rollback failed during preview cleanup', rollbackError);
      }
      this.resetDeferredForeignKeys();
      throw new Error(friendlySqliteError(e, activeStatement));
    }
  }

  private previewStatementReadOnly(statement: ValidatedStatement, params: unknown[]): PreviewResult {
    return this.previewStatementWithSavepoint(statement, params, 'read-only');
  }

  private previewStatementAndApplyToTransaction(statement: ValidatedStatement, params: unknown[]): PreviewResult {
    return this.previewStatementWithSavepoint(statement, params, 'apply-to-transaction');
  }

  private previewStatementWithSavepoint(statement: ValidatedStatement, params: unknown[], mode: 'read-only' | 'apply-to-transaction'): PreviewResult {
    const applyChanges = mode === 'apply-to-transaction';
    const savepoint = applyChanges ? 'statement_preview' : 'preview';
    const { sql, op, table, pkCols } = statement;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      if (op === "delete") {
        const affected = executeDeleteAndCaptureRows(this.db, table, sql, params);
        const rowids = tryCollectRowids(affected);
        const ids = affected.map(r => pkCols.map(c => r[c]));

        this.db.exec(`ROLLBACK TO ${savepoint}`);
        const { before, after } = this.buildPreviewRows(op, table, pkCols, affected, ids, rowids);
        this.db.exec(`RELEASE ${savepoint}`);

        if (applyChanges) {
          this.db.run(stripReturningClause(sql), params as (string | number | null | Uint8Array)[]);
        }

        return {
          op, table, pkCols, ids,
          rowids: rowids.length ? rowids : undefined,
          before, after,
          sqlToApply: [{ sql: stripReturningClause(sql), params }]
        };
      }

      let returningList = buildReturningList(pkCols, true);
      let affected: Row[];
      try {
        affected = selectRows(this.db, appendOrReplaceReturning(sql, returningList), params);
      }
      catch {
        returningList = buildReturningList(pkCols, false);
        affected = selectRows(this.db, appendOrReplaceReturning(sql, returningList), params);
      }

      const rowids = tryCollectRowids(affected);
      const ids = affected.map(r => pkCols.map(c => r[c]));

      if (op === "update") {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
      }
      const { before, after } = this.buildPreviewRows(op, table, pkCols, affected, ids, rowids);
      if (op !== "update") {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
      }

      this.db.exec(`RELEASE ${savepoint}`);

      if (applyChanges) {
        this.db.run(stripReturningClause(sql), params as (string | number | null | Uint8Array)[]);
      }

      return {
        op, table, pkCols, ids,
        rowids: rowids.length ? rowids : undefined,
        before, after,
        sqlToApply: [{ sql: stripReturningClause(sql), params }]
      };
    }
    catch (error) {
      try {
        this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      }
      catch (rollbackError) {
        // Savepoint rollback is best-effort; preserve the original error below.
        if (applyChanges) {
          logger.info('Savepoint rollback failed during preview cleanup', rollbackError);
        }
      }
      if (!applyChanges) {
        throw new Error(friendlySqliteError(error, { sql, table }));
      }
      throw error;
    }
  }

  private buildPreviewRows(op: DmlOperation, table: string, pkCols: string[], affected: Row[], ids: unknown[][], rowids: number[]): { before: Row[]; after: Row[] } {
    if (op === "insert") {
      return { before: [], after: affected };
    }

    if (op === "delete") {
      if (table === 'list_items_view') {
        return { before: this.expandListItemsViewDeletes(affected), after: [] };
      }
      return { before: affected, after: [] };
    }

    const before = fetchByIds(this.db, table, pkCols, ids, rowids, true);
    if (before.length === 0 && affected.length > 0) {
      before.push(...this.fetchViewRowsByStableKeys(table, affected));
    }

    return { before, after: affected };
  }

  private fetchViewRowsByStableKeys(table: string, affected: Row[]): Row[] {
    const viewKeyColumns = this.getViewKeyColumns(table, affected[0]);
    if (viewKeyColumns.length === 0) {
      return [];
    }

    const before: Row[] = [];
    for (const affectedRow of affected) {
      const conditions = viewKeyColumns.map(col => `${quoteIdentifier(col)} = ?`).join(' AND ');
      const values = viewKeyColumns.map(col => affectedRow[col]);
      before.push(...selectRows(this.db, `SELECT * FROM ${quoteIdentifier(table)} WHERE ${conditions}`, values));
    }
    return before;
  }

  private expandListItemsViewDeletes(rows: Row[]): Row[] {
    const deletableRows = rows.filter(row =>
      typeof row.path === 'string' && typeof row.list_index === 'number' && typeof row.item_index === 'number');
    return expandListItemViewDeletesSync(deletableRows, (sql, params) => selectRows(this.db, sql, params), 'list_items_view');
  }

  private resetDeferredForeignKeys(): void {
    try {
      this.db.exec('PRAGMA defer_foreign_keys = OFF');
    }
    catch (error) {
      logger.warn('Failed to reset PRAGMA defer_foreign_keys', error);
    }
  }

  private getViewKeyColumns(table: string, sampleRow: Row): string[] {
    const viewKeyPatterns: Record<string, string[]> = {
      'headings_view': ['path', 'level', 'line_number'],
      'table_rows': ['path', 'table_index', 'row_index'],
      'note_properties': ['path', 'key'],
    };

    const patternKeys = viewKeyPatterns[table];
    if (patternKeys?.every(k => k in sampleRow)) return patternKeys;

    if (table.endsWith('_table') && ['path', 'table_index', 'row_index'].every(k => k in sampleRow)) {
      return ['path', 'table_index', 'row_index'];
    }

    if ('id' in sampleRow) return ['id'];
    if ('path' in sampleRow && 'line_number' in sampleRow) return ['path', 'line_number'];
    if ('path' in sampleRow) return ['path'];

    return [];
  }

}

function selectRows(db: Database, sql: string, params: unknown[] = []): Row[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params as (string | number | null | Uint8Array)[]);
    return collectStatementRows(stmt);
  } finally {
    stmt.free();
  }
}

function buildReturningList(pkCols: string[], tryRowid: boolean): string {
  const parts: string[] = [];
  if (tryRowid) parts.push("rowid");
  for (const c of pkCols) parts.push(quoteIdentifier(c));
  parts.push("*");
  return parts.join(", ");
}

function executeDeleteAndCaptureRows(db: Database, table: string, sql: string, params: unknown[]): Row[] {
  const columns = getTableColumns(db, table);
  if (columns.length === 0) {
    db.run(stripReturningClause(sql), params as (string | number | null | Uint8Array)[]);
    return [];
  }

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const captureTable = `_vq_preview_delete_capture_${suffix}`;
  const captureTrigger = `_vq_preview_delete_trigger_${suffix}`;
  const columnList = columns.map(quoteIdentifier).join(', ');
  const oldValueList = columns.map(column => `OLD.${quoteIdentifier(column)}`).join(', ');
  const triggerTiming = getSchemaObjectType(db, table) === 'view' ? 'INSTEAD OF' : 'BEFORE';

  db.run(`CREATE TEMP TABLE ${quoteIdentifier(captureTable)} (${columnList})`);
  db.run(`CREATE TEMP TRIGGER ${quoteIdentifier(captureTrigger)}
${triggerTiming} DELETE ON ${quoteIdentifier(table)}
BEGIN
  INSERT INTO ${quoteIdentifier(captureTable)} (${columnList})
  VALUES (${oldValueList});
END;`);

  db.run(stripReturningClause(sql), params as (string | number | null | Uint8Array)[]);
  return selectRows(db, `SELECT * FROM ${quoteIdentifier(captureTable)}`);
}

function getTableColumns(db: Database, table: string): string[] {
  return selectRows(db, `PRAGMA table_info(${quoteIdentifier(table)})`)
    .map(row => row.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function getSchemaObjectType(db: Database, table: string): string | null {
  const row = selectRows(
    db,
    `SELECT type FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view') LIMIT 1`,
    [table]
  )[0];

  return typeof row?.type === 'string' ? row.type : null;
}

function tryCollectRowids(rows: Row[]): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r.rowid;
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function fetchByIds(db: Database, table: string, pkCols: string[], ids: unknown[][], rowids: number[], preferRowids: boolean = false): Row[] {
  if (preferRowids && rowids.length) {
    const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE rowid IN (${qMarks(rowids.length)})`;
    return selectRows(db, sql, rowids);
  }

  if (ids.length && pkCols.length) {
    const hasNulls = ids.some(t => t.some(v => v === null));

    if (hasNulls) {
      const conditions: string[] = [];
      const allParams: unknown[] = [];

      for (const tuple of ids) {
        const parts: string[] = [];
        for (let i = 0; i < pkCols.length; i++) {
          const col = quoteIdentifier(pkCols[i]);
          if (tuple[i] === null) {
            parts.push(`${col} IS NULL`);
          }
          else {
            parts.push(`${col} = ?`);
            allParams.push(tuple[i]);
          }
        }
        conditions.push(`(${parts.join(' AND ')})`);
      }

      const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE ${conditions.join(' OR ')}`;
      return selectRows(db, sql, allParams);
    }
    else {
      const cols = pkCols.map(quoteIdentifier).join(", ");
      const placeholders = ids.map(t => `(${qMarks(t.length)})`).join(", ");
      const flatParams = ids.flat();
      const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE (${cols}) IN (${placeholders})`;
      return selectRows(db, sql, flatParams);
    }
  }
  if (rowids.length) {
    const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE rowid IN (${qMarks(rowids.length)})`;
    return selectRows(db, sql, rowids);
  }
  return [];
}

function qMarks(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

function extractTargetTableViaExplain(db: Database, sql: string): string | null {
  const s = stripTrailingSemicolon(sql).trim();
  const syntaxTarget = extractDmlTargetTable(sql);

  if (syntaxTarget) {
    try {
      const viewCheck = selectRows(db, `SELECT type FROM sqlite_schema WHERE name = ? AND type = 'view' LIMIT 1`, [syntaxTarget])[0];
      if (viewCheck) {
        return syntaxTarget;
      }
    }
    catch (error) {
      logger.warn('Could not check whether the target is a view', error);
    }
  }

  try {
    const rows = selectRows(db, `EXPLAIN ${s}`);

    for (const row of rows) {
      const opcode = formatUnknownValue(row.opcode).toUpperCase();
      if (opcode !== "OPENWRITE") continue;

      const rootpage = Number(row.p2);
      if (!Number.isFinite(rootpage)) {
        continue;
      }

      const hit = selectRows(db, `SELECT type, name, tbl_name FROM sqlite_schema WHERE rootpage = ? LIMIT 1`, [rootpage])[0];
      if (!hit) {
        continue;
      }

      if (String(hit.type).toLowerCase() === "table") {
        const tableName = String(hit.name);
        if (tableName === 'sqlite_sequence' && syntaxTarget) {
          return syntaxTarget;
        }
        return tableName;
      }
      if (String(hit.type).toLowerCase() === "index") {
        return String(hit.tbl_name);
      }
    }
  }
  catch (error) {
    logger.warn('Could not map target table with EXPLAIN; trying SQL text parsing', error);
  }

  return syntaxTarget;
}

function getPrimaryKeyCols(db: Database, table: string): string[] {
  const rows = selectRows(db, `PRAGMA table_info(${quoteIdentifier(table)})`);
  return rows
    .filter(r => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(r => String(r.name));
}

function previewStatementLabel(sql: string): string {
  const compact = sql.replace(/\s+/g, ' ').trim();
  return compact.length > 50 ? `${compact.substring(0, 50)}...` : compact;
}
