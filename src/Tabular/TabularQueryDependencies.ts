import { sqliteIdentifierKey } from '../utils/SqlIdentifierUtils';

export interface CsvQueryDependenciesResult {
  readonly relations: readonly string[];
  readonly hasEmptyView: boolean;
}

interface SchemaRevision { readonly database: object; readonly version: number }

export class CsvQueryDependencies {
  private revision?: SchemaRevision;
  private readonly contexts = new WeakMap<CsvQueryDependenciesResult, { sql: string; revision?: SchemaRevision }>();
  private readonly views = new Map<string, string | undefined>();
  private readonly queries = new Map<string, CsvQueryDependenciesResult>();
  private readonly limit = 200;

  public constructor(
    private readonly references: (sql: string) => ReadonlySet<string>,
    private readonly knownTable: (name: string) => boolean,
    private readonly schemaRevision: () => Promise<SchemaRevision>,
    private readonly viewDefinition: (name: string) => Promise<string | undefined>,
  ) {}

  private cache<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > this.limit) map.delete(map.keys().next().value!);
  }

  public async revalidate(sql: string, result: CsvQueryDependenciesResult): Promise<CsvQueryDependenciesResult> {
    const context = this.contexts.get(result);

    if (context?.sql === sql) {
      if (!context.revision) {
        if (result.relations.every(this.knownTable)) return result;
      } else {
        const revision = await this.schemaRevision();
        if (revision.database === context.revision.database && revision.version === context.revision.version) return result;
      }
    }

    return this.resolve(sql);
  }

  public async resolve(sql: string, attempt = 0): Promise<CsvQueryDependenciesResult> {
    const direct = Array.from(this.references(sql));

    if (direct.every(this.knownTable)) {
      const result = { relations: direct, hasEmptyView: false };
      this.contexts.set(result, { sql });

      return result;
    }

    const revision = await this.schemaRevision();

    if (revision.database !== this.revision?.database || revision.version !== this.revision.version) {
      this.views.clear();
      this.queries.clear();
      this.revision = revision;
    }

    const token = this.revision;
    const cached = this.queries.get(sql);

    if (cached) {
      this.cache(this.queries, sql, cached);

      return cached;
    }

    const queue = [...direct];
    const visited = new Set<string>();
    const relations: string[] = [];
    let hasEmptyView = false;

    while (queue.length) {
      const name = queue.pop()!;
      const key = sqliteIdentifierKey(name);
      if (visited.has(key)) continue;
      visited.add(key);
      if (this.knownTable(name)) { relations.push(name); continue; }
      let definition = this.views.get(key);

      if (!this.views.has(key)) {
        definition = await this.viewDefinition(name);
        if (this.revision === token) this.cache(this.views, key, definition);
      }

      if (definition === undefined) { relations.push(name); continue; }
      const references = this.references(definition);
      if (!references.size) hasEmptyView = true;
      queue.push(...references);
    }

    const after = await this.schemaRevision();
    const stable = after.database === revision.database && after.version === revision.version;
    if (!stable && attempt < 2) return this.resolve(sql, attempt + 1);

    const result = { relations, hasEmptyView };
    this.contexts.set(result, { sql, revision: stable ? revision : undefined });
    if (stable && this.revision === token) this.cache(this.queries, sql, result);

    return result;
  }
}
