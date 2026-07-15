import { asNum, asStr } from './types';

type RowRecord = Record<string, unknown>;
type DescendantTable = 'list_items' | 'list_items_view';
type QueryRowsSync = (sql: string, params: (string | number | null)[]) => RowRecord[];
type QueryRowsAsync = (sql: string, params: (string | number | null)[]) => Promise<RowRecord[]>;

function descendantQuery(table: DescendantTable): string {
  return `WITH RECURSIVE descendants(item_index) AS (
    SELECT ?
    UNION ALL
    SELECT child.item_index
    FROM list_items child
    JOIN descendants parent
      ON child.parent_index = parent.item_index
    WHERE child.path = ?
      AND child.list_index = ?
  )
  SELECT item.*
  FROM ${table} item
  JOIN descendants d ON item.item_index = d.item_index
  WHERE item.path = ?
    AND item.list_index = ?
  ORDER BY item.item_index`;
}

function dedupeDescendants(batches: RowRecord[][]): RowRecord[] {
  const expandedRows: RowRecord[] = [];
  const seen = new Set<string>();

  for (const descendants of batches) {
    for (const descendant of descendants) {
      const key = `${asStr(descendant.path)}:${asNum(descendant.list_index, 0)}:${asNum(descendant.item_index, 0)}`;
      if (!seen.has(key)) {
        seen.add(key);
        expandedRows.push(descendant);
      }
    }
  }

  return expandedRows;
}

export function expandListItemViewDeletes(rows: RowRecord[], queryDatabase: QueryRowsSync, table?: DescendantTable): RowRecord[];
export function expandListItemViewDeletes(rows: RowRecord[], queryDatabase: QueryRowsAsync, table?: DescendantTable): Promise<RowRecord[]>;
export function expandListItemViewDeletes(rows: RowRecord[], queryDatabase: QueryRowsSync | QueryRowsAsync,
  table: DescendantTable = 'list_items'): RowRecord[] | Promise<RowRecord[]> {
  const sql = descendantQuery(table);
  const batches = rows.map(row => {
    const path = asStr(row.path);
    const listIndex = asNum(row.list_index, 0);
    const itemIndex = asNum(row.item_index, 0);
    return queryDatabase(sql, [itemIndex, path, listIndex, path, listIndex]);
  });

  // A single adapter produces homogeneous batches: all plain arrays (sync) or all promises (async).
  if (batches.every((batch): batch is RowRecord[] => !(batch instanceof Promise))) {
    return dedupeDescendants(batches);
  }

  return Promise.all(batches as Promise<RowRecord[]>[]).then(dedupeDescendants);
}
