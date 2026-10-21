import type { SqlValue } from 'sql.js';

// Keep the public value contract independent of the driver's type package.
export type QueryValue = string | number | boolean | null | Uint8Array;
export type SqlParameter = SqlValue;

export function queryRowBytes(values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => total + (
    typeof value === 'string' ? value.length * 2 : value instanceof Uint8Array ? value.byteLength : 8
  ), 0);
}
