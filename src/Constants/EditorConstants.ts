export const VAULTQUERY_LANGUAGES = new Set([
  'vaultquery',
  'vaultquery-write',
  'vaultquery-schema',
  'vaultquery-chart',
  'vaultquery-calendar',
  'vaultquery-help',
  'vaultquery-markdown',
  'vaultquery-markdown-help',
  'vaultquery-view',
  'vaultquery-function',
  'vaultquery-trigger',
]);

export const PROVIDER_DEFINITION_LANGUAGES = new Set<string>();

export function registerProviderDefinitionLanguage(language: string): void {
  const normalized = language.trim();
  if (!normalized) {
    return;
  }

  VAULTQUERY_LANGUAGES.add(normalized);
  PROVIDER_DEFINITION_LANGUAGES.add(normalized);
}

export const CONFIG_CAPABLE_LANGUAGES = new Set([
  'vaultquery',
  'vaultquery-chart',
  'vaultquery-markdown',
  'vaultquery-calendar',
]);

export const SQL_EDITOR_LANGUAGES = new Set([
  ...CONFIG_CAPABLE_LANGUAGES,
  'vaultquery-write',
  'vaultquery-view',
  'vaultquery-trigger',
]);
