import { FileSystemAdapter } from 'obsidian';
import { Platform } from 'obsidian';
import type { App } from 'obsidian';
import { capacitorFileSystem } from './CapacitorFileSystem';
import type { ExternalFileSystem } from './ExternalRootService';
import type { ExternalRootRuntime } from './ExternalRootService';
import type { ExternalWatch } from './ExternalRootService';

interface NodeFileSystemAccess {
  fs?: { watch?: unknown };
  fsPromises?: Record<string, unknown>;
}

interface WatchHandle {
  close(): void;
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface ExternalCapabilities {
  files: boolean;
  watch: boolean;
}

export function createExternalRuntime(app: App): ExternalRootRuntime {
  return {
    vaultPath: () => app.vault.adapter instanceof FileSystemAdapter ? app.vault.adapter.getBasePath() : null,
    fileSystem: () => fileSystem(app),
    watch: () => watch(app),
  };
}

export function externalCapabilities(app: App): ExternalCapabilities {
  return { files: fileSystem(app) !== undefined, watch: watch(app) !== undefined };
}

function fileSystem(app: App): ExternalFileSystem | undefined {
  return nodeFileSystem(app) ?? capacitorFileSystem();
}

function nodeAccess(app: App): NodeFileSystemAccess | undefined {
  if (!Platform.isDesktopApp) return undefined;

  return app.vault.adapter as unknown as NodeFileSystemAccess;
}

function nodeFileSystem(app: App): ExternalFileSystem | undefined {
  const promises = nodeAccess(app)?.fsPromises;
  if (!promises) return undefined;

  const call = <T>(name: string, ...args: unknown[]): Promise<T> => {
    const method = promises[name];
    if (typeof method !== 'function') throw new Error(`The file system does not provide ${name}.`);

    return (method as (...values: unknown[]) => Promise<T>).call(promises, ...args);
  };

  return {
    readdir: (path, options) => call('readdir', path, options),
    stat: path => call('stat', path),
    realpath: path => call('realpath', path),
    open: (path, flags) => call('open', path, flags),
    readFile: async path => new Uint8Array(await FileSystemAdapter.readLocalFile(path)),
  };
}

function watch(app: App): ExternalWatch | undefined {
  const watcher = nodeAccess(app)?.fs?.watch;
  if (typeof watcher !== 'function') return undefined;

  return (path, options, listener, onError) => {
    const handle = (watcher as (...values: unknown[]) => WatchHandle)(path, options, listener);

    handle.on?.('error', error => {
      try {
        handle.close();
      } catch {
        /* A failed native watcher may already be closed. */
      }
      onError?.(error);
    });

    return handle;
  };
}
