import { Platform, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import { logger as rootLogger } from '../utils/logger';
import { utf8ByteLength } from '../utils/Utf8';

declare const activeDocument: Document;

const logger = rootLogger.scope('Export');

const ANDROID_DOWNLOADS = '/storage/emulated/0/Download';

export const MOBILE_CLIPBOARD_LIMIT = 512 * 1024;
export const DESKTOP_CLIPBOARD_LIMIT = 50 * 1024 * 1024;

const CLIPBOARD_TIMEOUT_MS = 10_000;

export type ExportTargetKind = 'dialog' | 'downloads' | 'vault';

export interface ExportCapabilities {
  clipboardLimitBytes: number;
  target: ExportTargetKind;
}

export interface ExportFile {
  name: string;
  chunks: () => Iterable<string>;
  mime: string;
}

export interface SavedExport {
  label: string;
  devicePath?: string;
  vaultPath?: string;
}

interface CapacitorFilesystem {
  writeFile(options: { path: string; data: string; encoding: string }): Promise<{ uri?: string }>;
  appendFile?(options: { path: string; data: string; encoding: string }): Promise<void>;
  deleteFile?(options: { path: string }): Promise<void>;
}

interface CapacitorBridge {
  Plugins?: { Filesystem?: CapacitorFilesystem };
}

interface SaveFileHandle {
  name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

type SaveFilePicker = (options: { suggestedName?: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveFileHandle>;

const savePicker = (): SaveFilePicker | undefined => (window as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
const capacitorFiles = (): CapacitorFilesystem | undefined => (window as { Capacitor?: CapacitorBridge }).Capacitor?.Plugins?.Filesystem;

export function exportCapabilities(): ExportCapabilities {
  const clipboardLimitBytes = Platform.isMobileApp ? MOBILE_CLIPBOARD_LIMIT : DESKTOP_CLIPBOARD_LIMIT;

  if (Platform.isDesktopApp && typeof savePicker() === 'function') return { clipboardLimitBytes, target: 'dialog' };
  if (Platform.isAndroidApp && capacitorFiles()) return { clipboardLimitBytes, target: 'downloads' };

  return { clipboardLimitBytes, target: 'vault' };
}

export function buildCapped(chunks: Iterable<string>, limitBytes: number): string | undefined {
  const parts: string[] = [];
  let bytes = 0;
  let trailingHighSurrogate = false;

  for (const chunk of chunks) {
    if (!chunk.length) continue;
    bytes += utf8ByteLength(chunk);
    const first = chunk.charCodeAt(0), last = chunk.charCodeAt(chunk.length - 1);
    // Joining two surrogate halves replaces two three-byte replacements with one four-byte character.
    if (trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
    trailingHighSurrogate = last >= 0xd800 && last <= 0xdbff;
    if (bytes > limitBytes) return undefined;
    parts.push(chunk);
  }

  return parts.join('');
}

export async function copyToClipboard(text: string): Promise<void> {
  if (activeDocument.visibilityState !== 'visible') throw new Error('Bring this window to the front before copying.');

  await Promise.race([
    navigator.clipboard.writeText(text),
    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('The clipboard did not respond.')), CLIPBOARD_TIMEOUT_MS)),
  ]);
}

export async function saveExport(app: App, file: ExportFile, target: ExportTargetKind, folder: string): Promise<SavedExport> {
  if (target === 'dialog') return saveThroughDialog(file);
  if (target === 'downloads') return saveToDownloads(app, file, folder);

  return saveToVault(app, file, folder);
}

async function saveThroughDialog(file: ExportFile): Promise<SavedExport> {
  const picker = savePicker();
  if (!picker) throw new Error('This device has no save dialog.');
  const extension = file.name.split('.').pop() ?? 'txt';
  const handle = await picker({ suggestedName: file.name, types: [{ description: file.mime, accept: { [file.mime]: [`.${extension}`] } }] });
  const writable = await handle.createWritable();

  try {
    for (const chunk of file.chunks()) {
      await writable.write(chunk);
    }
  }
  finally {
    await writable.close();
  }

  return { label: handle.name };
}

async function saveToDownloads(app: App, file: ExportFile, folder: string): Promise<SavedExport> {
  const files = capacitorFiles();
  if (!files) return saveToVault(app, file, folder);
  const path = `${ANDROID_DOWNLOADS}/${file.name}`;
  let started = false;

  try {
    if (typeof files.appendFile === 'function') {
      for (const chunk of file.chunks()) {
        if (!started) await files.writeFile({ path, data: chunk, encoding: 'utf8' });
        else await files.appendFile({ path, data: chunk, encoding: 'utf8' });
        started = true;
      }

      if (!started) await files.writeFile({ path, data: '', encoding: 'utf8' });
    }
    else await files.writeFile({ path, data: [...file.chunks()].join(''), encoding: 'utf8' });

    return { label: path, devicePath: path };
  } catch (error) {
    logger.debug('Downloads is not writable; saving into the vault', { error: error instanceof Error ? error.message : String(error) });

    if (started) await files.deleteFile?.({ path }).catch((deleteError: unknown) => logger.debug('Could not remove a partial export', { path, deleteError }));

    return saveToVault(app, file, folder);
  }
}

async function saveToVault(app: App, file: ExportFile, folder: string): Promise<SavedExport> {
  const directory = normalizePath(folder).replace(/^\/+/, '');
  if (directory && directory !== '.' && !await app.vault.adapter.exists(directory)) await app.vault.adapter.mkdir(directory);
  const path = normalizePath(directory && directory !== '.' ? `${directory}/${file.name}` : file.name);
  let first = true;

  for (const chunk of file.chunks()) {
    if (first) await app.vault.adapter.write(path, chunk);
    else await app.vault.adapter.append(path, chunk);
    first = false;
  }

  if (first) await app.vault.adapter.write(path, '');

  return { label: path, vaultPath: path };
}

export function exportFileName(base: string, extension: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const safe = base.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'vaultquery';

  return `${safe} ${stamp}.${extension}`;
}
