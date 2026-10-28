import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SEGMENT_MS } from '@/lib/audio/session-upload';
import { WorkersAiSegmentTranscriber } from '@/lib/transcription/provider/workers-ai';
import { isHallucination } from '@/lib/transcription/two-track';
import { vocabularyFromText } from '@/lib/transcription/vocabulary';
import { BENCH, RATE, readWav, writeWav, type TruthLine } from '../common';
import { NEMOTRON_MODEL, nemotronRequest, nemotronTurns } from './nemotron';
import { cpErrors, parseReference, wordErrors, words, type Turn, type WordErrors } from './score';

const OUT = join(BENCH, 'out', 'engines');
const NEMOTRON_MAX_MS = 60 * 60 * 1000;

const { values: args } = parseArgs({
  options: {
    engines: { type: 'string', default: 'whisper,nemotron' },
    cases: { type: 'string' },
    only: { type: 'string' },
    language: { type: 'string', default: 'en' },
    replay: { type: 'boolean', default: false },
  },
});

interface Case {
  name: string;
  samples: Int16Array;
  reference: Turn[];
  terms: string[];
}

interface Saved {
  ms: number;
  responses: unknown[];
}

interface Engine {
  name: string;
  ready(): string | null;
  run(c: Case, call: (send: () => Promise<unknown>) => Promise<unknown>): Promise<Turn[]>;
}

const floats = (samples: Int16Array) => Float32Array.from(samples, (s) => s / 32768);

function mix(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-32768, Math.min(32767, (a[i] ?? 0) + (b[i] ?? 0)));
  return out;
}

/** The two-track bench's scripted calls, mic and computer audio mixed into one recording. */
function scriptedCases(): Case[] {
  const dir = join(BENCH, 'out');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'truth.json')))
    .map((name) => {
      const truth = JSON.parse(readFileSync(join(dir, name, 'truth.json'), 'utf8')) as { lines: TruthLine[] };
      const track = (file: string) => readWav(readFileSync(join(dir, name, file)));
      return {
        name,
        samples: mix(track('mic.wav'), track('system.wav')),
        reference: [...truth.lines].sort((a, b) => a.startMs - b.startMs).map((line) => ({ speaker: line.speaker, text: line.text })),
        terms: [],
      };
    });
}

function toWav16k(input: string): Int16Array {
  const dir = mkdtempSync(join(tmpdir(), 'eavesy-engines-'));
  const out = join(dir, 'audio.wav');
  try {
    try {
      execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', input, out], { stdio: 'ignore' });
    } catch {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', String(RATE), '-sample_fmt', 's16', out]);
    }
    return readWav(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One folder per recording: `audio.*`, `reference.txt`, and optionally `terms.txt`. */
function folderCases(root: string): Case[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(root, entry.name);
      const audio = readdirSync(dir).find((file) => /^audio\.\w+$/.test(file));
      if (!audio || !existsSync(join(dir, 'reference.txt'))) {
        console.warn(`skipping ${entry.name}: needs audio.* and reference.txt`);
        return [];
      }
      const terms = existsSync(join(dir, 'terms.txt')) ? vocabularyFromText(readFileSync(join(dir, 'terms.txt'), 'utf8')) : [];
      return [{ name: entry.name, samples: toWav16k(join(dir, audio)), reference: parseReference(readFileSync(join(dir, 'reference.txt'), 'utf8')), terms }];
    });
}

const whisper: Engine = {
  name: 'whisper',
  ready: () => (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN ? null : 'run through ../scripts/cf for CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN'),
  async run(c, call) {
    const transcriber = new WorkersAiSegmentTranscriber({
      run: (model, input) =>
        call(async () => {
          const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify(input),
          });
          const body = (await response.json()) as { success?: boolean; result?: unknown; errors?: unknown };
          if (!response.ok || !body.success) throw new Error(`${model}: ${JSON.stringify(body.errors ?? body)}`);
          return body.result;
        }),
    });
    const step = Math.round((SEGMENT_MS / 1000) * RATE);
    const turns: Turn[] = [];
    for (let at = 0; at < c.samples.length; at += step) {
      const wav = writeWav(floats(c.samples.subarray(at, at + step)));
      const result = await transcriber.transcribe({ audio: new Uint8Array(wav), language: args.language, vocabulary: c.terms });
      for (const segment of result.segments) {
        if (!isHallucination(segment, { glossary: c.terms })) turns.push({ speaker: null, text: segment.text });
      }
    }
    return turns;
  },
};

const nemotron: Engine = {
  name: 'nemotron',
  ready: () => (process.env.NEMOTRON_BASE_URL ? null : 'set NEMOTRON_BASE_URL to an OpenAI-compatible server (and NEMOTRON_API_KEY if it needs one)'),
  async run(c, call) {
    if ((c.samples.length / RATE) * 1000 > NEMOTRON_MAX_MS) throw new Error('longer than the model’s one-hour limit');
    const response = await call(async () => {
      const key = process.env.NEMOTRON_API_KEY;
      const response = await fetch(`${process.env.NEMOTRON_BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(nemotronRequest(new Uint8Array(writeWav(floats(c.samples))), { model: process.env.NEMOTRON_MODEL ?? NEMOTRON_MODEL, terms: c.terms })),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`nemotron ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
      return body;
    });
    return nemotronTurns(response);
  },
};

interface Row {
  case: string;
  engine: string;
  seconds: number;
  ms: number;
  wer: WordErrors;
  cp?: ReturnType<typeof cpErrors>;
  error?: string;
}

async function measure(engine: Engine, c: Case): Promise<Row> {
  const file = join(OUT, c.name, `${engine.name}.json`);
  const base = { case: c.name, engine: engine.name, seconds: c.samples.length / RATE };
  let saved: Saved;
  let turns: Turn[];
  try {
    if (args.replay) {
      if (!existsSync(file)) throw new Error('nothing recorded yet');
      saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
      const queue = [...saved.responses];
      turns = await engine.run(c, async () => queue.shift());
    } else {
      saved = { ms: 0, responses: [] };
      turns = await engine.run(c, async (send) => {
        const started = performance.now();
        const response = await send();
        saved.ms += performance.now() - started;
        saved.responses.push(response);
        return response;
      });
      mkdirSync(join(OUT, c.name), { recursive: true });
      writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
    }
  } catch (error) {
    return { ...base, ms: 0, wer: wordErrors([], []), error: error instanceof Error ? error.message : String(error) };
  }
  const ref = c.reference.flatMap((turn) => words(turn.text));
  const hyp = turns.flatMap((turn) => words(turn.text));
  const labelled = c.reference.some((turn) => turn.speaker) && turns.some((turn) => turn.speaker);
  return { ...base, ms: saved.ms, wer: wordErrors(ref, hyp), ...(labelled ? { cp: cpErrors(c.reference, turns) } : {}) };
}

const pct = (e: { errors: number; refWords: number }) => (e.refWords ? `${((e.errors / e.refWords) * 100).toFixed(1)}%` : '—');

function report(rows: Row[]): string {
  const lines = [
    '| Recording | Length | Engine | WER | Sub / Del / Ins | Speaker WER (cpWER) | Speakers found | Speed |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    if (row.error) {
      lines.push(`| ${row.case} | ${row.seconds.toFixed(0)} s | ${row.engine} | failed: ${row.error.replace(/\|/g, '/')} | | | | |`);
      continue;
    }
    const wer = row.wer.refWords ? pct(row.wer) : `${row.wer.hypWords} words on silence`;
    const speed = row.ms ? `${(row.seconds / (row.ms / 1000)).toFixed(0)}× real time` : '—';
    lines.push(
      `| ${row.case} | ${row.seconds.toFixed(0)} s | ${row.engine} | ${wer} | ${row.wer.substitutions} / ${row.wer.deletions} / ${row.wer.insertions} | ${row.cp ? pct(row.cp) : '—'} | ${row.cp ? `${row.cp.hypSpeakers} of ${row.cp.refSpeakers}` : '—'} | ${speed} |`,
    );
  }
  lines.push('', '| Engine | Recordings | Pooled WER | Pooled cpWER |', '|---|---|---|---|');
  for (const engine of [...new Set(rows.map((row) => row.engine))]) {
    const done = rows.filter((row) => row.engine === engine && !row.error);
    const sum = (pick: (row: Row) => { errors: number; refWords: number } | undefined) =>
      done.reduce((total, row) => {
        const e = pick(row);
        return e ? { errors: total.errors + e.errors, refWords: total.refWords + e.refWords } : total;
      }, { errors: 0, refWords: 0 });
    lines.push(`| ${engine} | ${done.length} | ${pct(sum((row) => row.wer))} | ${pct(sum((row) => row.cp))} |`);
  }
  return `${lines.join('\n')}\n`;
}

const engines = [whisper, nemotron].filter((engine) => args.engines.split(',').includes(engine.name));
const active = engines.filter((engine) => {
  const missing = args.replay ? null : engine.ready();
  if (missing) console.warn(`skipping ${engine.name}: ${missing}`);
  return !missing;
});
const cases = [...scriptedCases(), ...(args.cases ? folderCases(resolve(args.cases)) : [])].filter((c) => !args.only || c.name === args.only);
if (cases.length === 0) {
  console.error('No recordings. Run `bun bench/generate.ts` for the scripted calls, or pass --cases <folder>.');
  process.exit(1);
}
if (active.length === 0) process.exit(1);

const rows: Row[] = [];
for (const c of cases) {
  for (const engine of active) {
    const row = await measure(engine, c);
    console.log(`${c.name} / ${engine.name}: ${row.error ?? pct(row.wer)}`);
    rows.push(row);
  }
}
const markdown = report(rows);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'report.md'), markdown);
console.log(`\n${markdown}\nSaved responses and report.md in ${OUT}`);
