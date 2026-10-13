import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RATE = 16_000;
export const BENCH = import.meta.dir;

export interface ScriptLine {
  speaker: string;
  gapMs: number;
  text: string;
}

export interface Scenario {
  name: string;
  echo: number;
  echoDelayMs?: number;
  noise?: number;
  durationMs?: number;
  lines: ScriptLine[];
}

export interface TruthLine {
  speaker: string;
  side: 'you' | 'them';
  startMs: number;
  endMs: number;
  text: string;
}

export function loadScenarios(): { voices: Record<string, string>; scenarios: Scenario[] } {
  return JSON.parse(readFileSync(join(BENCH, 'scenarios.json'), 'utf8'));
}

export function readWav(bytes: Buffer): Int16Array {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      const data = bytes.subarray(offset + 8, offset + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in WAV');
}

export function writeWav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clipped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
