export const SAMPLE_RATE = 16_000;
export const SEGMENT_SECONDS = 240;
export const MAX_IMPORT_SECONDS = 3600;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

/** Canonical mono PCM16 WAV. Shared by browser encoder and server validation. */
export function encodeWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export function wavDurationMs(bytes: Uint8Array): number {
  if (bytes.length < 46 || bytes.length > 44 + SAMPLE_RATE * SEGMENT_SECONDS * 2 || bytes.length % 2 !== 0) throw new Error('Invalid WAV size');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, n: number) => new TextDecoder().decode(bytes.subarray(offset, offset + n));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || text(12, 4) !== 'fmt ' || text(36, 4) !== 'data'
    || v.getUint32(4, true) !== bytes.length - 8 || v.getUint32(16, true) !== 16
    || v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint32(24, true) !== SAMPLE_RATE
    || v.getUint32(28, true) !== SAMPLE_RATE * 2 || v.getUint16(32, true) !== 2 || v.getUint16(34, true) !== 16
    || v.getUint32(40, true) !== bytes.length - 44) throw new Error('Expected mono 16kHz PCM16 WAV');
  return Math.round((bytes.length - 44) / 2 / SAMPLE_RATE * 1000);
}
