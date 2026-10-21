import { sha256Hex } from '../utils/Sha256';
import { decodeDataFileBytes } from '../Tabular/TabularByteDecoder';
import { dataFileParseLimits } from '../Tabular/TabularLimits';
import type { DataFileFormat } from '../Tabular/TabularTypes';
import type { VaultQuerySettings } from '../Settings/Settings';
import type { ProviderRefreshDefinition, VaultQueryTableProvider } from './TableProviderTypes';
import { webCsvUrl } from './WebCsvTransport';
import type { WebCsvTransport } from './WebCsvTransport';
import { DataFileError } from '../Tabular/TabularTypes';
import { getErrorMessage } from '../utils/ErrorMessages';
import { validateSnapshotTableName } from './ProviderSnapshotOperations';

export const WEB_CSV_PROVIDER_ID = 'vaultquery-remote-csv';
export const WEB_JSON_PROVIDER_ID = 'vaultquery-web-json';

export const webProviderId = (format: DataFileFormat): string => format === 'json' ? WEB_JSON_PROVIDER_ID : WEB_CSV_PROVIDER_ID;

export function parseWebDataDefinition(source: string, format: DataFileFormat): ProviderRefreshDefinition {
  const label = format.toUpperCase();
  const values = new Map<string, string>();

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match || !['id', 'url', 'table', 'cache'].includes(match[1])) throw new Error(`Remote ${label} accepts only id, url, table, and cache, one key per line.`);
    if (values.has(match[1])) throw new Error(`Duplicate remote ${label} key: ${match[1]}.`);
    let value = match[2];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      }
      catch {
        throw new Error(`Invalid quoted remote ${label} value: ${match[1]}.`);
      }
    }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    values.set(match[1], value);
  }

  const id = values.get('id') ?? '';
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) throw new Error(`Remote ${label} id must start with a letter and contain only letters, digits, and underscores.`);
  const prefix = `web_${format}`;
  const table = values.get('table') ?? `${prefix}_${id}`;
  validateSnapshotTableName(table);
  if (new RegExp(`^${prefix}$`, 'i').test(table)) throw new Error(`The ${prefix} table name is reserved.`);
  const url = webCsvUrl(values.get('url') ?? '').href;
  const age = /^(\d+)(m|h|d)$/.exec(values.get('cache') ?? '1h');
  if (!age) throw new Error(`Remote ${label} cache must be a positive duration such as 30m, 1h, or 2d.`);
  const cacheDurationMs = Number(age[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[age[2]] ?? 0);
  if (!Number.isSafeInteger(cacheDurationMs) || cacheDurationMs <= 0 || !Number.isSafeInteger(Date.now() + cacheDurationMs)) throw new Error(`Remote ${label} cache is outside the supported range.`);

  return { id, requestedTables: [table], request: { url, cacheDurationMs } };
}

export function createWebDataProvider(format: DataFileFormat, settings: Pick<VaultQuerySettings, 'dataFileMaxSizeMiB'>, transport: WebCsvTransport): VaultQueryTableProvider {
  const label = format.toUpperCase();

  return {
    id: webProviderId(format),
    displayName: `Remote ${label}`,
    tables: [],
    definitionTables: { format, readOnly: true },
    whenIdle: () => transport.whenIdle(),
    definitionBlock: {
      language: webProviderId(format), parse: source => parseWebDataDefinition(source, format),
      completions: { keys: [
        { label: 'id', detail: 'Required; starts with a letter; letters, digits and underscores only' }, { label: 'url', detail: `HTTPS ${label} address` },
        { label: 'table', detail: `Defaults to web_${format}_<id>` }, { label: 'cache', detail: 'Cache duration in m, h or d; defaults to 1h' },
      ], values: { cache: [{ label: '1h', detail: 'Default' }, { label: '30m' }, { label: '1d' }] } },
    },
    refresh: async context => {
      const table = context.requestedTables?.[0];
      if (!table || context.requestedTables?.length !== 1) throw new Error(`Remote ${label} requires one reserved table.`);
      const url = webCsvUrl(typeof context.request?.url === 'string' ? context.request.url : '').href;
      const cacheDurationMs = Number(context.request?.cacheDurationMs);
      if (!Number.isSafeInteger(cacheDurationMs) || cacheDurationMs <= 0) throw new Error(`Remote ${label} refresh age is invalid.`);
      if (transport.busy) throw new Error(`A remote ${label} download is still in progress. Retry after it finishes.`);
      const limits = dataFileParseLimits(settings.dataFileMaxSizeMiB);
      const maxBytes = limits.maxFileBytes;
      const previous = context.existingSnapshots?.find(snapshot => snapshot.table === table);
      const headers: Record<string, string> = {};
      if (previous?.etag) headers['If-None-Match'] = previous.etag;
      else if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
      let received = false;

      try {
        let response = await transport.download({ url, format, maxBytes, headers, signal: context.signal });
        if (response.status === 304 && !previous) response = await transport.download({ url, format, maxBytes, signal: context.signal });
        const asOf = Date.now();
        received = true;

        const metadata = { table, asOf, validatedAt: asOf, expiresAt: asOf + cacheDurationMs,
          etag: response.headers.etag ?? (response.status === 304 ? previous?.etag : undefined),
          lastModified: response.headers['last-modified'] ?? (response.status === 304 ? previous?.lastModified : undefined) };

        if (response.status === 304 && previous) return { tables: {}, unchangedSnapshots: [{ ...metadata, asOf: previous.asOf, revision: previous.revision }] };
        if (response.status !== 200) throw new Error(`Remote ${label} request returned HTTP ${response.status}.`);
        const prefix = new TextDecoder().decode(response.bytes.subarray(0, 2048)).trimStart();

        if (/^(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s[^>]*)?>[\s\S]*<(?:head|body)(?:\s|>)/i.test(prefix)) {
          throw new Error(`The endpoint returned an HTML document instead of ${label}.`);
        }

        if (format === 'csv' && /^\{\s*"(?:error|errors)"\s*:/.test(prefix)) {
          throw new Error('The endpoint returned an HTML or JSON error document instead of CSV.');
        }

        const document = decodeDataFileBytes(response.bytes, table, format, limits);
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
