// Buffer encodes natively from the same memory, with no intermediate binary
// string the size of the audio.
export function audioBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
