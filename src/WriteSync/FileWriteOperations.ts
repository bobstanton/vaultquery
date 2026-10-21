import { TFile, getFrontMatterInfo } from 'obsidian';
import type { Vault } from 'obsidian';
import { FilePreviewStaleError } from './FileWriteTypes';

const BOM = '\ufeff';
const withoutBom = (text: string): string => text.startsWith(BOM) ? text.slice(1) : text;

export async function processFileContents(vault: Vault, file: TFile, path: string, expected: string, replacement: string, assertAccess: () => void): Promise<void> {
  await vault.process(file, current => {
    assertAccess();

    if (file.path !== path || vault.getAbstractFileByPath(path) !== file || withoutBom(current) !== withoutBom(expected)) {
      throw new FilePreviewStaleError(`File changed before writing: ${path}`);
    }

    return current.startsWith(BOM) && !replacement.startsWith(BOM) ? BOM + replacement : replacement;
  });
}

export interface TextFileSource { file: TFile | null; content: string | null; frontmatterOnly?: boolean }

export async function readTextFileSource(vault: Vault, path: string, frontmatterOnly = false): Promise<TextFileSource> {
  const file = vault.getAbstractFileByPath(path);
  if (!file) return { file: null, content: null };
  if (!(file instanceof TFile)) throw new FilePreviewStaleError(`File path is occupied by a folder: ${path}`);

  const { size, mtime, ctime } = file.stat;
  const content = await vault.read(file);

  if (file.path !== path || vault.getAbstractFileByPath(path) !== file
    || file.stat.size !== size || file.stat.mtime !== mtime || file.stat.ctime !== ctime) {
    throw new FilePreviewStaleError(`File changed during reading: ${path}`);
  }

  return { file, content: frontmatterOnly ? getFrontMatterInfo(content).frontmatter : content, frontmatterOnly };
}

export function assertTextFileSource(path: string, expected: TextFileSource, actual: TextFileSource): void {
  if (expected.file !== actual.file || expected.content !== actual.content) {
    throw new FilePreviewStaleError(`File changed since preview: ${path}`);
  }
}
