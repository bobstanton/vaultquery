import { App } from 'obsidian';
import { PlaceholderResolver, ObsidianContextProvider, obsidianHelpers, escapeSqlString, FileSource } from 'placeholder-resolver';

export async function resolveQueryTemplate(sql: string, app: App, fileSource: FileSource): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Required for cross-package type compatibility
  const contextProvider = new ObsidianContextProvider(app as any, fileSource as any);

  const resolver = new PlaceholderResolver(contextProvider, {
    escapeValue: escapeSqlString,
    prefix: 'this',
    throwOnUnresolved: false,
    customHelpers: obsidianHelpers,
    helpersName: 'h',
  });

  return resolver.resolve(sql);
}

