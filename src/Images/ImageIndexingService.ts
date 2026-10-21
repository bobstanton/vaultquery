import { SnapshotIndexingService } from '../OtherFiles/SnapshotIndexingService';
import { isImageExtension, isIndexableImage } from './ImageSettings';
import { pathExtension } from '../utils/PathUtils';
import { emptyImageFacts } from './ImageMetadataNormalizer';
import { readImageMetadata } from './ImageMetadataReader';
import { ImageMetadataWorker } from './ImageMetadataWorker';
import { logger as rootLogger } from '../utils/logger';
import type { ForwardReader } from '../utils/ForwardStream';
import type { ImageDatabaseOperations } from './ImageDatabaseOperations';
import type { ImageIndexSettings } from './ImageSettings';
import type { ImageIndexState, ImagePublication, IndexedImage } from './ImageTypes';
import type { IndexableFile, OtherFileMetadata } from '../OtherFiles/OtherFileTypes';
import type { ExternalFileMembership, SnapshotOperations, SnapshotRead, SnapshotVault } from '../OtherFiles/SnapshotIndexingService';

const BATCH_GROWTH = 8;
const READ_CONCURRENCY = 6;
const PUBLICATION_INTERVAL_MS = 1_000;
const logger = rootLogger.scope('Images');

interface ImageStore {
  withImageIndex<T>(work: (operations: ImageDatabaseOperations) => T): Promise<T>;
}

interface ImageVault extends SnapshotVault {
  resourceUrl(file: IndexableFile): string | null;
  open?(file: IndexableFile): Promise<ForwardReader> | undefined;
}

export class ImageIndexingService extends SnapshotIndexingService<ImageStore, ImageIndexState, IndexedImage, ImageVault> {
  private readonly parser = new ImageMetadataWorker();
  public constructor(vault: ImageVault, private readonly settings: ImageIndexSettings,
    database: () => ImageStore | undefined, publish: (publication: ImagePublication) => Promise<void>,
    progress: (current: number, total: number, path: string) => void = () => {},
    external?: ExternalFileMembership) {
    super(vault, { database, publish, progress, external, batchGrowth: BATCH_GROWTH, readConcurrency: READ_CONCURRENCY,
      publicationIntervalMs: PUBLICATION_INTERVAL_MS, diagnostics: timing => logger.debug('Image indexing phases', timing) });
  }

  public get enabled(): boolean { return this.settings.indexImageMetadata; }

  public override dispose(): void { super.dispose(); this.parser.dispose(); }

  public selected(path: string): boolean {
    if (!this.enabled) return false;
    if (this.external?.selects(path)) return isImageExtension(pathExtension(path));

    return isIndexableImage(path) && !this.exclusions.matches(path, this.settings.excludePatterns);
  }

  protected withIndex<T>(store: ImageStore, work: (operations: SnapshotOperations<ImageIndexState, IndexedImage>) => T): Promise<T> {
    return store.withImageIndex(work);
  }

  /** A read that failed is tried again; a file with no metadata or an unknown format has been read and stands. */
  protected current(row: ImageIndexState): boolean { return row.metadata_status !== 'read_error'; }
  protected ready(row: IndexedImage): boolean { return row.metadata_status === 'ready'; }
  protected bytes(row: IndexedImage): number { return row.metadata?.length ?? 0; }

  protected stateOf(row: IndexedImage): ImageIndexState {
    const { metadata: _metadata, ...state } = row;

    return state;
  }

  protected async read(file: IndexableFile, metadata: OtherFileMetadata, cancelled: () => boolean): Promise<SnapshotRead<IndexedImage> | undefined> {
    const generation = this.dirty.get(file.path);

    if (metadata.size === null || metadata.revision === null) {
      return { generation, row: { ...metadata, ...emptyImageFacts(), metadata_status: 'read_error', metadata_error: 'File statistics are unavailable.', tag_count: 0, bytes_read: 0, metadata: null } };
    }

    const result = await readImageMetadata({
      path: metadata.path, extension: metadata.extension, size: metadata.size,
      resourceUrl: () => this.vault.resourceUrl(file),
      open: () => this.vault.open?.(file),
      readAll: () => this.vault.read(file),
    }, cancelled, this.parser.process);

    if (cancelled()) return undefined;
    const after = this.vault.getFile(metadata.path);
    if (!after || this.metadata(after).revision !== metadata.revision) return undefined;
    const normalized = result.normalized ?? { facts: emptyImageFacts(), metadata: null, tagCount: 0 };

    return { generation, timing: { ...result.timing, bytesRead: result.bytesRead },
      row: { ...metadata, ...normalized.facts, metadata_status: result.status, metadata_error: result.error,
        tag_count: normalized.tagCount, bytes_read: result.bytesRead, metadata: normalized.metadata } };
  }
}
