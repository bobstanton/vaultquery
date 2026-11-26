import { hasPlaceholders, type TemplateRenderer } from 'placeholder-resolver/core';
import { REMOTE_BLOCK_LANGUAGES } from '../Constants/RemoteDataLanguages';
import { noteTextResolver } from '../Services/NoteText';
import type { ResolveNoteText } from '../Services/NoteText';
import { sha256Hex, sha256HexOfText } from '../utils/Sha256';
import { decodeDataFileBytes } from '../Tabular/TabularByteDecoder';
import { dataFileParseLimits } from '../Tabular/TabularLimits';
import type { DataFileFormat } from '../Tabular/TabularTypes';
import type { VaultQuerySettings } from '../Settings/Settings';
import { REMOTE_BODY_BLOCK, remoteBlockScanner } from './RemoteDataBlock';
import type { ProviderDefinitionCompletionItem, ProviderRefreshDefinition, VaultQueryTableProvider } from './TableProviderTypes';
import { hasRemoteDocument, remoteSourceUrl } from './RemoteDataTransport';
import type { RemoteDataTransport } from './RemoteDataTransport';
import { DataFileError } from '../Tabular/TabularTypes';
import { getErrorMessage } from '../utils/ErrorMessages';
import { validateSnapshotTableName } from './ProviderSnapshotOperations';

export const remoteProviderId = (format: DataFileFormat): string => REMOTE_BLOCK_LANGUAGES[format].language;

type RemoteDataFields = { url: string; cacheDurationMs: number; method?: 'POST'; rowProperty?: string; headers?: Record<string, string>; body?: string };

type RemoteDataRequest = Omit<RemoteDataFields, 'headers' | 'body'> & { headerDigest?: string; bodyDigest?: string; getHeaders?: () => Record<string, string>; getBody?: () => string };

interface RemoteBlockFields {
  values: Map<string, string>;
  headers: Map<string, string>;
  body?: string;
}

const URL_PLACEMENT = 'Remote URL placeholders belong in path segments or query parameter values.';

function remoteBlockKeys(format: DataFileFormat): ProviderDefinitionCompletionItem[] {
  return [
    { label: 'id', detail: 'Required; starts with a letter; letters, digits and underscores only' },
    { label: 'url', detail: `HTTPS ${format.toUpperCase()} address` },
    { label: 'table', detail: `Defaults to remote_${format}_<id>` },
    { label: 'cache', detail: 'Cache duration in m, h or d; defaults to 1h' },
    { label: 'loadMode', detail: 'When to download the source' },
    { label: 'headers', detail: 'Indented HTTP request headers' },
    { label: 'method', detail: 'Defaults to GET' },
    { label: 'body', detail: 'JSON input for POST requests' },
    ...(format === 'json' ? [{ label: 'rowProperty', detail: 'Top-level property containing a row or an array of rows' }] : []),
  ];
}

function readBlockValue(value: string, key: string): string {
  if (value.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(value);

      if (typeof decoded === 'string') return decoded;
    }
    catch {
      // Report the field name without including its contents.
    }

    throw new Error(`Invalid quoted remote source value for ${key}.`);
  }

  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
}

function readRemoteBlock(source: string, format: DataFileFormat): RemoteBlockFields {
  const label = format.toUpperCase();
  const keys = remoteBlockKeys(format).map(key => key.label);
  const unknownKey = (): Error => new Error(`Remote ${label} accepts only ${keys.join(', ')}.`);
  const scan = remoteBlockScanner();
  const values = new Map<string, string>();
  const headers = new Map<string, string>();
  const bodyLines: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    const scanned = scan(line);

    if (scanned.kind === 'invalid') throw unknownKey();
    if (scanned.kind === 'body') bodyLines.push(line);

    if (scanned.kind === 'header') {
      const [, name, value] = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line.trimStart()) ?? [];

      if (name === undefined) throw new Error('Remote headers require one indented HTTP header per line.');
      if (headers.has(name.toLowerCase())) throw new Error(`Duplicate remote header: ${name.toLowerCase()}.`);
      headers.set(name.toLowerCase(), readBlockValue(value.trim(), name.toLowerCase()));
    }

    if (scanned.kind === 'entry') {
      const { key, value } = scanned;

      if (!keys.includes(key)) throw unknownKey();
      if (values.has(key)) throw new Error(`Duplicate remote ${label} key: ${key}.`);
      if (key === 'headers' && value) throw new Error('Indent HTTP headers on separate lines under headers.');
      values.set(key, key === 'body' ? value : readBlockValue(value, key));
    }
  }

  if (values.has('headers') && !headers.size) throw new Error('Indent at least one HTTP header under headers.');
  const body = values.get('body');

  return { values, headers, body: body === REMOTE_BODY_BLOCK ? bodyLines.join('\n') : body };
}

const renderUrlSuffix: TemplateRenderer = (strings, substitutions) => {
  let suffix = '';
  let component: 'path' | 'key' | 'value' = 'path';
  let segmentStart = 0;
  let parameterInSegment = false;

  const finishSegment = () => {
    if (parameterInSegment && /^(?:\.|%2e){1,2}$/i.test(suffix.slice(segmentStart))) {
      throw new Error('A remote URL path parameter cannot form a dot segment.');
    }

    parameterInSegment = false;
    segmentStart = suffix.length + 1;
  };

  for (const [index, literal] of strings.entries()) {
    for (const part of literal.split(/([/?&=#\\])/)) {
      if (part === '#' || (component === 'path' && part === '\\')) throw new Error(URL_PLACEMENT);
      if (component === 'path') {
        if (part === '/' || part === '?') finishSegment();
        if (part === '?') component = 'key';
      } else if (part === '&') component = 'key';
      else if (part === '=') component = 'value';

      suffix += part;
    }

    if (index < substitutions.length) {
      if (component === 'key') throw new Error(URL_PLACEMENT);
      if (component === 'path') parameterInSegment = true;
      suffix += encodeURIComponent(substitutions[index].text);
    }
  }

  finishSegment();

  return suffix;
};

async function resolveRemoteUrl(template: string, resolve: ResolveNoteText): Promise<string> {
  if (!hasPlaceholders(template)) return remoteSourceUrl(template).href;
  const origin = /^https:\/\/[^/?#\\]+/i.exec(template)?.[0];

  if (!origin || hasPlaceholders(origin) || /[\s\p{Cc}]/u.test(origin) || template.includes('\0')) throw new Error(URL_PLACEMENT);
  remoteSourceUrl(origin);
  const suffix = await resolve(template.slice(origin.length), undefined, renderUrlSuffix);

  return remoteSourceUrl(origin + suffix).href;
}

async function resolveJsonValue(value: unknown, resolve: ResolveNoteText): Promise<unknown> {
  if (typeof value === 'string') return resolve(value);
  if (Array.isArray(value)) return Promise.all(value.map(item => resolveJsonValue(item, resolve)));
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]): Promise<[string, unknown]> => [key, await resolveJsonValue(item, resolve)])));
}

async function resolveJsonBody(source: string, resolve: ResolveNoteText): Promise<string> {
  let data: unknown;

  try {
    data = JSON.parse(source);
  }
  catch {
    throw new Error('Remote request body must contain valid JSON.');
  }

  return JSON.stringify(await resolveJsonValue(data, resolve));
}

async function resolveHeaders(headers: Map<string, string>, resolve: ResolveNoteText): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [name, template] of headers) {
    const value = await resolve(template);

    if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error(`Invalid remote header value for ${name}.`);
    resolved[name] = value;
  }

  return resolved;
}

export async function parseRemoteDataDefinition(source: string, format: DataFileFormat, resolve: ResolveNoteText = noteTextResolver()): Promise<ProviderRefreshDefinition & { request: RemoteDataFields }> {
  const label = format.toUpperCase();
  const fields = readRemoteBlock(source, format);
  const { values } = fields;
  const id = values.get('id') ?? '';

  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) throw new Error(`Remote ${label} id must start with a letter and contain only letters, digits, and underscores.`);
  const prefix = `remote_${format}`;
  const table = values.get('table') ?? `${prefix}_${id}`;

  validateSnapshotTableName(table);
  if (new RegExp(`^${prefix}$`, 'i').test(table)) throw new Error(`The ${prefix} table name is reserved.`);
  const url = await resolveRemoteUrl(values.get('url') ?? '', resolve);
  const age = /^(\d+)(m|h|d)$/.exec(values.get('cache') ?? '1h');

  if (!age) throw new Error(`Remote ${label} cache must be a positive duration such as 30m, 1h, or 2d.`);
  const cacheDurationMs = Number(age[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[age[2]] ?? 0);

  if (!Number.isSafeInteger(cacheDurationMs) || cacheDurationMs <= 0 || !Number.isSafeInteger(Date.now() + cacheDurationMs)) throw new Error(`Remote ${label} cache is outside the supported range.`);
  const loadMode = values.get('loadMode');
  const rowProperty = values.get('rowProperty');
  const method = (values.get('method') ?? 'GET').toUpperCase();

  if (loadMode !== undefined && loadMode !== 'eager' && loadMode !== 'lazy') throw new Error(`Remote ${label} loadMode must be eager or lazy.`);
  if (rowProperty === '') throw new Error('Remote JSON rowProperty requires a property name.');
  if (method !== 'GET' && method !== 'POST') throw new Error('Remote request method must be GET or POST.');
  if (fields.body !== undefined && method !== 'POST') throw new Error('A remote request body requires method: POST.');

  const request: RemoteDataFields = { url, cacheDurationMs };

  if (method === 'POST') request.method = method;
  if (fields.body !== undefined) request.body = await resolveJsonBody(fields.body, resolve);
  if (rowProperty) request.rowProperty = rowProperty;
  if (fields.headers.size) request.headers = await resolveHeaders(fields.headers, resolve);

  return { id, loadMode, requestedTables: [table], request };
}

export function createRemoteDataProvider(format: DataFileFormat, settings: Pick<VaultQuerySettings, 'dataFileMaxSizeMiB'>, transport: RemoteDataTransport): VaultQueryTableProvider {
  const label = format.toUpperCase();

  return {
    id: remoteProviderId(format),
    displayName: `Remote ${label}`,
    tables: [],
    definitionTables: { format, readOnly: true },
    whenIdle: () => transport.whenIdle(),
    definitionBlock: {
      language: REMOTE_BLOCK_LANGUAGES[format].language,
      noteParameters: true,
      parse: async (source, context) => {
        const definition = await parseRemoteDataDefinition(source, format, context.resolveNoteText);
        const { headers, body, ...fields } = definition.request;
        const request: RemoteDataRequest = fields;

        if (headers) {
          request.headerDigest = await sha256HexOfText(JSON.stringify(headers));
          request.getHeaders = () => headers;
        }

        if (body !== undefined) {
          request.bodyDigest = await sha256HexOfText(body);
          request.getBody = () => body;
        }

        return { ...definition, request };
      },
      completions: { keys: remoteBlockKeys(format), values: { method: [{ label: 'GET', detail: 'Default' }, { label: 'POST' }], loadMode: [{ label: 'eager', detail: 'During indexing' }, { label: 'lazy', detail: 'On first query' }], cache: [{ label: '1h', detail: 'Default' }, { label: '30m' }, { label: '1d' }] } },
    },
    refresh: async context => {
      const table = context.requestedTables?.[0];

      if (!table || context.requestedTables?.length !== 1) throw new Error(`Remote ${label} requires one reserved table.`);
      const request = (context.request ?? {}) as Partial<RemoteDataRequest>;
      const url = remoteSourceUrl(typeof request.url === 'string' ? request.url : '').href;
      const cacheDurationMs = Number(request.cacheDurationMs);

      if (!Number.isSafeInteger(cacheDurationMs) || cacheDurationMs <= 0) throw new Error(`Remote ${label} refresh age is invalid.`);
      if (transport.busy) throw new Error(`A remote ${label} download is still in progress. Retry after it finishes.`);
      const limits = dataFileParseLimits(settings.dataFileMaxSizeMiB);
      const maxBytes = limits.maxFileBytes;
      const previous = context.existingSnapshots?.find(snapshot => snapshot.table === table);
      const customHeaders = request.getHeaders?.();
      const headers = { ...customHeaders };
      const post = request.method === 'POST';
      const body = request.getBody?.();

      if (!post && previous?.etag) headers['if-none-match'] = previous.etag;
      else if (!post && previous?.lastModified) headers['if-modified-since'] = previous.lastModified;
      let received = false;

      try {
        let response = await transport.download({ url, format, maxBytes, headers, singleRequest: Boolean(customHeaders), signal: context.signal,
          ...(post && { method: 'POST', body }) });

        if (post && response.status === 304) throw new Error('Remote POST returned HTTP 304 without a document.');

        if (response.status === 304 && !previous) {
          const retryHeaders = customHeaders && { ...customHeaders };

          if (retryHeaders) {
            delete retryHeaders['if-none-match'];
            delete retryHeaders['if-modified-since'];
          }

          response = await transport.download({ url, format, maxBytes, headers: retryHeaders, singleRequest: Boolean(customHeaders), signal: context.signal });
        }

        const asOf = Date.now();

        received = true;

        const metadata = { table, asOf, validatedAt: asOf, expiresAt: asOf + cacheDurationMs,
          etag: response.headers.etag ?? (response.status === 304 ? previous?.etag : undefined),
          lastModified: response.headers['last-modified'] ?? (response.status === 304 ? previous?.lastModified : undefined) };

        if (response.status === 304 && previous) return { tables: {}, unchangedSnapshots: [{ ...metadata, asOf: previous.asOf, revision: previous.revision }] };
        if (!hasRemoteDocument(response.status)) throw new Error(`Remote ${label} request returned HTTP ${response.status}.`);
        const prefix = new TextDecoder().decode(response.bytes.subarray(0, 2048)).trimStart();

        if (/^(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s[^>]*)?>[\s\S]*<(?:head|body)(?:\s|>)/i.test(prefix)) {
          throw new Error(`The endpoint returned an HTML document instead of ${label}.`);
        }

        if (format === 'csv' && /^\{\s*"(?:error|errors)"\s*:/.test(prefix)) {
          throw new Error('The endpoint returned an HTML or JSON error document instead of CSV.');
        }

        const document = decodeDataFileBytes(response.bytes, table, format, limits, { rowProperty: request.rowProperty });
        const revision = await sha256Hex(response.bytes);

        if (previous?.revision === revision) return { tables: {}, unchangedSnapshots: [{ ...metadata, asOf: previous.asOf, revision }] };

        return { tables: {}, snapshots: [{ kind: 'table', ...metadata, revision, document }] };
      }
      catch (error) {
        if (error instanceof DataFileError && received) throw error;

        const message = getErrorMessage(error).replace(/https?:\/\/[^\s"'<>]+/gi, address => {
          try {
            const parsed = new URL(address);

            return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`;
          }
          catch {
            return '[source URL]';
          }
        });

        throw new Error(`Remote ${label} ${context.definitionId}: ${message}`);
      }
    },
  };
}
