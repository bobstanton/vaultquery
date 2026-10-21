export interface ForwardReader {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<number>;
  cancel(): Promise<void>;
}

export function forwardReader(reader: ReadableStreamDefaultReader<Uint8Array>, path: string): ForwardReader {
  let consumed = 0;
  let chunk: Uint8Array = new Uint8Array(0);

  const read = async (buffer: Uint8Array, offset: number, length: number, position: number): Promise<number> => {
    if (position < consumed) throw new Error(`This file can only be read forwards: ${path}`);
    let written = 0;

    while (written < length) {
      if (!chunk.length) {
        const next = await reader.read();
        if (next.done) break;
        chunk = next.value;
        continue;
      }

      const skip = Math.min(chunk.length, position - consumed);

      if (skip > 0) {
        chunk = chunk.subarray(skip);
        consumed += skip;
        continue;
      }

      const take = Math.min(chunk.length, length - written);
      buffer.set(chunk.subarray(0, take), offset + written);
      chunk = chunk.subarray(take);
      consumed += take;
      written += take;
    }

    return written;
  };

  return { read, cancel: () => reader.cancel().catch(() => undefined) };
}
