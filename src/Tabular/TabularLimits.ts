import { utf8ByteLength } from '../utils/Utf8';
import { DataFileError } from './TabularTypes';
import type { TabularParseLimits } from './TabularTypes';

const DEFAULT_MAX_FILE_SIZE_MIB = 50;
export const dataFileDefaultSizeMiB = DEFAULT_MAX_FILE_SIZE_MIB;
const MIB = 1024 * 1024;

export function dataFileSizeLimitBytes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const bytes = Math.floor(value * MIB);

  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

export function dataFileParseLimits(maxFileSizeMiB: unknown = DEFAULT_MAX_FILE_SIZE_MIB): TabularParseLimits {
  return {
    maxFileBytes: dataFileSizeLimitBytes(maxFileSizeMiB) ?? DEFAULT_MAX_FILE_SIZE_MIB * MIB,
    maxColumns: 1_999,
  };
}

export function checkDataFileSize(path: string, size: number, limits: TabularParseLimits): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new DataFileError(path, 'limit', 'The source size is unavailable or invalid.');
  }

  if (size > limits.maxFileBytes) {
    throw new DataFileError(path, 'limit', `${size} bytes exceeds the ${limits.maxFileBytes}-byte limit.`);
  }
}

export function dataFileUtf8ByteLength(value: string, path: string): number {
  try { 
    return utf8ByteLength(value, true); 
  }
  catch (error) { 
    throw new DataFileError(path, 'encoding', error instanceof Error ? error.message : String(error)); 
  }
}
