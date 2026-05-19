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

export const SQL_HIGHLIGHTED_LANGUAGES = [
  'vaultquery',
  'vaultquery-write',
  'vaultquery-view',
  'vaultquery-trigger',
] as const;

export const JS_HIGHLIGHTED_LANGUAGES = [
  'vaultquery-function',
] as const;
