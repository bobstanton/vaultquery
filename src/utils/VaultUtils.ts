import { Vault, normalizePath } from 'obsidian';
import { logger as rootLogger } from './logger';

const logger = rootLogger.scope('VaultUtils');

export async function createNoteWithFolders(vault: Vault, path: string, content: string): Promise<void> {
  const normalizedPath = normalizePath(path);
  const parentPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));

  if (parentPath && !vault.getAbstractFileByPath(parentPath)) {
    try {
      await vault.createFolder(parentPath);
    }
    catch (error) {
      logger.warn('Folder creation failed', parentPath, error);
    }
  }

  await vault.create(normalizedPath, content);
}
