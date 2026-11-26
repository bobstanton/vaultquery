import { PlaceholderResolver, SimpleContextProvider, type ContextProvider, type TemplateRenderer } from 'placeholder-resolver/core';
import { obsidianHelpers } from 'placeholder-resolver/obsidian';

export type ResolveNoteText = (text: string, format?: (value: string) => string, render?: TemplateRenderer) => Promise<string>;

function plainDate(value: Date): string {
  return value.toISOString().replace(/T00:00:00\.000Z$/, '');
}

export function noteTextResolver(context: ContextProvider = new SimpleContextProvider({})): ResolveNoteText {
  return (text, format, render) => {
    const resolver = new PlaceholderResolver(context, {
      customHelpers: obsidianHelpers, strict: true, escapeValue: format, formatDate: plainDate, formatArray: (values, escape) => escape(values.map(value => (value instanceof Date ? plainDate(value) : value)).join(',')),
    });

    return resolver.resolve(text, render);
  };
}
