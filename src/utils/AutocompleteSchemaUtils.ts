import type { ProviderTableDefinition } from '../Providers/TableProviderTypes';

export interface AutocompleteSchemaRelationInfo {
  name: string;
  type: 'table' | 'view';
}

export interface AutocompleteSchemaColumnInfo {
  relation: string;
  name: string;
  type: string;
}

export interface AutocompleteSchemaShape {
  relations: AutocompleteSchemaRelationInfo[];
  columns: AutocompleteSchemaColumnInfo[];
  functions: string[];
}

/**
 * Declared tables only exist in sqlite_master after their first refresh
 * materializes them; without this merge, a user writing their first weather or
 * tide query gets no table/column completions - the moment completion matters
 * most.
 */
export function mergeDeclaredProviderTables(schema: AutocompleteSchemaShape, declaredTables: ProviderTableDefinition[]): AutocompleteSchemaShape {
  if (declaredTables.length === 0) {
    return schema;
  }

  const knownRelations = new Set(schema.relations.map((relation) => relation.name.toLowerCase()));
  const relations = [...schema.relations];
  const columns = [...schema.columns];

  for (const table of declaredTables) {
    const normalized = table.name.toLowerCase();
    if (!table.name || knownRelations.has(normalized)) {
      continue;
    }

    knownRelations.add(normalized);
    relations.push({ name: table.name, type: 'table' });
    for (const column of table.columns) {
      columns.push({ relation: table.name, name: column.name, type: column.type });
    }
  }

  relations.sort((left, right) => left.name.localeCompare(right.name));
  return { relations, columns, functions: schema.functions };
}
