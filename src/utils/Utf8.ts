export function utf8ByteLength(value: string, rejectInvalidUnicode = false): number {
  let bytes = 0;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else {
      if (rejectInvalidUnicode && code >= 0xd800 && code <= 0xdfff) throw new Error('An unpaired Unicode surrogate cannot be preserved as UTF-8.');
      bytes += 3;
    }
  }

  return bytes;
}
