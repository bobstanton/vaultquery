import type { App } from 'obsidian';
import { SimpleContextProvider, type ResolverOptions } from 'placeholder-resolver/core';
import { ObsidianContextProvider, obsidianHelpers, type FileSource } from 'placeholder-resolver/obsidian';
import { resolveSqlTemplate } from 'placeholder-resolver/sql';

export function resolveQueryTemplate(sql: string, app: App, source?: FileSource, bindings?: ResolverOptions['bindings']): Promise<string> {
  const context = source ? new ObsidianContextProvider(app, source) : new SimpleContextProvider({});

  return resolveSqlTemplate(sql, context, { customHelpers: obsidianHelpers, bindings });
}
