import { forwardReader } from '../utils/ForwardStream';
import type { ForwardReader } from '../utils/ForwardStream';
import type { ImageReadSource } from './ImageMetadataReader';

const MAX_WHOLE_READ_BYTES = 32 * 1024 * 1024;

export class ImageReadSession {
  public bytesRead = 0;
  public readCalls = 0;
  private reader?: ForwardReader;
  private opened = false;
  private buffer = new ArrayBuffer(0);
  private whole?: ArrayBuffer;

  public constructor(private readonly source: ImageReadSource, private readonly cancelled: () => boolean) {}

  public async read(length: number): Promise<ArrayBuffer> {
    if (!this.opened) {
      this.opened = true;
      this.reader = await this.source.open?.();
    }

    if (this.reader) return this.extend(length);
    if (this.whole) return this.whole;

    const url = this.source.resourceUrl();

    if (url && length > 0) {
      this.reader = responseReader(url, this.source.path, this.source.size);

      try {
        return await this.extend(length);
      }
      catch (error) {
        await this.close();
        this.buffer = new ArrayBuffer(0);
        if (this.cancelled()) throw error;
      }
    }

    if (length < this.source.size && this.source.size > MAX_WHOLE_READ_BYTES) {
      throw new Error('The leading bytes of this file could not be read, and it is too large to read whole.');
    }

    this.readCalls++;
    this.whole = await this.source.readAll();
    this.bytesRead += this.whole.byteLength;

    return this.whole;
  }

  private async extend(length: number): Promise<ArrayBuffer> {
    const next = new Uint8Array(length);
    next.set(new Uint8Array(this.buffer));
    let offset = this.buffer.byteLength;

    while (offset < length) {
      if (this.cancelled()) throw new Error('Image indexing was canceled.');
      this.readCalls++;
      const read = await this.reader!.read(next, offset, length - offset, offset);
      if (!Number.isInteger(read) || read < 0 || read > length - offset) throw new Error('The image reader returned an invalid byte count.');
      this.bytesRead += read;
      offset += read;
      if (!read) break;
    }

    this.buffer = offset === length ? next.buffer : next.buffer.slice(0, offset);

    return this.buffer;
  }

  public async close(): Promise<void> {
    const reader = this.reader;
    this.reader = undefined;
    await reader?.cancel();
  }

  public restoreBuffer(buffer: ArrayBuffer): void {
    if (this.whole) this.whole = buffer;
    else this.buffer = buffer;
  }
}

function responseReader(url: string, path: string, size: number): ForwardReader {
  let reader: ForwardReader | undefined;
  let start = 0, end = 0;
  const cancel = async () => { const current = reader; reader = undefined; await current?.cancel(); };

  return {
    cancel,
    read: async (buffer, offset, length, position) => {
      if (!reader || position >= end) {
        await cancel();

        // These are local app: URLs. requestUrl does not support that protocol or streaming.
        const response = await window.fetch(url, position === 0 && length >= size ? undefined
          : { headers: { range: `bytes=${position}-${position + length - 1}` } });

        if (!response.ok) { await response.body?.cancel(); throw new Error(`This image could not be read (${response.status}): ${path}`); }
        start = response.status === 206 ? position : 0;
        end = response.status === 206 ? position + length : size;
        const contentRange = response.headers?.get('content-range');

        if (response.status === 206 && contentRange) {
          const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);

          if (!match || Number(match[1]) !== position || Number(match[2]) < position || Number(match[2]) >= size
            || (match[3] !== '*' && Number(match[3]) !== size)) {
            await response.body?.cancel();
            throw new Error('The image server returned an unexpected range.');
          }

          end = Number(match[2]) + 1;
        }

        const stream = response.body?.getReader();

        if (stream) reader = forwardReader(stream, path);
        else {
          if (response.status !== 206 && size > MAX_WHOLE_READ_BYTES) throw new Error('This image response cannot be streamed.');
          const bytes = new Uint8Array(await response.arrayBuffer());

          reader = {
            read: async (target, targetOffset, wanted, from) => {
              const part = bytes.subarray(from, from + wanted);
              target.set(part, targetOffset);

              return part.byteLength;
            },
            cancel: async () => {},
          };
        }
      }

      return reader.read(buffer, offset, Math.min(length, end - position), position - start);
    },
  };
}
