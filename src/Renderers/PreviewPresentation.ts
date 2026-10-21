import type { PreviewResult } from '../Services/PreviewService';
import { filterRelevantColumns } from '../utils/ColumnUtils';

interface PreviewOptions {
  columns?: readonly string[];
  preserveText?: boolean;
  rowKey?: string;
}

export interface PreviewPresentation {
  rows: Record<string, unknown>[];
  columns?: string[];
  changedFields: number;
}

function equalValues(a: unknown, b: unknown): boolean {
  return a === b || (a instanceof Uint8Array && b instanceof Uint8Array
    && a.length === b.length && a.every((value, index) => value === b[index]));
}

export function previewPresentation(result: PreviewResult, options: PreviewOptions = {}): PreviewPresentation {
  const { before, after, op, pkCols } = result;
  const { preserveText = false, rowKey } = options;

  const columns = options.columns ? [...options.columns] : filterRelevantColumns(
    [...new Set([...Object.keys(before[0] ?? {}), ...Object.keys(after[0] ?? {})])]);

  const present = (rows: Record<string, unknown>[], changedFields = 0, fields = columns): PreviewPresentation => ({
    rows, changedFields, columns: preserveText ? fields : undefined,
  });

  if (op !== 'update') return present((op === 'insert' ? after : before)
    .map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? '']))));
  const keyed = rowKey ? new Map(after.map(row => [row[rowKey], row])) : undefined;
  const pairs = before.map((row, index) => [row, (keyed ? keyed.get(row[rowKey!]) : after[index]) ?? {}]);
  const changed = new Set(columns.filter(column => pairs.some(([a, b]) => !equalValues(a[column], b[column]))));
  if (!changed.size) return present([], 0, []);

  const context = preserveText ? [] : [...new Set([
    ...filterRelevantColumns(pkCols), 'path', 'task_text', 'value',
  ])].filter(column => !changed.has(column));

  const reserved = new Set(columns);

  const unique = (label: string): string => {
    let key = label, suffix = 1;
    while (reserved.has(key)) key = `${label} [preview ${suffix++}]`;
    reserved.add(key);

    return key;
  };

  const fields = [...context, ...columns.filter(column => preserveText || changed.has(column) && column !== 'path')]
    .flatMap(column => changed.has(column)
      ? [{ key: unique(`${column} (current)`), column, proposed: false },
        { key: unique(`${column} (proposed)`), column, proposed: true }]
      : [{ key: column, column, proposed: false }]);

  return present(pairs.map(([a, b]) => {
    const entries: [string, unknown][] = [];

    for (const field of fields) {
      const value = (field.proposed ? b : a)[field.column];
      if (!preserveText && (value === undefined && !changed.has(field.column)
        || field.column === 'array_index' && (a.array_index == null || a.array_index === '')
        && (b.array_index == null || b.array_index === ''))) continue;
      entries.push([field.key, value ?? '']);
      if (!preserveText && field.proposed) entries.push([`_${field.column}_changed`, !equalValues(a[field.column], b[field.column])]);
    }

    return Object.fromEntries(entries);
  }), changed.size, fields.map(field => field.key));
}
