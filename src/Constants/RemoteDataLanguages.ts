import type { DataFileFormat } from '../Tabular/TabularTypes';

const REMOTE_CSV_LANGUAGE = 'vaultquery-remote-csv';
const REMOTE_JSON_LANGUAGE = 'vaultquery-remote-json';

const LEGACY_WEB_JSON_LANGUAGE = 'vaultquery-web-json';

export const REMOTE_BLOCK_LANGUAGES: Record<DataFileFormat, { language: string; aliases: readonly string[] }> = {
  csv: { language: REMOTE_CSV_LANGUAGE, aliases: [] },
  json: { language: REMOTE_JSON_LANGUAGE, aliases: [LEGACY_WEB_JSON_LANGUAGE] },
};

export const REMOTE_DATA_LANGUAGES = new Set(Object.values(REMOTE_BLOCK_LANGUAGES).flatMap(({ language, aliases }) => [language, ...aliases]));
