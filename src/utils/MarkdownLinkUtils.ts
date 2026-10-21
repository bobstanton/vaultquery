import { TFile } from 'obsidian';
import type { App } from 'obsidian';

export function generateFileLink(app: App, target: string, sourcePath = '', subpath = '', alias = ''): string {
  const anchor = target.indexOf('#');

  if (anchor !== -1) {
    subpath = target.slice(anchor) + subpath;
    target = target.slice(0, anchor);
  }

  const file = app.vault.getAbstractFileByPath(target) ?? app.metadataCache.getFirstLinkpathDest(target, sourcePath);
  if (file instanceof TFile) return app.fileManager.generateMarkdownLink(file, sourcePath, subpath, alias);

  return formatWikiLink(target + subpath, alias);
}

export function formatWikiLink(target: string, text: string): string {
  return text && text !== target ? `[[${target}|${text}]]` : `[[${target}]]`;
}
