export function asStr(v: unknown): string;
export function asStr(v: unknown, fallback: string): string;
export function asStr(v: unknown, fallback: null): string | null;
export function asStr(v: unknown, fallback: string | null = ''): string | null {
  return typeof v === 'string' ? v : fallback;
}

export function asNum(v: unknown, fallback: number): number;
export function asNum(v: unknown, fallback: null): number | null;
export function asNum(v: unknown, fallback: number | null): number | null {
  return typeof v === 'number' ? v : fallback;
}

export function readLocationFields(row: Record<string, unknown>): {
  line_number: number | null;
  block_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  anchor_hash: string | null;
} {
  return {
    line_number: asNum(row.line_number, null),
    block_id: asStr(row.block_id, null),
    start_offset: asNum(row.start_offset, null),
    end_offset: asNum(row.end_offset, null),
    anchor_hash: asStr(row.anchor_hash, null)
  };
}
