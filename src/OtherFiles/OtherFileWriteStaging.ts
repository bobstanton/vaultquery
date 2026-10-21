import { withSavepoint } from '../Database/SqlScopes';
import type { Database } from 'sql.js';
import type { SqlParameter } from '../Database/QueryValues';
import { collectStatementRows } from '../Database/StatementRows';
import { otherFileWriteStatements, stripReturningClause } from '../utils/SQLParsingUtils';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';

export interface StagedOtherFile {
  path: string;
  original: string | Uint8Array | null;
  output: string | Uint8Array | null;
}
export interface OtherFileStageLimits {
  maxFileBytes: number;
}

export function fileContentBytes(content: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (content instanceof Uint8Array) return content.buffer instanceof ArrayBuffer ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength) : content.slice();
  if (content.includes('\0')) throw new Error('File contents containing NUL require a BLOB value.');
  const bytes = new TextEncoder().encode(content);

  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== content) {
    throw new Error('File contents must contain valid Unicode text or binary bytes.');
  }

  return bytes;
}

export function stageOtherFileWrites(db: Database, sql: string, params: unknown[], guards: readonly { name: string; sql: string }[], limits: OtherFileStageLimits): StagedOtherFile[] {
  const statements = otherFileWriteStatements(sql);
  if (sql.includes('\0')) throw new Error('File write SQL cannot contain NUL.');

  for (const value of params) {
    if (typeof value === 'string') fileContentBytes(value);
    else if (value !== null && !(value instanceof Uint8Array) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('SQL parameters must be text, binary, finite numbers, or NULL.');
    }
  }

  const existing = db.exec("SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='other_files' COLLATE NOCASE")[0]?.values ?? [];

  if (existing.length !== guards.length || existing.some(([definition]) => !guards.some(guard => guard.sql === definition))) {
    throw new Error('File write previews require the owned guards without user-defined triggers.');
  }

  if (db.exec("SELECT 1 FROM sqlite_temp_schema WHERE name='other_files' COLLATE NOCASE OR tbl_name='other_files' COLLATE NOCASE OR name GLOB '_vq_file_stage*'").length) {
    throw new Error('A temporary object conflicts with file write staging.');
  }

  if (!Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes <= 0) throw new Error('File size limit must be a positive byte count.');
  const size = (value: string) => `coalesce(length(CAST(${value} AS BLOB)),0)`;

  const validateContent = `SELECT CASE WHEN typeof(NEW.content) NOT IN ('text','blob')
      THEN RAISE(ABORT,'File contents require TEXT or BLOB') END;
    SELECT CASE WHEN typeof(NEW.content)='text' AND instr(NEW.content,char(0))>0
      THEN RAISE(ABORT,'File contents containing NUL require a BLOB value') END;
    SELECT CASE WHEN ${size('NEW.content')} > ${limits.maxFileBytes}
      THEN RAISE(ABORT,'File output exceeds the per-file byte limit') END;`;

  const ready = `SELECT CASE WHEN OLD.content_status!='ready' OR OLD.content IS NULL
    THEN RAISE(ABORT,'File writes require ready indexed contents') END;
    SELECT CASE WHEN ${size('OLD.content')} > ${limits.maxFileBytes}
    THEN RAISE(ABORT,'File source exceeds the per-file byte limit') END;`;

  const metadata = `UPDATE other_files SET name=path_name(NEW.path),basename=path_basename(NEW.path),
    folder=path_parent(NEW.path),extension=lower(substr(path_name(NEW.path),length(path_basename(NEW.path))+2)),
    content_status='ready',content_error=NULL,content_bytes=${size('NEW.content')},size=${size('NEW.content')}
    WHERE path=NEW.path;`;

  return withSavepoint(db, 'vq_file_write_stage', () => {
    for (const guard of guards) {
      db.run(`DROP TRIGGER ${quoteIdentifier(guard.name)}`);
    }

    db.run(`CREATE TEMP TABLE _vq_file_stage(path TEXT PRIMARY KEY, original BLOB, output BLOB);
      CREATE TEMP TRIGGER _vq_file_stage_insert BEFORE INSERT ON main.other_files BEGIN
        ${validateContent}
        INSERT OR IGNORE INTO _vq_file_stage(path) VALUES(NEW.path); END;
      CREATE TEMP TRIGGER _vq_file_stage_update BEFORE UPDATE OF content ON main.other_files BEGIN
        ${ready} ${validateContent}
        INSERT OR IGNORE INTO _vq_file_stage(path,original) VALUES(OLD.path,OLD.content); END;
      CREATE TEMP TRIGGER _vq_file_stage_delete BEFORE DELETE ON main.other_files BEGIN
        ${ready}
        INSERT OR IGNORE INTO _vq_file_stage(path,original) VALUES(OLD.path,OLD.content);
        UPDATE _vq_file_stage SET output=NULL WHERE path=OLD.path; END;
      CREATE TEMP TRIGGER _vq_file_stage_after_insert AFTER INSERT ON main.other_files BEGIN
        UPDATE _vq_file_stage SET output=NEW.content WHERE path=NEW.path; ${metadata} END;
      CREATE TEMP TRIGGER _vq_file_stage_after_update AFTER UPDATE OF content ON main.other_files BEGIN
        UPDATE _vq_file_stage SET output=NEW.content WHERE path=NEW.path; ${metadata} END;`);

    for (const statement of statements) {
      db.run(stripReturningClause(statement.sql), params as SqlParameter[]);
    }

    // Read content bytes explicitly: sql.js's string decoder strips a leading BOM.
    const statement = db.prepare(`SELECT CAST(path AS BLOB) AS path,typeof(original) AS original_type,CAST(original AS BLOB) AS original,
      typeof(output) AS output_type,CAST(output AS BLOB) AS output FROM _vq_file_stage ORDER BY path`);

    try {
      const decode = (value: unknown, type: unknown): string | Uint8Array | null => {
        if (value === null) return null;
        if (!(value instanceof Uint8Array)) throw new Error('Invalid staged file contents.');

        return type === 'text' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value) : value;
      };

      return collectStatementRows(statement).map(row => ({
        path: String(decode(row.path, 'text')), original: decode(row.original, row.original_type), output: decode(row.output, row.output_type),
      }));
    }
    finally {
      statement.free();
    }
  }, true);
}
