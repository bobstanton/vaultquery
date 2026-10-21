export interface HeaderDimensions {
  width: number | null;
  height: number | null;
  mime_type: string;
}

export function readHeaderDimensions(extension: string, buffer: ArrayBuffer): HeaderDimensions | null {
  const bytes = new Uint8Array(buffer);

  switch (extension.toLowerCase()) {
    case 'bmp': return readBmp(bytes);
    case 'ico': return readIco(bytes);
    case 'svg': return readSvg(bytes);
    default: return null;
  }
}

function readBmp(bytes: Uint8Array): HeaderDimensions | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)), mime_type: 'image/bmp' };
}

function readIco(bytes: Uint8Array): HeaderDimensions | null {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || bytes[3] !== 0) return null;
  const entries = bytes[4] | (bytes[5] << 8);
  if (entries === 0 || bytes.length < 6 + 16) return null;
  const size = (value: number): number => value === 0 ? 256 : value;

  return { width: size(bytes[6]), height: size(bytes[7]), mime_type: 'image/vnd.microsoft.icon' };
}

function readSvg(bytes: Uint8Array): HeaderDimensions | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  const open = /<svg\b[^>]*>/i.exec(text);
  if (!open) return null;

  const attribute = (name: string): number | null => {
    // Only a bare number or pixels is a size; 100% or 2em depends on where the image is placed.
    const match = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i').exec(open[0]);
    const value = match ? Number(match[1]) : NaN;

    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const width = attribute('width'), height = attribute('height');
  if (width !== null && height !== null) return { width, height, mime_type: 'image/svg+xml' };
  const box = /\bviewBox\s*=\s*["']\s*([-0-9.]+)[\s,]+([-0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(open[0]);
  if (!box) return { width, height, mime_type: 'image/svg+xml' };

  return { width: width ?? Number(box[3]), height: height ?? Number(box[4]), mime_type: 'image/svg+xml' };
}
