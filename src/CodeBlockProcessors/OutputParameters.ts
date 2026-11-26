import type { App } from 'obsidian';
import { hasPlaceholders } from 'placeholder-resolver/core';
import { ObsidianContextProvider } from 'placeholder-resolver/obsidian';
import { noteTextResolver } from '../Services/NoteText';
import type { ParsedQuery } from '../types';

const OUTPUT_PARAMETER_FIELDS: Partial<Record<string, readonly string[]>> = {
  chart: ['title', 'datasetlabel', 'xlabel', 'ylabel'],
  calendar: ['initialdate'],
};

export async function resolveOutputParameters(parsed: ParsedQuery, app: App, path: string): Promise<ParsedQuery> {
  const output = parsed.output;

  if (!output?.options) return parsed;
  const fields = OUTPUT_PARAMETER_FIELDS[output.kind] ?? [];
  const entries = Object.entries(output.options).filter((entry): entry is [string, string] =>
    fields.includes(entry[0].toLowerCase()) && typeof entry[1] === 'string' && hasPlaceholders(entry[1]));

  if (!entries.length) return parsed;
  const resolve = noteTextResolver(new ObsidianContextProvider(app, path));
  const options = { ...output.options };

  for (const [key, value] of entries) options[key] = await resolve(value);

  return { ...parsed, output: { ...output, options } };
}
