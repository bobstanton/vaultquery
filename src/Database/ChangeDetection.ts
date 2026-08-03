/**
 * Change detection for properties.
 *
 */

import type { Changes } from './EntityDescriptors';

export interface PropertyData {
  key: string;
  value: string;
  value_type: string;
  array_index: number | null;
}

interface PropertyKey {
  key: string;
  array_index: number | null;
}

export type PropertyChanges = Changes<PropertyData, PropertyKey>;

function indexBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, item);
  }
  return map;
}

/** Create composite key for properties (no id column in table) */
function propertyKey(key: string, arrayIndex: number | null): string {
  return `${key}\0${arrayIndex ?? ''}`;
}

/**
 * Detect property changes. Uses composite key (key, array_index).
 * Handles scalar <-> array[0] transitions as updates.
 */
export function detectPropertyChanges(file: PropertyData[], existing: PropertyData[]): PropertyChanges {
  const byKey = indexBy(existing, e => propertyKey(e.key, e.array_index));

  // Index scalars and array[0] for transition detection
  const scalars = indexBy(
    existing.filter(e => e.array_index === null),
    e => e.key
  );
  const array0s = indexBy(
    existing.filter(e => e.array_index === 0),
    e => e.key
  );

  const arrayCounts = new Map<string, number>();
  for (const e of existing) {
    if (e.array_index !== null) {
      arrayCounts.set(e.key, (arrayCounts.get(e.key) ?? 0) + 1);
    }
  }

  const matched = new Set<string>();
  const result: PropertyChanges = { updated: [], inserted: [], deleted: [] };

  for (const prop of file) {
    const key = propertyKey(prop.key, prop.array_index);

    let match = byKey.get(key);
    let matchKey = key;

    // Try scalar <-> array[0] transition
    if (!match || matched.has(matchKey)) {
      if (prop.array_index === 0) {
        const scalar = scalars.get(prop.key);
        if (scalar && !matched.has(propertyKey(prop.key, null))) {
          match = scalar;
          matchKey = propertyKey(prop.key, null);
        }
      } else if (prop.array_index === null) {
        const arr0 = array0s.get(prop.key);
        if (arr0 && !matched.has(propertyKey(prop.key, 0)) && arrayCounts.get(prop.key) === 1) {
          match = arr0;
          matchKey = propertyKey(prop.key, 0);
        }
      }
    }

    if (match && !matched.has(matchKey)) {
      matched.add(matchKey);
      const changed = match.value !== prop.value || match.value_type !== prop.value_type;

      if (changed || match.array_index !== prop.array_index) {
        const id: PropertyKey = { key: match.key, array_index: match.array_index };
        result.updated.push({ id, old: match, new: prop });
      }
    } else {
      result.inserted.push(prop);
    }
  }

  for (const e of existing) {
    const key = propertyKey(e.key, e.array_index);
    if (!matched.has(key)) {
      result.deleted.push({ key: e.key, array_index: e.array_index });
    }
  }

  return result;
}
