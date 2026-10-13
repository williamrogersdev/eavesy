import { describe, expect, test } from 'bun:test';
import { safeMediaType } from './media-type';

describe('safeMediaType', () => {
  test('keeps audio, video and raster image types', () => {
    expect(safeMediaType('audio/mp4')).toBe('audio/mp4');
    expect(safeMediaType('video/quicktime')).toBe('video/quicktime');
    expect(safeMediaType('image/png; charset=binary')).toBe('image/png');
  });

  test('downgrades anything that could render as a document', () => {
    expect(safeMediaType('text/html')).toBe('application/octet-stream');
    expect(safeMediaType('image/svg+xml')).toBe('application/octet-stream');
    expect(safeMediaType(undefined)).toBe('application/octet-stream');
  });
});
