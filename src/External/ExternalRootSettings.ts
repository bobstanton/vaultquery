import { Platform } from 'obsidian';
import { normalizeFileExtensions } from '../OtherFiles/OtherFileContentSettings';
import { pathExtension } from '../utils/PathUtils';

export type ExternalRefreshMode = 'watch' | 'interval' | 'manual';

export const EXTERNAL_REFRESH_MODES: readonly ExternalRefreshMode[] = ['watch', 'interval', 'manual'];
export const DEFAULT_REFRESH_MINUTES = 15;

export interface ExternalRoot {
  path: string;
  extensions: string[];
  refresh?: ExternalRefreshMode;
  refreshMinutes?: number;
}

export type ExternalRootState = 'ready' | 'missing' | 'unreadable' | 'inside-vault' | 'unsupported-platform' | 'invalid';

export interface ResolvedExternalRoot extends ExternalRoot {
  refresh: ExternalRefreshMode;
  refreshMinutes: number;
  state: ExternalRootState;
  error: string | null;
}

export function normalizeRootPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const forward = trimmed.replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(forward) && trimmed.length > forward.length) return `${forward}/`;

  return forward.length || !trimmed.length ? forward : '/';
}

export function joinRootPath(directory: string, name: string): string {
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}

export const ALL_EXTENSIONS = '*';

export function normalizeRefreshMode(value: unknown): ExternalRefreshMode {
  return EXTERNAL_REFRESH_MODES.find(mode => mode === value) ?? 'watch';
}

export function effectiveRefreshMode(mode: ExternalRefreshMode, watchable: boolean): ExternalRefreshMode {
  return mode === 'watch' && !watchable ? 'interval' : mode;
}

export function normalizeRefreshMinutes(value: unknown): number {
  const minutes = Math.trunc(Number(value));

  return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 24 * 60) : DEFAULT_REFRESH_MINUTES;
}

export function normalizeRootExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.some(item => typeof item === 'string' && item.trim() === ALL_EXTENSIONS)) return [ALL_EXTENSIONS];

  return normalizeFileExtensions(value);
}

export function isAbsoluteRootPath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:\//.test(path);
}

export function normalizeExternalRoots(value: unknown): ExternalRoot[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const roots: ExternalRoot[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Partial<ExternalRoot>;
    if (typeof record.path !== 'string') continue;
    const path = normalizeRootPath(record.path);
    if (path && seen.has(comparablePath(path))) continue;
    if (path) seen.add(comparablePath(path));

    roots.push({ path, extensions: normalizeRootExtensions(record.extensions),
      refresh: normalizeRefreshMode(record.refresh), refreshMinutes: normalizeRefreshMinutes(record.refreshMinutes) });
  }

  return roots;
}

function caseInsensitivePaths(): boolean {
  return Platform.isWin || Platform.isMacOS;
}

export function comparablePath(path: string): string {
  const normalized = normalizeRootPath(path);

  return caseInsensitivePaths() ? normalized.toLowerCase() : normalized;
}

export function isWithin(root: string, candidate: string): boolean {
  const base = comparablePath(root), target = comparablePath(candidate);
  if (!base || !target) return false;

  return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`);
}

export function retainsRows(state: ExternalRootState): boolean {
  return state === 'missing' || state === 'unreadable' || state === 'unsupported-platform';
}

export function rootStateFor(root: ExternalRoot, vaultPath: string | null, readable: boolean): ExternalRootState {
  if (!isAbsoluteRootPath(root.path)) return 'invalid';
  if (!readable) return 'unsupported-platform';
  if (vaultPath && (isWithin(vaultPath, root.path) || isWithin(root.path, vaultPath))) return 'inside-vault';

  return 'ready';
}

export function rootForExternalFile(roots: readonly ResolvedExternalRoot[], path: string, includeUnavailable = false): ResolvedExternalRoot | undefined {
  if (!isAbsoluteRootPath(path)) return undefined;
  const extension = pathExtension(path).toLowerCase();
  if (!extension) return undefined;

  let selected: ResolvedExternalRoot | undefined;

  for (const root of roots) {
    if (selected && selected.path.length >= root.path.length) continue;
    if (root.state !== 'ready' && !(includeUnavailable && retainsRows(root.state))) continue;
    if (isWithin(root.path, path) && (root.extensions.includes(ALL_EXTENSIONS) || root.extensions.includes(extension))) selected = root;
  }

  return selected;
}

export function isHiddenSegment(name: string): boolean {
  return name.startsWith('.');
}
