import type { Database, Statement } from 'sql.js';

export class StatementCache {
  private statements = new Map<string, Statement>();

  public constructor(
    private limit: number,
    private warn: (message: string, error: unknown) => void
  ) {}

  public get size(): number {
    return this.statements.size;
  }

  public get(db: Database, sql: string): Statement {
    const cached = this.statements.get(sql);
    if (cached) {
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }

    const stmt = db.prepare(sql);
    this.statements.set(sql, stmt);

    if (this.statements.size > this.limit) {
      const firstKey = this.statements.keys().next().value;
      if (typeof firstKey === 'string') {
        const oldStmt = this.statements.get(firstKey);
        if (oldStmt) {
          this.free(oldStmt);
        }
        this.statements.delete(firstKey);
      }
    }

    return stmt;
  }

  public free(stmt: Statement): void {
    try {
      stmt.free();
    } catch (error) {
      this.warn('Failed to free prepared statement', error);
    }
  }

  public freeAll(): void {
    for (const stmt of this.statements.values()) {
      this.free(stmt);
    }
    this.statements.clear();
  }
}
