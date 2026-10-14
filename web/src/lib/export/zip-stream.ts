/**
 * A streaming ZIP writer for exports. Entries are stored, not deflated (the
 * audio is already compressed and the text is small), so the archive's exact
 * length is known up front and large entries are piped straight through
 * without being held in memory. A data descriptor after each entry carries the
 * CRC, which is only known once the bytes have passed.
 */

export interface ZipEntry {
  name: string;
  size: number;
  data: Uint8Array | (() => ReadableStream<Uint8Array>);
}

const LOCAL_HEADER = 30;
const DATA_DESCRIPTOR = 16;
const CENTRAL_HEADER = 46;
const END_OF_CENTRAL_DIRECTORY = 22;
const MAX_ZIP32 = 0xffff_ffff;
const FLAGS = (1 << 3) | (1 << 11); // data descriptor follows; names are UTF-8

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffff_ffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffff_ffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((Math.max(1980, date.getUTCFullYear()) - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export function zipLength(entries: { name: string; size: number }[]): number {
  const encoder = new TextEncoder();
  return entries.reduce((total, entry) => {
    const name = encoder.encode(entry.name).byteLength;
    return total + LOCAL_HEADER + name + entry.size + DATA_DESCRIPTOR + CENTRAL_HEADER + name;
  }, END_OF_CENTRAL_DIRECTORY);
}

export function zipStream(entries: ZipEntry[], modified = new Date()): { stream: ReadableStream<Uint8Array>; length: number } {
  const length = zipLength(entries);
  if (length > MAX_ZIP32 || entries.length > 0xffff) throw new Error('export is too large for a ZIP32 archive');
  const iterator = chunks(entries, dosDateTime(modified));
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return { stream, length };
}

async function* chunks(entries: ZipEntry[], stamp: { time: number; date: number }): AsyncGenerator<Uint8Array, void, undefined> {
  const encoder = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(LOCAL_HEADER + name.byteLength);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x0403_4b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, FLAGS, true);
    header.setUint16(8, 0, true);
    header.setUint16(10, stamp.time, true);
    header.setUint16(12, stamp.date, true);
    // CRC and sizes are zero here and written in the data descriptor.
    header.setUint16(26, name.byteLength, true);
    local.set(name, LOCAL_HEADER);
    yield local;

    let crc = 0;
    let written = 0;
    if (entry.data instanceof Uint8Array) {
      crc = crc32(crc, entry.data);
      written = entry.data.byteLength;
      yield entry.data;
    } else {
      const reader = entry.data().getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          crc = crc32(crc, value);
          written += value.byteLength;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (written !== entry.size) throw new Error(`zip entry ${entry.name} was ${written} bytes, expected ${entry.size}`);

    const descriptor = new Uint8Array(DATA_DESCRIPTOR);
    const trailer = new DataView(descriptor.buffer);
    trailer.setUint32(0, 0x0807_4b50, true);
    trailer.setUint32(4, crc, true);
    trailer.setUint32(8, written, true);
    trailer.setUint32(12, written, true);
    yield descriptor;

    const record = new Uint8Array(CENTRAL_HEADER + name.byteLength);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x0201_4b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, FLAGS, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, stamp.time, true);
    view.setUint16(14, stamp.date, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, written, true);
    view.setUint32(24, written, true);
    view.setUint16(28, name.byteLength, true);
    view.setUint32(42, offset, true);
    record.set(name, CENTRAL_HEADER);
    central.push(record);
    offset += local.byteLength + written + DATA_DESCRIPTOR;
  }

  const centralSize = central.reduce((total, record) => total + record.byteLength, 0);
  for (const record of central) yield record;

  const end = new Uint8Array(END_OF_CENTRAL_DIRECTORY);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x0605_4b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  yield end;
}
