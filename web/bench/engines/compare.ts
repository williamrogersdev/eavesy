import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const WHISPER_TIMEOUT_MS = 2 * 60 * 1000;

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
  /** What the responses were recorded from, so a replay of different input fails. */
  input: string;
  ms: number;
  responses: unknown[];
}

interface Engine {
  name: string;
  /** Whether it labels speakers on one track, so its speaker WER means something. */
  speakers: boolean;
  ready(): string | null;
  run(c: Case, call: (send: () => Promise<unknown>) => Promise<unknown>): Promise<Turn[]>;
}

const floats = (samples: Int16Array) => Float32Array.from(samples, (s) => s / 32768);

/** Both tracks summed, scaled down only if the sum would clip. */
function mix(a: Int16Array, b: Int16Array): Int16Array {
  const sum = new Int32Array(Math.max(a.length, b.length));
  let peak = 1;
  for (let i = 0; i < sum.length; i += 1) {
    sum[i] = (a[i] ?? 0) + (b[i] ?? 0);
    peak = Math.max(peak, Math.abs(sum[i]));
  }
  const scale = Math.min(1, 32767 / peak);
  return Int16Array.from(sum, (s) => Math.round(s * scale));
}

/** The two-track bench's scripted calls, mic and computer audio mixed into one recording. */
function scriptedCases(): Case[] {
  const dir = join(BENCH, 'out');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'truth.json')))
    .flatMap((name) => {
      try {
        const truth = JSON.parse(readFileSync(join(dir, name, 'truth.json'), 'utf8')) as { lines: TruthLine[] };
        const [mic, system] = ['mic.wav', 'system.wav'].map((file) => readWav(readFileSync(join(dir, name, file))));
        return [{
          name,
          samples: mix(mic, system),
          reference: [...truth.lines].sort((a, b) => a.startMs - b.startMs).map((line) => ({ speaker: line.speaker, text: line.text })),
          terms: [],
        }];
      } catch (error) {
        console.warn(`skipping ${name}: ${error instanceof Error ? error.message : String(error)} (run bun bench/generate.ts again)`);
        return [];
      }
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
      try {
        const terms = existsSync(join(dir, 'terms.txt')) ? vocabularyFromText(readFileSync(join(dir, 'terms.txt'), 'utf8')) : [];
        return [{ name: entry.name, samples: toWav16k(join(dir, audio)), reference: parseReference(readFileSync(join(dir, 'reference.txt'), 'utf8')), terms }];
      } catch (error) {
        console.warn(`skipping ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
}

const whisper: Engine = {
  name: 'whisper',
  speakers: false,
  ready: () => (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN ? null : 'run through ../scripts/cf for CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN'),
  async run(c, call) {
    const transcriber = new WorkersAiSegmentTranscriber({
      run: (model, input) =>
        call(async () => {
          const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
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

/** The server's chat completions URL; an API key only ever goes over https, or to this machine. */
function nemotronUrl(): string {
  const base = process.env.NEMOTRON_BASE_URL;
  if (!base) throw new Error('NEMOTRON_BASE_URL is not set');
  const url = new URL(`${base.replace(/\/$/, '')}/chat/completions`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (process.env.NEMOTRON_API_KEY && url.protocol !== 'https:' && !local) {
    throw new Error(`NEMOTRON_BASE_URL must be https to send NEMOTRON_API_KEY (got ${url.origin})`);
  }
  return url.href;
}

const nemotron: Engine = {
  name: 'nemotron',
  speakers: true,
  ready: () => {
    if (!process.env.NEMOTRON_BASE_URL) return 'set NEMOTRON_BASE_URL to an OpenAI-compatible server (and NEMOTRON_API_KEY if it needs one)';
    try {
      nemotronUrl();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
  async run(c, call) {
    const audioMs = (c.samples.length / RATE) * 1000;
    if (audioMs > NEMOTRON_MAX_MS) throw new Error('longer than the model’s one-hour limit');
    const response = await call(async () => {
      const wav = new Uint8Array(writeWav(floats(c.samples)));
      const key = process.env.NEMOTRON_API_KEY;
      const response = await fetch(nemotronUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(nemotronRequest(wav, { model: process.env.NEMOTRON_MODEL ?? NEMOTRON_MODEL, terms: c.terms })),
        signal: AbortSignal.timeout(5 * 60 * 1000 + audioMs),
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

/** The audio and every setting that changes what an engine is sent. */
function inputIdentity(engine: Engine, c: Case): string {
  const hash = createHash('sha256').update(new Uint8Array(c.samples.buffer, c.samples.byteOffset, c.samples.byteLength));
  const settings =
    engine === whisper
      ? { language: args.language, terms: c.terms, segmentMs: SEGMENT_MS }
      : { model: process.env.NEMOTRON_MODEL ?? NEMOTRON_MODEL, terms: c.terms };
  return hash.update(JSON.stringify(settings)).digest('hex');
}

async function measure(engine: Engine, c: Case): Promise<Row> {
  const file = join(OUT, c.name, `${engine.name}.json`);
  const base = { case: c.name, engine: engine.name, seconds: c.samples.length / RATE };
  const input = inputIdentity(engine, c);
  let saved: Saved = { input, ms: 0, responses: [] };
  try {
    let turns: Turn[];
    if (args.replay) {
      if (!existsSync(file)) throw new Error('nothing recorded yet');
      saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
      const stale = `${file} was recorded from different audio or settings; record it again`;
      if (saved.input !== input) throw new Error(stale);
      const queue = [...saved.responses];
      turns = await engine.run(c, async () => {
        if (queue.length === 0) throw new Error(stale);
        return queue.shift();
      });
      if (queue.length > 0) throw new Error(stale);
    } else {
      mkdirSync(join(OUT, c.name), { recursive: true });
      // Every paid call is saved as it lands, beside the last complete recording,
      // which is only replaced once this one finishes.
      const partial = `${file}.partial`;
      turns = await engine.run(c, async (send) => {
        const started = performance.now();
        const response = await send();
        saved.ms += performance.now() - started;
        saved.responses.push(response);
        writeFileSync(partial, `${JSON.stringify(saved, null, 2)}\n`);
        return response;
      });
      renameSync(partial, file);
    }
    const ref = c.reference.flatMap((turn) => words(turn.text));
    const hyp = turns.flatMap((turn) => words(turn.text));
    const labelled = engine.speakers && c.reference.some((turn) => turn.speaker);
    return { ...base, ms: saved.ms, wer: wordErrors(ref, hyp), ...(labelled ? { cp: cpErrors(c.reference, turns) } : {}) };
  } catch (error) {
    return { ...base, ms: saved.ms, wer: wordErrors([], []), error: error instanceof Error ? error.message : String(error) };
  }
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

const known = [whisper, nemotron];
const asked = args.engines.split(',').map((name) => name.trim()).filter(Boolean);
const unknown = asked.filter((name) => !known.some((engine) => engine.name === name));
if (unknown.length) {
  console.error(`Unknown engine ${unknown.join(', ')}; choose from ${known.map((engine) => engine.name).join(', ')}.`);
  process.exit(1);
}
const active = known.filter((engine) => {
  if (!asked.includes(engine.name)) return false;
  const missing = args.replay ? null : engine.ready();
  if (missing) console.warn(`skipping ${engine.name}: ${missing}`);
  return !missing;
});
const cases = [...scriptedCases(), ...(args.cases ? folderCases(resolve(args.cases)) : [])].filter((c) => !args.only || c.name === args.only);
const repeated = cases.map((c) => c.name).filter((name, i, names) => names.indexOf(name) !== i);
if (repeated.length) {
  console.error(`Two recordings are named ${[...new Set(repeated)].join(', ')}; rename one so their saved responses stay apart.`);
  process.exit(1);
}
if (cases.length === 0) {
  console.error('No recordings. Run `bun bench/generate.ts` for the scripted calls, or pass --cases <folder>.');
  process.exit(1);
}
if (active.length === 0) {
  console.error('No engine can run.');
  process.exit(1);
}

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
