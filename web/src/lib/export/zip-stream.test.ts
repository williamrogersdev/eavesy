import { expect, test } from 'bun:test';
import JSZip from 'jszip';
import { zipStream } from '@/lib/export/zip-stream';

const read = (stream: ReadableStream<Uint8Array>) => new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));

function streamOf(...parts: Uint8Array[]) {
  return () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
}

test('writes entries that standard unzip tools read back, at the declared length', async () => {
  const text = new TextEncoder().encode('Café notes ✓');
  const { stream, length } = zipStream([
    { name: 'Réunion/notes.md', size: text.byteLength, data: text },
    { name: 'Réunion/audio.m4a', size: 6, data: streamOf(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])) },
    { name: 'empty.txt', size: 0, data: new Uint8Array() },
  ]);
  const bytes = await read(stream);
  expect(bytes.byteLength).toBe(length);

  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  expect(await zip.file('Réunion/notes.md')!.async('string')).toBe('Café notes ✓');
  expect([...(await zip.file('Réunion/audio.m4a')!.async('uint8array'))]).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await zip.file('empty.txt')!.async('string')).toBe('');
});

test('fails the download rather than writing a corrupt archive when a source is short', async () => {
  const { stream } = zipStream([{ name: 'audio.m4a', size: 10, data: streamOf(new Uint8Array(4)) }]);
  expect(read(stream)).rejects.toThrow('expected 10');
});
