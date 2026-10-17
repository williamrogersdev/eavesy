import { describe, expect, test } from 'bun:test';
import { transcriptReady } from './session-ingest';

describe('transcript ready', () => {
  test('is ready once every uploaded part has been transcribed or given up on', () => {
    expect(transcriptReady('processing', [{ status: 'complete' }, { status: 'failed' }])).toBe(true);
    expect(transcriptReady('processing', [{ status: 'complete' }, { status: 'processing' }])).toBe(false);
    expect(transcriptReady('processing', [{ status: 'pending' }])).toBe(false);
  });

  test('is not ready while recording or before any part arrived', () => {
    expect(transcriptReady('recording', [{ status: 'complete' }])).toBe(false);
    expect(transcriptReady('uploading', [{ status: 'complete' }])).toBe(false);
    expect(transcriptReady('processing', [])).toBe(false);
  });

  test('a complete meeting is always ready', () => {
    expect(transcriptReady('complete', [])).toBe(true);
  });
});
