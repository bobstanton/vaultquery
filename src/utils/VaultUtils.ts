import { TFile, normalizePath } from 'obsidian';
import type { Vault } from 'obsidian';
import { logger as rootLogger } from './logger';
import { pathParent } from './PathUtils';

const logger = rootLogger.scope('VaultUtils');

export function resolveVaultFile(vault: Vault, path: string): TFile | null {
  const file = vault.getAbstractFileByPath(normalizePath(path));

  return file instanceof TFile ? file : null;
}

export async function createFileWithFolders(vault: Vault, path: string, content: string | Uint8Array): Promise<void> {
  const normalizedPath = normalizePath(path);
  const parentPath = pathParent(normalizedPath);

  if (parentPath && !vault.getAbstractFileByPath(parentPath)) {
    try {
      await vault.createFolder(parentPath);
    }
    catch (error) {
      logger.warn('Folder creation failed', parentPath, error);
    }
  }

  if (typeof content === 'string') await vault.create(normalizedPath, content);
  else await vault.createBinary(normalizedPath, content.slice().buffer);
}
