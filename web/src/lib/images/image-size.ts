export type ImageType = 'image/png' | 'image/jpeg';

/** What the bytes are, from their signature, whatever the upload claims. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Width and height of a PNG (its IHDR) or a JPEG (its first frame header), else null. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'image/png') {
    if (bytes.length < 24) return null;
    return positive(view.getUint32(16), view.getUint32(20));
  }
  if (type !== 'image/jpeg') return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = view.getUint16(at + 2);
    if (length < 2) return null;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      return positive(view.getUint16(at + 7), view.getUint16(at + 5));
    }
    at += 2 + length;
  }
  return null;
}

function positive(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : null;
}
