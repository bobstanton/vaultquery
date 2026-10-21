import { isIndexablePath } from '../OtherFiles/OtherFileContentSettings';
import { pathExtension } from '../utils/PathUtils';

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'heic', 'heif', 'hif', 'tif', 'tiff', 'jxl', 'bmp', 'ico', 'svg',
  'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'sr2', 'orf', 'rw2', 'raf', 'pef', 'srw', '3fr', 'iiq', 'erf', 'rwl', 'dcr', 'kdc', 'mos',
]);

const TIFF_FAMILY_EXTENSIONS: ReadonlySet<string> = new Set([
  'tif', 'tiff', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'sr2', 'orf', 'rw2', 'raf', 'pef', 'srw', '3fr', 'iiq', 'erf', 'rwl', 'dcr', 'kdc', 'mos',
]);

const HEADER_ONLY_EXTENSIONS: ReadonlySet<string> = new Set(['bmp', 'ico', 'svg']);

export const IMAGE_PREFIX_BYTES = 128 * 1024;
export const TIFF_PREFIX_BYTES = 1024 * 1024;

export interface ImageIndexSettings {
  indexImageMetadata: boolean;
  excludePatterns: string[];
}

export const isImageExtension = (extension: string): boolean => IMAGE_EXTENSIONS.has(extension.toLowerCase());
export const isTiffFamily = (extension: string): boolean => TIFF_FAMILY_EXTENSIONS.has(extension.toLowerCase());
export const isHeaderOnlyFormat = (extension: string): boolean => HEADER_ONLY_EXTENSIONS.has(extension.toLowerCase());

export function isIndexableImage(path: string): boolean {
  return isImageExtension(pathExtension(path)) && isIndexablePath(path);
}

export function prefixBytesFor(extension: string): number {
  return isTiffFamily(extension) ? TIFF_PREFIX_BYTES : IMAGE_PREFIX_BYTES;
}
