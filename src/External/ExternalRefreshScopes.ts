import { comparablePath, isWithin, normalizeRootPath } from './ExternalRootSettings';
import type { ExternalRefreshScope } from './ExternalRootService';

export function externalScopeContains(scope: ExternalRefreshScope, path: string): boolean {
  return scope.file ? comparablePath(scope.file) === comparablePath(path) : isWithin(scope.directory ?? scope.root, path);
}

export function mergeExternalRefreshScope(pending: Map<string, ExternalRefreshScope>, scope: ExternalRefreshScope): void {
  const root = normalizeRootPath(scope.root);
  const requested = normalizeRootPath(scope.file ?? scope.directory ?? root);
  const valid = isWithin(root, requested);
  const normalized: ExternalRefreshScope = valid && scope.file ? { root, file: requested } : { root, directory: valid ? requested : root };
  const path = normalized.file ?? normalized.directory!;
  const rootKey = comparablePath(root);

  for (const [key, entry] of pending) {
    if (comparablePath(entry.root) !== rootKey) continue;
    if ((!entry.file || normalized.file) && externalScopeContains(entry, path)) return;
    if ((!normalized.file || entry.file) && externalScopeContains(normalized, entry.file ?? entry.directory ?? entry.root)) pending.delete(key);
  }

  pending.set(JSON.stringify([rootKey, normalized.file ? 'file' : 'directory', comparablePath(path)]), normalized);
}
