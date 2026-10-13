import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RATE, readWav, writeWav, type Scenario, type TruthLine, loadScenarios } from './common';

const OUT = join(import.meta.dir, 'out');

function speak(voice: string, text: string): Int16Array {
  const dir = mkdtempSync(join(tmpdir(), 'eavesy-bench-'));
  const file = join(dir, 'line.wav');
  try {
    execFileSync('say', ['-v', voice, '-o', file, `--data-format=LEI16@${RATE}`, text]);
    return readWav(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function noise(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff - 0.5;
  };
}

function render(scenario: Scenario, voices: Record<string, string>) {
  const clips: { line: TruthLine; samples: Int16Array }[] = [];
  let cursor = 0;
  for (const line of scenario.lines) {
    const samples = speak(voices[line.speaker], line.text);
    const startMs = Math.max(0, cursor + line.gapMs);
    const endMs = startMs + Math.round((samples.length / RATE) * 1000);
    clips.push({
      line: {
        speaker: line.speaker,
        side: line.speaker === 'you' ? 'you' : 'them',
        startMs,
        endMs,
        text: line.text,
      },
      samples,
    });
    cursor = Math.max(cursor, endMs);
  }
  const totalMs = Math.max(scenario.durationMs ?? 0, cursor + 1_500);
  const length = Math.ceil((totalMs / 1000) * RATE);
  const mic = new Float32Array(length);
  const system = new Float32Array(length);
  for (const { line, samples } of clips) {
    const target = line.side === 'you' ? mic : system;
    const offset = Math.round((line.startMs / 1000) * RATE);
    for (let i = 0; i < samples.length && offset + i < length; i += 1) {
      target[offset + i] += samples[i] / 32768;
    }
  }
  if (scenario.echo) {
    const delay = Math.round(((scenario.echoDelayMs ?? 40) / 1000) * RATE);
    for (let i = delay; i < length; i += 1) mic[i] += system[i - delay] * scenario.echo;
  }
  const hiss = noise(scenario.name.length * 7_919);
  const level = scenario.noise ?? 0.002;
  for (let i = 0; i < length; i += 1) mic[i] += hiss() * level;
  return { mic, system, truth: clips.map((clip) => clip.line), totalMs };
}

const { voices, scenarios } = loadScenarios();
for (const scenario of scenarios) {
  const dir = join(OUT, scenario.name);
  mkdirSync(dir, { recursive: true });
  const { mic, system, truth, totalMs } = render(scenario, voices);
  writeFileSync(join(dir, 'mic.wav'), writeWav(mic));
  writeFileSync(join(dir, 'system.wav'), writeWav(system));
  writeFileSync(join(dir, 'truth.json'), `${JSON.stringify({ totalMs, lines: truth }, null, 2)}\n`);
  console.log(`${scenario.name}: ${truth.length} lines, ${(totalMs / 1000).toFixed(1)} s`);
}
