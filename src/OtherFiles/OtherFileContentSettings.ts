import type { IndexableFile, OtherFileMetadata } from './OtherFileTypes';
import { pathName, pathParent } from '../utils/PathUtils';

export interface OtherFileContentSettings {
  otherFileContentExtensions: string[];
  maxFileSizeKB: number;
  excludePatterns: string[];
}

export function normalizeFileExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [...new Set(value.filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().replace(/^\./, '').toLowerCase())
    .filter(item => item.length > 0 && !/[.*?\s/\\\0]/.test(item)))];
}

export function isIndexablePath(path: string): boolean {
  return path.length > 0 && !/[\\\0]/.test(path) && !/^[A-Za-z]:/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'));
}

export function fileMetadata(file: IndexableFile, now = Date.now(), source = 'vault'): OtherFileMetadata {
  const path = file.path;
  const name = pathName(path);
  const dot = name.lastIndexOf('.');
  const stat = (value: number): number | null => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const size = stat(file.stat.size);
  const time = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null;
  const modified = time(file.stat.mtime);

  return { path, name, basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    folder: pathParent(path), size,
    created: time(file.stat.ctime), modified,
    revision: size !== null && modified !== null ? `stat-v1:${modified}:${size}` : null, indexed: now, source };
}

export function classifyFileContents(bytes: Uint8Array): string | Uint8Array {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) return bytes;
    }

    return text;
  } catch {
    return bytes;
  }
}
