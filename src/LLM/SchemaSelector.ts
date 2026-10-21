import { quoteIdentifier } from '../utils/SqlIdentifierUtils';

import type { SchemaColumnDoc, SchemaTable } from '../Database/SchemaDocumentation';

function describePropertyKeys(keys: string[]): string {
  return `key is one of these exact values: ${keys.map(key => JSON.stringify(key)).join(', ')}`;
}

export function withPropertyKeys(tables: SchemaTable[], keys: string[] | undefined): SchemaTable[] {
  if (!keys || keys.length === 0) {
    return tables;
  }

  return tables.map(table => table.name === 'properties'
    ? { ...table, notes: [...table.notes, describePropertyKeys(keys)] }
    : table);
}

function renderColumn(column: SchemaColumnDoc): string {
  const description = column.description.replace(/\s+/g, ' ').replace(/\*\//g, '* /');

  return `${quoteIdentifier(column.name)} ${column.type}${description ? ` /* ${description} */` : ''}`;
}

export function renderCompactSchema(tables: SchemaTable[]): string {
  return tables.map(table => {
    const columns = table.columns.map(renderColumn).join(', ');
    const suffix = table.isView ? ' -- view' : '';
    const notes = table.notes.map(note => `\n  -- ${note}`).join('');

    return `${quoteIdentifier(table.name)}(${columns})${suffix}${notes}`;
  }).join('\n');
}
