import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'bun:test';
import type { MessageBatch } from '@cloudflare/workers-types';
import type { ProcessingMessage } from '@/server/processing-worker';
import { createFakeEnv, delivery } from '@/server/testing/fake-env';

mock.module('cloudflare:workers', () => ({ env: {}, waitUntil: () => undefined }));
const { queue } = await import('@/server/processing-worker');
import { BENCH, type TruthLine } from './common';

const NEAR_MS = 1_500;

interface Recorded {
  activeMs: number;
  whisper: unknown;
}
interface Line {
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

async function transcribe(dir: string): Promise<Line[]> {
  const recorded = {
    mic: JSON.parse(readFileSync(join(dir, 'mic.json'), 'utf8')) as Recorded,
    system: JSON.parse(readFileSync(join(dir, 'system.json'), 'utf8')) as Recorded,
  };
  const fake = createFakeEnv({ transcribe: (audio) => (audio[0] === 1 ? recorded.mic : recorded.system).whisper });
  const now = Date.now();
  fake.sqlite.run(`INSERT INTO users (id, created_at, updated_at) VALUES ('u', ?, ?)`, [now, now]);
  fake.sqlite.run(
    `INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at)
     VALUES ('m', 'u', 'bench', ?, 'desktop', 'processing', ?, ?)`,
    [now, now, now],
  );
  for (const [track, marker] of [['mic', 1], ['system', 2]] as const) {
    fake.sqlite.run(
      `INSERT INTO meeting_segments (id, meeting_id, idx, track, active_ms, r2_key, bytes, offset_ms, duration_ms, created_at)
       VALUES (?, 'm', 0, ?, ?, ?, 1, 0, 600000, ?)`,
      [track, track, recorded[track].activeMs, track, now],
    );
    fake.objects.set(track, new Uint8Array([marker]));
  }
  for (const track of ['mic', 'system'] as const) {
    const d = delivery({ kind: 'transcribe-segment', meetingId: 'm', idx: 0, track });
    await queue({ messages: [d.message] } as unknown as MessageBatch<ProcessingMessage>, fake.env);
    if (!d.outcome.acked) throw new Error(`transcribe ${track} did not complete`);
  }
  return fake.sqlite
    .query('SELECT speaker_id speaker, start_ms startMs, end_ms endMs, text FROM transcript_segments ORDER BY start_ms')
    .all() as Line[];
}

function score(truth: TruthLine[], lines: Line[]) {
  let total = 0;
  let found = 0;
  let rightSide = 0;
  for (const scripted of truth) {
    const near = lines.filter(
      (line) => line.startMs <= scripted.endMs + NEAR_MS && line.endMs >= scripted.startMs - NEAR_MS,
    );
    for (const word of words(scripted.text)) {
      total += 1;
      const hits = near.filter((line) => words(line.text).includes(word));
      if (hits.length === 0) continue;
      found += 1;
      if (hits.some((line) => line.speaker === scripted.side)) rightSide += 1;
    }
  }
  const theirWords = new Set(truth.filter((t) => t.side === 'them').flatMap((t) => words(t.text)));
  const myWords = new Set(truth.filter((t) => t.side === 'you').flatMap((t) => words(t.text)));
  const leaked = lines.filter((line) => {
    if (line.speaker !== 'you') return false;
    const tokens = words(line.text);
    const theirs = tokens.filter((w) => theirWords.has(w) && !myWords.has(w)).length;
    return tokens.length > 0 && theirs * 2 > tokens.length;
  }).length;
  return {
    found: total ? found / total : 1,
    side: found ? rightSide / found : 1,
    leaked,
    lines: lines.length,
  };
}

const recordedDir = join(BENCH, 'recorded');
const scenarios = existsSync(recordedDir) ? readdirSync(recordedDir).sort() : [];
if (scenarios.length === 0) {
  console.log('No recordings in bench/recorded yet. Run bench/generate.ts, then bench/record.ts.');
  process.exit(0);
}
const thresholds = JSON.parse(readFileSync(join(BENCH, 'thresholds.json'), 'utf8')) as Record<
  string,
  Partial<Record<'found' | 'side', number>> & { leaked?: number; lines?: number }
>;
let failed = false;
console.log('scenario         found   side  leaked  lines');
for (const name of scenarios) {
  const { lines: truth } = JSON.parse(readFileSync(join(recordedDir, name, 'truth.json'), 'utf8')) as {
    lines: TruthLine[];
  };
  const result = score(truth, await transcribe(join(recordedDir, name)));
  const limits = thresholds[name] ?? thresholds.default;
  const misses: string[] = [];
  if (limits.found !== undefined && result.found < limits.found) misses.push(`found < ${limits.found}`);
  if (limits.side !== undefined && result.side < limits.side) misses.push(`side < ${limits.side}`);
  if (limits.leaked !== undefined && result.leaked > limits.leaked) misses.push(`leaked > ${limits.leaked}`);
  if (limits.lines !== undefined && result.lines > limits.lines) misses.push(`lines > ${limits.lines}`);
  failed ||= misses.length > 0;
  console.log(
    `${name.padEnd(16)} ${result.found.toFixed(2).padStart(5)}  ${result.side.toFixed(2).padStart(5)}  ${String(result.leaked).padStart(6)}  ${String(result.lines).padStart(5)}${misses.length ? `   FAIL: ${misses.join(', ')}` : ''}`,
  );
}
if (failed && process.argv.includes('--check')) process.exit(1);
