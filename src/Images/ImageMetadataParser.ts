import ExifReader from 'exifreader';
import type { ExpandedTags } from 'exifreader';
import { isHeaderOnlyFormat } from './ImageSettings';
import { readHeaderDimensions } from './ImageHeaderReader';
import type { HeaderDimensions } from './ImageHeaderReader';
import { emptyImageFacts, normalizeHeaderDimensions, normalizeImageTags } from './ImageMetadataNormalizer';
import type { NormalizedImage } from './ImageMetadataNormalizer';
import type { ImageMetadataStatus } from './ImageTypes';
import { getErrorMessage } from '../utils/ErrorMessages';

export interface ImagePrefixResult {
  tags: ExpandedTags | null;
  header: HeaderDimensions | null;
  normalized?: NormalizedImage;
  status: ImageMetadataStatus;
  error: string | null;
  nextBytes?: number;
  parseMs: number;
  normalizeMs: number;
}

export type ImagePrefixProcessor = (buffer: ArrayBuffer, extension: string, size: number) => Promise<{ buffer: ArrayBuffer; result: ImagePrefixResult }>;

export function parseImagePrefix(buffer: ArrayBuffer, extension: string, size: number, normalize = false, domParser?: { parseFromString(xml: string, mimeType: string): unknown }): ImagePrefixResult {
  const result: ImagePrefixResult = { tags: null, header: null, status: 'ready', error: null, parseMs: 0, normalizeMs: 0 };
  const started = performance.now();

  try {
    if (isHeaderOnlyFormat(extension)) {
      result.header = readHeaderDimensions(extension, buffer);
      if (!result.header) { result.status = 'unsupported'; result.error = 'No parser reads this format.'; }
    } else {
      result.tags = ExifReader.load(buffer, { expanded: true, includeUnknown: true, includeOffsets: true,
        excludeTags: { mpf: ['Images'] }, domParser });

      const range = result.tags.metadataRange;

      if (range?.complete === false) {
        if (buffer.byteLength >= size) {
          result.status = 'unsupported'; result.error = 'The image metadata is incomplete in the source file.'; result.tags = null;
        } else result.nextBytes = Math.min(Math.max(Number.isFinite(range.end) ? range.end : 0, buffer.byteLength * 2, 1), size);
      }
    }
  } catch (error) {
    result.status = error instanceof Error && error.name === 'MetadataMissingError' ? 'no_metadata' : 'unsupported';
    result.error = getErrorMessage(error);
  } finally {
    result.parseMs = performance.now() - started;
  }

  if (normalize) {
    if (!result.nextBytes) {
      const started = performance.now();

      result.normalized = result.tags ? normalizeImageTags(result.tags) : result.header ? normalizeHeaderDimensions(result.header)
        : { facts: emptyImageFacts(), metadata: null, tagCount: 0 };

      result.normalizeMs = performance.now() - started;
    }

    result.tags = null; result.header = null;
  }

  return result;
}
