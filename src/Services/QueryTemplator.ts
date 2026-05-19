import { App } from 'obsidian';
import { PlaceholderResolver, ObsidianContextProvider, obsidianHelpers, escapeSqlString, FileSource } from 'placeholder-resolver';

export async function resolveQueryTemplate(sql: string, app: App, fileSource: FileSource): Promise<string> {
  const contextProvider = new ObsidianContextProvider(app, fileSource);

  const resolver = new PlaceholderResolver(contextProvider, {
    escapeValue: escapeSqlString,
    prefix: 'this',
    throwOnUnresolved: false,
    customHelpers: obsidianHelpers,
    helpersName: 'h',
  });

  return await resolver.resolve(sql);
}
