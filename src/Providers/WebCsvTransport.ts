import type { DataFileFormat } from '../Tabular/TabularTypes';

export interface WebCsvDownload {
  url: string;
  format?: DataFileFormat;
  maxBytes: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface WebCsvResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface WebCsvTransport {
  readonly busy: boolean;
  download(request: WebCsvDownload): Promise<WebCsvResponse>;
  whenIdle(): Promise<void>;
}

export function webCsvUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  }
  catch {
    throw new Error('Remote source requires an absolute HTTPS URL.');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Remote source requires HTTPS without URL credentials or a fragment.');
  }

  return url;
}

function normalizedHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
    .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]));
}

function checkLength(headers: Record<string, string>, maxBytes: number): void {
  const length = headers['content-length'];
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) throw new Error(`Remote source exceeds the ${maxBytes}-byte download limit.`);
}

export interface NativeWebCsvResponse { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }
export type NativeWebCsvRequest = (options: { url: string; method: string; headers: Record<string, string>; throw: false }) => PromiseLike<NativeWebCsvResponse>;

const ACCEPT: Record<DataFileFormat, string> = {
  csv: 'text/csv, text/plain;q=0.9, */*;q=0.1',
  json: 'application/json, text/plain;q=0.9, */*;q=0.1',
};

interface NativeDownloadSlot { active?: Promise<void> }

function nativeDownloadSlot(): NativeDownloadSlot {
  const slots = window as unknown as { [key: symbol]: NativeDownloadSlot | undefined };
  const key = Symbol.for('vaultquery.web-csv.native-download');

  return slots[key] ??= {};
}

export class NativeWebCsvTransport implements WebCsvTransport {
  private readonly slot = nativeDownloadSlot();
  public get busy(): boolean { return this.slot.active !== undefined; }
  public constructor(private readonly request: NativeWebCsvRequest, private readonly deadlineMs = 30_000) {}
  public whenIdle(): Promise<void> { return this.slot.active ?? Promise.resolve(); }

  public download(options: WebCsvDownload): Promise<WebCsvResponse> {
    if (this.busy) return Promise.reject(new Error('A native remote source request is still in progress. Retry after it finishes.'));
    webCsvUrl(options.url);
    let abandoned = options.signal?.aborted ?? false;
    let timer: number;
    let abort: () => void = () => {};

    const deadline = new Promise<never>((_, reject) => {
      abort = () => { abandoned = true; reject(new Error('Remote source download canceled; the native request is still finishing.')); };
      timer = window.setTimeout(() => { abandoned = true; reject(new Error('Remote source download exceeded its 30-second deadline; the native request is still finishing.')); }, this.deadlineMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (abandoned) abort();
    });

    const operation = (async (): Promise<WebCsvResponse> => {
      const headers = { Accept: ACCEPT[options.format ?? 'csv'], 'Accept-Encoding': 'identity', ...options.headers };
      if (abandoned) throw new Error('Remote source download canceled.');
      const head = await this.request({ url: options.url, method: 'HEAD', headers, throw: false });
      if (abandoned) throw new Error('Remote source download canceled.');
      if (head.status === 304) return { status: 304, headers: normalizedHeaders(head.headers), bytes: new Uint8Array() };
      if (head.status === 200) checkLength(normalizedHeaders(head.headers), options.maxBytes);
      const result = await this.request({ url: options.url, method: 'GET', headers, throw: false });
      if (abandoned) throw new Error('Remote source download canceled.');
      if (result.status !== 200 && result.status !== 304) throw new Error(`Remote source request returned HTTP ${result.status}.`);
      if (result.arrayBuffer.byteLength > options.maxBytes) throw new Error(`Remote source exceeds the ${options.maxBytes}-byte download limit after download.`);

      return { status: result.status, headers: normalizedHeaders(result.headers), bytes: new Uint8Array(result.arrayBuffer) };
    })();

    const settled = operation.then(() => {}, () => {}).finally(() => { if (this.slot.active === settled) this.slot.active = undefined; });
    this.slot.active = settled;

    return Promise.race([operation, deadline]).finally(() => {
      window.clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    });
  }
}
