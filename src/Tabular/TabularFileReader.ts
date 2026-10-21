import { sha256Hex } from '../utils/Sha256';
import { DataFileError, dataFileFormat } from './TabularTypes';
import type { TabularDocument, TabularParseLimits } from './TabularTypes';
import { checkDataFileSize, dataFileParseLimits } from './TabularLimits';
import { decodeDataFileBytes } from './TabularByteDecoder';
import { getErrorMessage } from '../utils/ErrorMessages';

export interface DataFileSource {
  readonly path: string;
  stat(): Promise<{ size: number; mtime: number } | null>;
  readBinary(): Promise<ArrayBuffer>;
}

export interface DataFileAdapter {
  stat(path: string): Promise<{ size: number; mtime: number; type: string } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export function vaultDataFileSource(adapter: DataFileAdapter, path: string, beforeRead: () => void): DataFileSource {
  return {
    path,
    stat: async () => {
      const stat = await adapter.stat(path);

      return stat?.type === 'file' ? stat : null;
    },
    readBinary: () => {
      beforeRead();

      return adapter.readBinary(path);
    },
  };
}

export async function readDataFileBytes(file: DataFileSource, limits: TabularParseLimits = dataFileParseLimits()): Promise<{ bytes: ArrayBuffer; mtime: number; revision: string }> {
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    }
    catch (error) {
      throw new DataFileError(file.path, 'io', `Could not read the file: ${getErrorMessage(error)}`);
    }
  };

  const before = await read(() => file.stat());
  if (!before) throw new DataFileError(file.path, 'source-changed', 'The source no longer exists.');
  checkDataFileSize(file.path, before.size, limits);
  const bytes = await read(() => file.readBinary());
  checkDataFileSize(file.path, bytes.byteLength, limits);
  const after = await read(() => file.stat());

  if (!after || after.mtime !== before.mtime || after.size !== before.size || bytes.byteLength !== after.size) {
    throw new DataFileError(file.path, 'source-changed', 'The source changed during reading; queue a fresh index.');
  }

  const revision = await sha256Hex(bytes);

  return { bytes, mtime: after.mtime, revision };
}

export async function readDataFile(file: DataFileSource, limits: TabularParseLimits = dataFileParseLimits()): Promise<{ document: TabularDocument; mtime: number; revision: string }> {
  const { bytes, mtime, revision } = await readDataFileBytes(file, limits);

  return { document: decodeDataFileBytes(bytes, file.path, dataFileFormat(file.path), limits), mtime, revision };
}
