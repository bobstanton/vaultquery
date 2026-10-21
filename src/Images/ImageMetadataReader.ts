import { prefixBytesFor } from './ImageSettings';
import { getErrorMessage } from '../utils/ErrorMessages';
import { ImageReadSession } from './ImageReadSession';
import { parseImagePrefix } from './ImageMetadataParser';
import type { ImagePrefixProcessor, ImagePrefixResult } from './ImageMetadataParser';
import type { ForwardReader } from '../utils/ForwardStream';

export interface ImageReadSource {
  readonly path: string;
  readonly extension: string;
  readonly size: number;
  resourceUrl(): string | null;
  open?(): Promise<ForwardReader> | undefined;
  readAll(): Promise<ArrayBuffer>;
}

export interface ImageReadResult extends Omit<ImagePrefixResult, 'parseMs' | 'normalizeMs' | 'nextBytes'> {
  bytesRead: number;
  timing: ImageReadTiming;
}

export interface ImageReadTiming {
  readMs: number;
  parseMs: number;
  normalizeMs: number;
  prefixReads: number;
  readCalls: number;
}

export async function readImageMetadata(source: ImageReadSource, cancelled: () => boolean = () => false, processPrefix?: ImagePrefixProcessor): Promise<ImageReadResult> {
  const session = new ImageReadSession(source, cancelled);
  const timing: ImageReadTiming = { readMs: 0, parseMs: 0, normalizeMs: 0, prefixReads: 0, readCalls: 0 };
  let wanted = Math.min(prefixBytesFor(source.extension), source.size);

  try {
    try {
      while (true) {
        let buffer: ArrayBuffer;
        const started = performance.now();

        try {
          if (cancelled()) throw new Error('Image indexing was canceled.');
          timing.prefixReads++;
          buffer = await session.read(wanted);
          if (buffer.byteLength < wanted || buffer.byteLength > source.size) throw new Error('The image changed or its read was incomplete.');
        } finally {
          timing.readMs += performance.now() - started;
        }

        if (cancelled()) throw new Error('Image indexing was canceled.');
        let parsed: ImagePrefixResult;
        if (processPrefix) {
          const reply = await processPrefix(buffer, source.extension, source.size);
          session.restoreBuffer(reply.buffer);
          parsed = reply.result;
        } else parsed = parseImagePrefix(buffer, source.extension, source.size);
        timing.parseMs += parsed.parseMs; timing.normalizeMs += parsed.normalizeMs;
        if (cancelled()) throw new Error('Image indexing was canceled.');
        if (!parsed.nextBytes) return { tags: parsed.tags, header: parsed.header, normalized: parsed.normalized,
          status: parsed.status, error: parsed.error, bytesRead: session.bytesRead, timing };
        wanted = parsed.nextBytes;
      }
    } finally {
      const started = performance.now();

      try {
        await session.close();
      }
      finally {
        timing.readMs += performance.now() - started; timing.readCalls = session.readCalls;
      }
    }
  } catch (error) {
    return { tags: null, header: null, status: 'read_error', error: getErrorMessage(error), bytesRead: session.bytesRead, timing };
  }
}
