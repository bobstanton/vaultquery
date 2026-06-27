import { App } from 'obsidian';
import { PlaceholderResolver, ObsidianContextProvider, obsidianHelpers, formatSqlSequence, FileSource } from 'placeholder-resolver';
import { escapeSqlString } from '../utils/SqlIdentifierUtils';

export async function resolveQueryTemplate(sql: string, app: App, fileSource: FileSource): Promise<string> {
  const contextProvider = new ObsidianContextProvider(app, fileSource);

  const resolver = new PlaceholderResolver(contextProvider, {
    escapeValue: escapeSqlString,
    formatArray: formatSqlSequence,
    prefix: 'this',
    customHelpers: obsidianHelpers,
    helpersName: 'h',
  });

  return await resolver.resolve(sql);
}
