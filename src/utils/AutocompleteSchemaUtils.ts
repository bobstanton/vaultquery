import type { ProviderTableDefinition } from '../Providers/TableProviderTypes';
import type { IVaultQueryAPI, EventRef } from '../VaultQueryAPI';
import type { SchemaTable } from '../Database/SchemaDocumentation';

export function subscribeAutocompleteSchemaChanges(api: Pick<IVaultQueryAPI, 'on'>, invalidate: () => void): EventRef[] {
  return [
    api.on('vault-indexed', invalidate),
    api.on('files-indexed', ({ source }) => {
      if (source !== 'image' && source !== 'other-file') invalidate();
    }),
    api.on('file-removed', ({ path }) => { if (/\.csv$/i.test(path)) invalidate(); }),
    api.on('database-restored', invalidate),
  ];
}

export interface AutocompleteSchemaRelationInfo {
  name: string;
  type: 'table' | 'view';
  description?: string;
}

export interface AutocompleteSchemaColumnInfo {
  relation: string;
  name: string;
  type: string;
  description?: string;
  write?: 'insert' | 'insert-update' | 'read-only';
}

export interface AutocompleteSchemaShape {
  relations: AutocompleteSchemaRelationInfo[];
  columns: AutocompleteSchemaColumnInfo[];
  functions: string[];
}

/** Provider declarations are available before the first refresh creates their tables. */
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

export function describeAutocompleteSchema(schema: AutocompleteSchemaShape, tables: SchemaTable[]): AutocompleteSchemaShape {
  const descriptions = new Map(tables.map(table => [table.name.toLowerCase(), {
    description: table.description,
    columns: new Map(table.columns.map(column => [column.name.toLowerCase(), column.description])),
  }]));

  return {
    ...schema,
    relations: schema.relations.map(relation => ({ ...relation,
      description: descriptions.get(relation.name.toLowerCase())?.description,
    })),
    columns: schema.columns.map(column => ({ ...column,
      description: descriptions.get(column.relation.toLowerCase())?.columns.get(column.name.toLowerCase()),
    })),
  };
}
