import { describe, expect, test } from 'bun:test';
import { imageSize, sniffImageType } from './image-size';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to skip, then SOF2 (progressive).
  const app0 = [0xff, 0xe0, 0x00, 0x06, 1, 2, 3, 4];
  const sof = [0xff, 0xc2, 0x00, 0x0b, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 0, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
}

describe('image size', () => {
  test('reads a PNG header', () => {
    expect(sniffImageType(png(1920, 1080))).toBe('image/png');
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  test('reads a JPEG frame header past other segments', () => {
    expect(sniffImageType(jpeg(1600, 900))).toBe('image/jpeg');
    expect(imageSize(jpeg(1600, 900))).toEqual({ width: 1600, height: 900 });
  });

  test('anything else is not an image', () => {
    expect(sniffImageType(new TextEncoder().encode('<svg></svg>'))).toBeNull();
    expect(imageSize(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(imageSize(png(0, 10))).toBeNull();
  });
});
