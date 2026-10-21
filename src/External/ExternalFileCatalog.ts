import { comparablePath, normalizeRootPath } from './ExternalRootSettings';
import type { ExternalScanDiff, IndexableExternalFile } from './ExternalRootService';

interface Directory { files: Set<string>; children: Set<string> }

function parent(path: string): string {
  return normalizeRootPath(path.slice(0, path.lastIndexOf('/') + 1));
}

export class ExternalFileCatalog {
  private readonly files = new Map<string, IndexableExternalFile>();
  private readonly directories = new Map<string, Directory>();

  public get(path: string): IndexableExternalFile | undefined { return this.files.get(path); }
  public has(path: string): boolean { return this.files.has(path); }
  public values(): IterableIterator<IndexableExternalFile> { return this.files.values(); }
  public clear(): void { this.files.clear(); this.directories.clear(); }

  private snapshot(directory?: string): Map<string, IndexableExternalFile> {
    if (directory === undefined) return new Map(this.files);
    const files = new Map<string, IndexableExternalFile>();
    const pending = [comparablePath(directory)];

    while (pending.length) {
      const entry = this.directories.get(pending.pop()!);
      if (!entry) continue;

      for (const path of entry.files) {
        files.set(path, this.files.get(path)!);
      }

      for (const child of entry.children) {
        pending.push(child);
      }
    }

    return files;
  }

  public replace(found: ReadonlyMap<string, IndexableExternalFile>, directory?: string, retain: (path: string) => boolean = () => false): ExternalScanDiff {
    return this.apply(found, this.snapshot(directory), retain);
  }

  public replaceFile(path: string, file: IndexableExternalFile | undefined, retain: (path: string) => boolean): ExternalScanDiff {
    const previous = this.files.get(path);

    return this.apply(new Map(file ? [[path, file]] : []), new Map(previous ? [[path, previous]] : []), retain);
  }

  private apply(found: ReadonlyMap<string, IndexableExternalFile>, previous: Map<string, IndexableExternalFile>, retain: (path: string) => boolean): ExternalScanDiff {
    const diff: ExternalScanDiff = { added: [], changed: [], removed: [] };

    for (const [path, file] of found) {
      const before = previous.get(path);
      if (!before) { diff.added.push(path); this.addPath(path); }
      else if (before.stat.size !== file.stat.size || before.stat.mtime !== file.stat.mtime) diff.changed.push(path);
      this.files.set(path, file);
      previous.delete(path);
    }

    for (const path of previous.keys()) {
      if (retain(path)) continue;
      this.files.delete(path);
      this.removePath(path);
      diff.removed.push(path);
    }

    return diff;
  }

  private addPath(path: string): void {
    let directory = parent(comparablePath(path));
    let entry = this.directories.get(directory);
    if (!entry) this.directories.set(directory, entry = { files: new Set(), children: new Set() });
    entry.files.add(path);

    while (true) {
      const ancestor = parent(directory);
      if (!ancestor || ancestor === directory) break;
      const existing = this.directories.get(ancestor);
      if (existing) { existing.children.add(directory); break; }
      this.directories.set(ancestor, { files: new Set(), children: new Set([directory]) });
      directory = ancestor;
    }
  }

  private removePath(path: string): void {
    let directory = parent(comparablePath(path));
    this.directories.get(directory)?.files.delete(path);

    while (true) {
      const entry = this.directories.get(directory);
      if (!entry || entry.files.size || entry.children.size) break;
      this.directories.delete(directory);
      const ancestor = parent(directory);
      if (!ancestor || ancestor === directory) break;
      this.directories.get(ancestor)?.children.delete(directory);
      directory = ancestor;
    }
  }
}
