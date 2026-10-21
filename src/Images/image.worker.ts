import { DOMParser, onErrorStopParsing } from '@xmldom/xmldom';
import { parseImagePrefix } from './ImageMetadataParser';
import { getErrorMessage } from '../utils/ErrorMessages';

const domParser = new DOMParser({ onError: onErrorStopParsing });

self.onmessage = (event: MessageEvent<{ id: number; buffer: ArrayBuffer; extension: string; size: number }>) => {
  const { id, buffer, extension, size } = event.data;

  try {
    const result = parseImagePrefix(buffer, extension, size, true, domParser);
    self.postMessage({ id, buffer, result }, { transfer: [buffer] });
  } catch (error) {
    self.postMessage({ id, error: getErrorMessage(error) });
  }
};

self.postMessage({ ready: true });
