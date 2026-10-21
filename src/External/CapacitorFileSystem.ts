import { Platform } from 'obsidian';
import { forwardReader } from '../utils/ForwardStream';
import type { ExternalDirent } from './ExternalRootService';
import type { ExternalFileHandle } from './ExternalRootService';
import type { ExternalFileSystem } from './ExternalRootService';
import type { ExternalStat } from './ExternalRootService';

interface CapacitorEntry {
  name?: string;
  type: string;
  size: number;
  mtime: number;
  ctime?: number | null;
  uri: string;
}

interface CapacitorFilesystem {
  readdir(options: { path: string }): Promise<{ files: CapacitorEntry[] }>;
  stat(options: { path: string }): Promise<CapacitorEntry>;
}

interface CapacitorGlobal {
  convertFileSrc?(path: string): string;
  Plugins?: { Filesystem?: CapacitorFilesystem };
}

export function capacitorFileSystem(): ExternalFileSystem | undefined {
  if (!Platform.isAndroidApp) return undefined;
  const capacitor = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  const files = capacitor?.Plugins?.Filesystem;
  if (!capacitor || !files || typeof capacitor.convertFileSrc !== 'function') return undefined;
  const convert = capacitor.convertFileSrc.bind(capacitor);

  const request = async (path: string): Promise<Response> => {
    // Capacitor serves local files through its WebView; requestUrl cannot stream that transport.
    const response = await window.fetch(convert(fileUrlPath(path)));
    if (!response.ok) throw new Error(`This file could not be read (${response.status}): ${path}`);

    return response;
  };

  return {
    readdir: async path => (await files.readdir({ path })).files.map(toDirent),
    stat: async path => toStat(await files.stat({ path })),
    realpath: async path => confined(path),
    readFile: async path => new Uint8Array(await (await request(confined(path))).arrayBuffer()),
    open: async path => streamHandle(await request(confined(path)), path),
  };
}

function toStat(entry: CapacitorEntry): ExternalStat {
  return { size: entry.size, mtimeMs: entry.mtime, birthtimeMs: entry.ctime ?? undefined,
    isFile: () => entry.type === 'file', isDirectory: () => entry.type === 'directory' };
}

function toDirent(entry: CapacitorEntry): ExternalDirent {
  return { name: entry.name ?? '', isFile: () => entry.type === 'file', isDirectory: () => entry.type === 'directory',
    isSymbolicLink: () => false, stat: toStat(entry) };
}

function confined(path: string): string {
  if (path.split('/').some(segment => segment === '.' || segment === '..')) throw new Error(`A path cannot contain relative segments: ${path}`);

  return path;
}

function streamHandle(response: Response, path: string): ExternalFileHandle {
  const body = response.body?.getReader();
  if (!body) throw new Error(`This file could not be streamed: ${path}`);
  const reader = forwardReader(body, path);

  return {
    read: async (buffer, offset, length, position) => ({ bytesRead: await reader.read(buffer, offset, length, position) }),
    close: () => reader.cancel(),
  };
}

function fileUrlPath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}
