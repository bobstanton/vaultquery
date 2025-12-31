import { Database } from 'sql.js';
import { App, normalizePath } from 'obsidian';
import { friendlySqliteError } from '../utils/ErrorMessages';

type Row = Record<string, unknown>;
type SqlAndParams = { sql: string; params?: unknown[] };

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

export class PreviewService {
  public constructor(private db: Database, private app?: App) {}

  public previewDmlFromSql(sql: string, params: unknown[] = []): PreviewResult {

    const statements = splitSqlStatements(sql);

    if (statements.length > 1) {
      return this.previewMultiStatementDml(statements, params);
    }

    const cleanedSql = statements.length === 1 ? statements[0] : sql;

    this.db.exec(`PRAGMA defer_foreign_keys = ON`);
    try {
      const result = this.previewSingleStatementDml(cleanedSql, params);
      this.db.exec(`PRAGMA defer_foreign_keys = OFF`);
      return result;
    }
    catch (e) {
      this.db.exec(`PRAGMA defer_foreign_keys = OFF`);
      throw e;
    }
  }

  private previewSingleStatementDml(sql: string, params: unknown[] = []): PreviewResult {
    const strippedSql = stripLeadingCte(sql);
    const op = detectOperation(strippedSql);
    if (!op) throw new Error("Only INSERT, UPDATE, or DELETE are supported.");

    const table = extractTargetTableViaExplain(this.db, sql);
    if (!table) throw new Error("Could not determine target table via EXPLAIN rootpage mapping.");

    const pkCols = getPrimaryKeyCols(this.db, table);
    const savepoint = "preview";
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      let returningList = buildReturningList(pkCols, true);
      let affected: Row[];
      try {
        affected = selectRows(this.db, withReturning(sql, returningList), params);
      }
      catch {
        returningList = buildReturningList(pkCols, false);
        affected = selectRows(this.db, withReturning(sql, returningList), params);
      }

      const rowids = tryCollectRowids(affected);
      const ids = affected.map(r => pkCols.map(c => r[c]));

      let before: Row[] = [];
      let after: Row[] = [];

      if (op === "update") {
        after = affected;

        this.db.exec(`ROLLBACK TO ${savepoint}`);

        before = fetchByIds(this.db, table, pkCols, ids, rowids, true);

        if (before.length === 0 && affected.length > 0) {
          const viewKeyColumns = this.getViewKeyColumns(table, affected[0]);

          if (viewKeyColumns.length > 0) {
            for (const affectedRow of affected) {
              const conditions = viewKeyColumns.map(col => `${quoteIdent(col)} = ?`).join(' AND ');
              const values = viewKeyColumns.map(col => affectedRow[col]);
              const rows = selectRows(this.db, `SELECT * FROM ${quoteIdent(table)} WHERE ${conditions}`, values);
              before.push(...rows);
            }
          }
        }
      }
      else if (op === "insert") {
        after = affected;
        before = [];
        this.db.exec(`ROLLBACK TO ${savepoint}`);
      }
      else {
        before = affected;
        after = [];
        this.db.exec(`ROLLBACK TO ${savepoint}`);
      }

      this.db.exec(`RELEASE ${savepoint}`);

      return {
        op, table, pkCols, ids,
        rowids: rowids.length ? rowids : undefined,
        before, after,
        sqlToApply: [{ sql: stripReturning(sql), params }]
      };
    }
    catch (e) {
      try {
        this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      }
      catch {
        // Rollback failed - nothing we can do, re-throw original error
      }
      throw new Error(friendlySqliteError(e, { sql, table }));
    }
  }

  private previewMultiStatementDml(statements: string[], params: unknown[] = []): PreviewResult {
    const validatedStatements: Array<{ sql: string; op: string; table: string }> = [];
    
    for (const stmt of statements) {
      const op = detectOperation(stripLeadingCte(stmt));
      if (!op) {
        throw new Error(`Invalid statement detected: "${stmt.substring(0, 50)}...". Only INSERT, UPDATE, or DELETE are supported.`);
      }
      
      const table = extractTargetTableViaExplain(this.db, stmt);
      if (!table) {
        throw new Error(`Could not determine target table for statement: "${stmt.substring(0, 50)}..."`);
      }
      
      validatedStatements.push({ sql: stmt, op, table });
    }

    const multiResults: PreviewResult[] = [];
    const savepoint = "multi_preview";
    this.db.exec(`SAVEPOINT ${savepoint}`);
    this.db.exec(`PRAGMA defer_foreign_keys = ON`);

    try {
      for (let i = 0; i < validatedStatements.length; i++) {
        const { sql } = validatedStatements[i];
        const result = this.previewSingleStatementDml(sql, params);
        multiResults.push(result);
      }

      this.db.exec(`ROLLBACK TO ${savepoint}`);
      this.db.exec(`RELEASE ${savepoint}`);
      this.db.exec(`PRAGMA defer_foreign_keys = OFF`);

      const allSqlToApply = multiResults.flatMap(r => r.sqlToApply);
      const _totalRowsAffected = multiResults.reduce((sum, r) => sum + Math.max(r.before.length, r.after.length), 0);
      
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
        this.db.exec(`PRAGMA defer_foreign_keys = OFF`);
      }
      catch {
        // Cleanup failed - nothing we can do, re-throw original error
      }
      throw new Error(friendlySqliteError(e, {}));
    }
  }

  private getViewKeyColumns(table: string, sampleRow: Row): string[] {
    const viewKeyPatterns: Record<string, string[]> = {
      'headings_view': ['path', 'level', 'line_number'],
      'table_rows': ['path', 'table_index', 'row_index'],
      'note_properties': ['path', 'key'],
    };

    if (viewKeyPatterns[table]) {
      const keys = viewKeyPatterns[table];
      if (keys.every(k => k in sampleRow)) {
        return keys;
      }
    }

    if ('id' in sampleRow) {
      return ['id'];
    }

    if ('path' in sampleRow && 'line_number' in sampleRow) {
      return ['path', 'line_number'];
    }

    if ('path' in sampleRow) {
      return ['path'];
    }

    return [];
  }

  public enhanceWithVaultValidation(result: PreviewResult): PreviewResult & { warnings?: string[] } {
    if (!this.app?.vault || !this.app?.metadataCache) return result;

    const warnings: string[] = [];
    
    if (result.table === 'notes' || result.table === 'notes_with_properties') {
      [...result.before, ...result.after].forEach(row => {
        if (row.path) {
          const pathStr = String(row.path);
          const file = this.app?.vault.getAbstractFileByPath(normalizePath(pathStr));
          if (!file && result.op !== 'insert') {
            warnings.push(`File not found in vault: ${pathStr}`);
          }
          else if (file && result.op === 'insert') {
            warnings.push(`File already exists in vault: ${pathStr}`);
          }
        }
      });
    }

    return {
      ...result,
      warnings: warnings.length > 0 ? warnings : undefined
    } as PreviewResult & { warnings?: string[] };
  }
}

function selectRows(db: Database, sql: string, params: unknown[] = []): Row[] {
  const stmt = db.prepare(sql);
  const out: Row[] = [];
  try {
    stmt.bind(params as (string | number | null | Uint8Array)[]);
    const columnNames = stmt.getColumnNames();
    while (stmt.step()) {
      // Use "first wins" behavior for duplicate column names (important for JOINs)
      const values = stmt.get();
      const row: Row = {};
      for (let i = 0; i < columnNames.length; i++) {
        const colName = columnNames[i];
        if (!(colName in row)) {
          row[colName] = values[i];
        }
      }
      out.push(row);
    }
  } finally {
    stmt.free();
  }
  return out;
}

function buildReturningList(pkCols: string[], tryRowid: boolean): string {
  const parts: string[] = [];
  if (tryRowid) parts.push("rowid");
  for (const c of pkCols) parts.push(quoteIdent(c));
  parts.push("*");
  return parts.join(", ");
}

function withReturning(sql: string, returningList: string): string {
  const cleaned = stripComments(sql);
  const s = stripTrailingSemicolon(cleaned);

  const returningPos = findKeywordOutsideStrings(s, 'returning');

  if (returningPos >= 0) {
    return s.substring(0, returningPos) + `RETURNING ${returningList}`;
  }

  return `${s} RETURNING ${returningList}`;
}

function stripReturning(sql: string): string {
  const cleaned = stripComments(sql);
  const s = stripTrailingSemicolon(cleaned);

  const returningPos = findKeywordOutsideStrings(s, 'returning');

  if (returningPos >= 0) {
    return s.substring(0, returningPos).replace(/\s+$/, '');
  }

  return s;
}

function findKeywordOutsideStrings(sql: string, keyword: string): number {
  const keywordUpper = keyword.toUpperCase();
  const keywordLen = keyword.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBracket = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    if (c === "'" && !inDoubleQuote && !inBacktick && !inBracket) {
      if (sql[i + 1] === "'") {
        i++; // Skip escaped quote
        continue;
      }
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (c === '"' && !inSingleQuote && !inBacktick && !inBracket) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (c === '`' && !inSingleQuote && !inDoubleQuote && !inBracket) {
      inBacktick = !inBacktick;
      continue;
    }
    if (c === '[' && !inSingleQuote && !inDoubleQuote && !inBacktick && !inBracket) {
      inBracket = true;
      continue;
    }
    if (c === ']' && inBracket) {
      inBracket = false;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktick || inBracket) {
      continue;
    }

    if (i + keywordLen <= sql.length) {
      const slice = sql.substring(i, i + keywordLen);
      if (slice.toUpperCase() === keywordUpper) {
        const charBefore = i > 0 ? sql[i - 1] : ' ';
        const charAfter = i + keywordLen < sql.length ? sql[i + keywordLen] : ' ';

        if (!isWordChar(charBefore) && !isWordChar(charAfter)) {
          return i;
        }
      }
    }
  }

  return -1;
}

function isWordChar(c: string): boolean {
  return /[a-zA-Z0-9_]/.test(c);
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, "");
}

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
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
    const sql = `SELECT * FROM ${quoteIdent(table)} WHERE rowid IN (${qMarks(rowids.length)})`;
    return selectRows(db, sql, rowids);
  }

  if (ids.length && pkCols.length) {
    const tupleSize = pkCols.length;
    const tuples = ids.filter(t => t.length === tupleSize);
    if (tuples.length) {
      const hasNulls = tuples.some(t => t.some(v => v === null));

      if (hasNulls) {
        const conditions: string[] = [];
        const allParams: unknown[] = [];

        for (const tuple of tuples) {
          const parts: string[] = [];
          for (let i = 0; i < pkCols.length; i++) {
            const col = quoteIdent(pkCols[i]);
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

        const sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${conditions.join(' OR ')}`;
        return selectRows(db, sql, allParams);
      }
      else {
        const cols = pkCols.map(quoteIdent).join(", ");
        const placeholders = tuples.map(t => `(${qMarks(t.length)})`).join(", ");
        const flatParams = tuples.flat();
        const sql = `SELECT * FROM ${quoteIdent(table)} WHERE (${cols}) IN (${placeholders})`;
        return selectRows(db, sql, flatParams);
      }
    }
  }
  if (rowids.length) {
    const sql = `SELECT * FROM ${quoteIdent(table)} WHERE rowid IN (${qMarks(rowids.length)})`;
    return selectRows(db, sql, rowids);
  }
  return [];
}

function qMarks(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

function extractTargetTableViaExplain(db: Database, sql: string): string | null {
  const s = stripTrailingSemicolon(sql).trim();
  
  const syntaxTarget = extractTargetTableFallback(sql);
  
  if (syntaxTarget) {
    try {
      const viewCheck = selectRows(db, `SELECT type FROM sqlite_schema WHERE name = ? AND type = 'view' LIMIT 1`, [syntaxTarget])[0];
      if (viewCheck) {
        return syntaxTarget;
      }
    }
    catch (error) {
      console.warn('[VaultQuery] Failed to check if target is a view:', error);
    }
  }
  try {
    const rows = selectRows(db, `EXPLAIN ${s}`);
    
    for (const row of rows) {
      const opcode = String(row.opcode ?? row.Opcode ?? "").toUpperCase();
      if (opcode !== "OPENWRITE") continue;

      const rootpage = Number(row.p2 ?? row.P2);
      
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
        const tableName = String(hit.tbl_name);
        return tableName;
      }
    }
    
  }
    
  catch (error) {
    console.warn('[VaultQuery] EXPLAIN rootpage mapping failed, falling back to regex parsing:', error);
    return extractTargetTableFallback(sql);
  }
  
  if (syntaxTarget) {
    return syntaxTarget;
  }
  
  return null;
}

function extractTargetTableFallback(sql: string): string | null {
  const body = stripLeadingCte(stripTrailingSemicolon(sql));
  const op = detectOperation(body);
  if (!op) return null;
  if (op === "insert") {
    const m = /^\s*INSERT\s+(?:OR\s+\w+\s+)?(?:INTO\s+)?([`"[\]\w.]+)/i.exec(body);
    return m ? unquoteIdent(lastIdent(m[1])) : null;
  }
  if (op === "update") {
    const m = /^\s*UPDATE\s+(?:OR\s+\w+\s+)?([`"[\]\w.]+)/i.exec(body);
    return m ? unquoteIdent(lastIdent(m[1])) : null;
  }
  const m = /^\s*DELETE\s+FROM\s+([`"[\]\w.]+)/i.exec(body);
  return m ? unquoteIdent(lastIdent(m[1])) : null;
}

function getPrimaryKeyCols(db: Database, table: string): string[] {
  const rows = selectRows(db, `PRAGMA table_info(${quoteIdent(table)})`);
  return rows
    .filter(r => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(r => String(r.name));
}

function detectOperation(s: string): "insert" | "update" | "delete" | null {
  const up = s.trim().toUpperCase();
  if (up.startsWith("INSERT")) return "insert";
  if (up.startsWith("UPDATE")) return "update";
  if (up.startsWith("DELETE")) return "delete";
  return null;
}

function splitSqlStatements(sql: string): string[] {
  const cleaned = stripComments(sql);
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBracket = false;

  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];

    if (c === "'" && !inDoubleQuote && !inBacktick && !inBracket) {
      if (cleaned[i + 1] === "'") {
        current += "''";
        i++; 
        continue;
      }
      inSingleQuote = !inSingleQuote;
    }
    else if (c === '"' && !inSingleQuote && !inBacktick && !inBracket) {
      inDoubleQuote = !inDoubleQuote;
    }
    else if (c === '`' && !inSingleQuote && !inDoubleQuote && !inBracket) {
      inBacktick = !inBacktick;
    }
    else if (c === '[' && !inSingleQuote && !inDoubleQuote && !inBacktick && !inBracket) {
      inBracket = true;
    }
    else if (c === ']' && inBracket) {
      inBracket = false;
    }

    if (c === ';' && !inSingleQuote && !inDoubleQuote && !inBacktick && !inBracket) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
    }
    else {
      current += c;
    }
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }

  return statements;
}

function stripComments(sql: string): string {
  let result = '';
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBracket = false;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1] || '';

    if (c === "'" && !inDoubleQuote && !inBacktick && !inBracket) {
      if (next === "'") {
        result += "''";
        i += 2;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      result += c;
      i++;
      continue;
    }

    if (c === '"' && !inSingleQuote && !inBacktick && !inBracket) {
      inDoubleQuote = !inDoubleQuote;
      result += c;
      i++;
      continue;
    }

    if (c === '`' && !inSingleQuote && !inDoubleQuote && !inBracket) {
      inBacktick = !inBacktick;
      result += c;
      i++;
      continue;
    }

    if (c === '[' && !inSingleQuote && !inDoubleQuote && !inBacktick && !inBracket) {
      inBracket = true;
      result += c;
      i++;
      continue;
    }
    if (c === ']' && inBracket) {
      inBracket = false;
      result += c;
      i++;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktick || inBracket) {
      result += c;
      i++;
      continue;
    }

    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < sql.length) {
        if (i < sql.length - 1 && sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += c;
    i++;
  }

  return result.split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .join('\n');
}

function stripCommentsAndWhitespace(s: string): string {
  return stripComments(s).trim();
}

function stripLeadingCte(s: string): string {
  const t = stripCommentsAndWhitespace(s);
  if (!/^(WITH)\b/i.test(t)) return t;
  const idx = findTopLevelFirst(t, ["INSERT", "UPDATE", "DELETE"]);
  return idx >= 0 ? t.slice(idx) : t;
}

function findTopLevelFirst(s: string, words: string[]): number {
  const W = words.map(w => new RegExp("^" + w + "\\b", "i"));
  let i = 0, inS = false, inD = false, inB = false;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (!inD && !inB && c === "'" && n !== "'") inS = !inS;
    else if (!inS && !inB && c === '"') inD = !inD;
    else if (!inS && !inD && (c === '`' || c === '[')) inB = true;
    else if (inB && (c === '`' || c === ']')) inB = false;
    if (!inS && !inD && !inB) {
      for (const re of W) if (re.test(s.slice(i))) return i;
    }
    i++;
  }
  return -1;
}

function lastIdent(qname: string): string {
  const parts = qname.split(".");
  return parts[parts.length - 1] ?? qname;
}

function unquoteIdent(name: string): string {
  return name
    .replace(/^["`[]/, "").replace(/["`\]]$/, "")
    .replace(/""/g, '"');
}

export function applyBatch(db: Database, batch: SqlAndParams[]) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { sql, params } of batch) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind((params ?? []) as (string | number | null | Uint8Array)[]);
        stmt.step();
      } finally {
        stmt.free();
      }
    }
    db.exec("COMMIT");
  }
  catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}