import type { DataFileFormat } from '../Tabular/TabularTypes';

export interface RemoteDataDownload {
  method?: 'GET' | 'POST';
  body?: string;
  url: string;
  format?: DataFileFormat;
  maxBytes: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  singleRequest?: boolean;
}

export interface RemoteDataResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface RemoteDataTransport {
  readonly busy: boolean;
  download(request: RemoteDataDownload): Promise<RemoteDataResponse>;
  whenIdle(): Promise<void>;
}

export function remoteSourceUrl(value: string): URL {
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

export function hasRemoteDocument(status: number): boolean {
  return status === 200 || status === 201;
}

function exceedsLimit(maxBytes: number): Error {
  return new Error(`Remote source exceeds the ${maxBytes}-byte download limit.`);
}

function checkLength(headers: Record<string, string>, maxBytes: number): void {
  const length = headers['content-length'];

  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) throw exceedsLimit(maxBytes);
}

function hasJsonBody(headers: Record<string, string>): boolean {
  return headers['content-type']?.includes('json') ?? false;
}

const MAX_ERROR_BYTES = 4096;

function requestError(status: number, data?: Uint8Array, requestHeaders?: Record<string, string>): Error {
  const fallback = new Error(`Remote source request returned HTTP ${status}.`);

  if (!data || data.length > MAX_ERROR_BYTES) return fallback;

  try {
    const body = JSON.parse(new TextDecoder().decode(data)) as { error?: unknown; message?: unknown; detail?: unknown } | null;
    const error = body?.error;
    const message = error && typeof error === 'object' && 'message' in error ? error.message : error ?? body?.message ?? body?.detail;

    if (typeof message !== 'string' || !message.trim() || message.length > 300 || /[<>\p{Cc}]/u.test(message)) return fallback;

    for (const value of Object.values(requestHeaders ?? {})) {
      if (value.split(/\s+/).some(part => part && (message.includes(part) || message.includes(encodeURIComponent(part))))) return fallback;
    }

    return new Error(`Remote source request returned HTTP ${status}. ${message.trim()}`);
  }
  catch {
    return fallback;
  }
}

export interface NativeRemoteDataResponse { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }
export type NativeRemoteDataRequest = (options: { url: string; method: string; headers: Record<string, string>; body?: string; contentType?: string; throw: false }) => PromiseLike<NativeRemoteDataResponse>;

const ACCEPT: Record<DataFileFormat, string> = {
  csv: 'text/csv, text/plain;q=0.9, */*;q=0.1',
  json: 'application/json, text/plain;q=0.9, */*;q=0.1',
};

interface NativeDownloadSlot { active?: Promise<void> }

function nativeDownloadSlot(): NativeDownloadSlot {
  const slots = window as unknown as { [key: symbol]: NativeDownloadSlot | undefined };
  const key = Symbol.for('vaultquery.remote-data.native-download');

  return slots[key] ??= {};
}

export class NativeRemoteDataTransport implements RemoteDataTransport {
  private readonly slot = nativeDownloadSlot();
  public get busy(): boolean { return this.slot.active !== undefined; }
  public constructor(private readonly request: NativeRemoteDataRequest, private readonly deadlineMs = 30_000) {}
  public whenIdle(): Promise<void> { return this.slot.active ?? Promise.resolve(); }

  public download(options: RemoteDataDownload): Promise<RemoteDataResponse> {
    if (this.busy) return Promise.reject(new Error('A native remote source request is still in progress. Retry after it finishes.'));
    remoteSourceUrl(options.url);
    let abandoned = options.signal?.aborted ?? false;
    let timer: number;
    let abort: () => void = () => {};

    const deadline = new Promise<never>((_, reject) => {
      abort = () => { abandoned = true; reject(new Error('Remote source download canceled; the native request is still finishing.')); };
      timer = window.setTimeout(() => { abandoned = true; reject(new Error('Remote source download exceeded its 30-second deadline; the native request is still finishing.')); }, this.deadlineMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (abandoned) abort();
    });

    const operation = (async (): Promise<RemoteDataResponse> => {
      const headers: Record<string, string> = { accept: ACCEPT[options.format ?? 'csv'], 'accept-encoding': 'identity', ...options.headers };
      const post = options.method === 'POST';

      if (abandoned) throw new Error('Remote source download canceled.');

      if (!post && !options.singleRequest) {
        const head = await this.request({ url: options.url, method: 'HEAD', headers, throw: false });

        if (abandoned) throw new Error('Remote source download canceled.');
        if (head.status === 304) return { status: 304, headers: normalizedHeaders(head.headers), bytes: new Uint8Array() };
        if (hasRemoteDocument(head.status)) checkLength(normalizedHeaders(head.headers), options.maxBytes);
      }

      const result = await this.request({ url: options.url, method: post ? 'POST' : 'GET', headers, throw: false, ...(post && { body: options.body, contentType: headers['content-type'] ?? 'application/json' }) });

      if (abandoned) throw new Error('Remote source download canceled.');

      const resultHeaders = normalizedHeaders(result.headers);

      if (!hasRemoteDocument(result.status) && result.status !== 304) {
        throw requestError(result.status, !post && hasJsonBody(resultHeaders) ? new Uint8Array(result.arrayBuffer) : undefined, options.headers);
      }

      if (result.arrayBuffer.byteLength > options.maxBytes) throw new Error(`Remote source exceeds the ${options.maxBytes}-byte download limit after download.`);

      return { status: result.status, headers: resultHeaders, bytes: new Uint8Array(result.arrayBuffer) };
    })();

    const settled = operation.then(() => {}, () => {}).finally(() => { if (this.slot.active === settled) this.slot.active = undefined; });

    this.slot.active = settled;

    return Promise.race([operation, deadline]).finally(() => {
      window.clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    });
  }
}
