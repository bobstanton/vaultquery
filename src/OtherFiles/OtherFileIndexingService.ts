import { SnapshotIndexingService } from './SnapshotIndexingService';
import { classifyFileContents, isIndexablePath, normalizeFileExtensions } from './OtherFileContentSettings';
import { pathExtension } from '../utils/PathUtils';
import type { OtherFileContentSettings } from './OtherFileContentSettings';
import type { OtherFileDatabaseOperations } from './OtherFileDatabaseOperations';
import type { IndexableFile, IndexedOtherFile, OtherFileMetadata, OtherFilePublication, OtherFileState } from './OtherFileTypes';
import type { ExternalFileMembership, SnapshotOperations, SnapshotRead, SnapshotVault } from './SnapshotIndexingService';

export type { ExternalFileMembership } from './SnapshotIndexingService';

interface FileStore {
  withOtherFileIndex<T>(work: (operations: OtherFileDatabaseOperations) => T): Promise<T>;
}

export class OtherFileIndexingService extends SnapshotIndexingService<FileStore, OtherFileState, IndexedOtherFile> {
  private extensions = new Set<string>();

  public constructor(vault: SnapshotVault, private readonly settings: OtherFileContentSettings,
    database: () => FileStore | undefined, publish: (publication: OtherFilePublication) => Promise<void>,
    progress: (current: number, total: number, path: string) => void = () => {},
    external?: ExternalFileMembership) {
    super(vault, { database, publish, progress, external, batchGrowth: 1, readConcurrency: 1 });
    this.updateSelection();
  }

  private get limit(): number { return this.settings.maxFileSizeKB * 1024; }

  public get enabled(): boolean { return this.extensions.size > 0; }

  public selected(path: string): boolean {
    if (!this.extensions.has(pathExtension(path).toLowerCase())) return false;
    if (this.external?.selects(path)) return true;

    return isIndexablePath(path) && !this.exclusions.matches(path, this.settings.excludePatterns);
  }

  public override updateSelection(): void {
    super.updateSelection();
    this.extensions = new Set(normalizeFileExtensions(this.settings.otherFileContentExtensions));
  }

  protected withIndex<T>(store: FileStore, work: (operations: SnapshotOperations<OtherFileState, IndexedOtherFile>) => T): Promise<T> {
    return store.withOtherFileIndex(work);
  }

  protected current(row: OtherFileState): boolean { return row.content_status === 'ready' && row.content_bytes <= this.limit; }
  protected override revisit(row: OtherFileState): boolean { return row.content_bytes > this.limit; }
  protected ready(row: IndexedOtherFile): boolean { return row.content_status === 'ready'; }
  protected bytes(row: IndexedOtherFile): number { return row.content_bytes; }

  protected stateOf(row: IndexedOtherFile): OtherFileState {
    const { content: _content, ...state } = row;

    return state;
  }

  protected async read(file: IndexableFile, _metadata: OtherFileMetadata, cancelled: () => boolean): Promise<SnapshotRead<IndexedOtherFile> | undefined> {
    const path = file.path;
    const limit = this.limit;
    let row: IndexedOtherFile | undefined;
    let generation: number | undefined;

    for (let attempt = 0; attempt < 3 && !cancelled(); attempt++) {
      const current = this.vault.getFile(path);
      if (!current) break;
      generation = this.dirty.get(path);
      const metadata = this.metadata(current);
      row = { ...metadata, content: null, content_bytes: 0, content_status: 'read_error', content_error: null };

      try {
        if (metadata.size === null || metadata.revision === null) throw new Error('File statistics are unavailable.');
        if (metadata.size > limit) { row.content_status = 'too_large'; throw new Error(`File contents exceed the ${limit}-byte per-file limit.`); }
        const buffer = await this.vault.read(current);
        if (cancelled()) { row = undefined; break; }
        const after = this.vault.getFile(path);

        if (!after || generation !== this.dirty.get(path) || this.metadata(after).revision !== metadata.revision) {
          row = undefined;
          continue;
        }

        if (buffer.byteLength !== metadata.size) throw new Error('File contents changed or the read was incomplete.');
        row.content = classifyFileContents(new Uint8Array(buffer));
        row.content_bytes = buffer.byteLength; row.content_status = 'ready';
      } catch (error) {
        if (row) row.content_error = error instanceof Error ? error.message : String(error);
      }

      break;
    }

    return row ? { row, generation } : undefined;
  }
}
