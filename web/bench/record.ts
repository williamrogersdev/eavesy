import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkersAiSegmentTranscriber } from '@/lib/transcription/provider/workers-ai';
import { BENCH, RATE, loadScenarios, readWav } from './common';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI read/run permission).');
  process.exit(1);
}

function restRunner(sink: { raw?: unknown }) {
  return {
    async run(model: string, input: unknown) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as { success?: boolean; result?: unknown; errors?: unknown };
      if (!response.ok || !body.success) throw new Error(`${model}: ${JSON.stringify(body.errors ?? body)}`);
      sink.raw = body.result;
      return body.result;
    },
  };
}

function activeMs(samples: Int16Array): number {
  const frame = Math.round(RATE * 0.03);
  let active = 0;
  for (let offset = 0; offset + frame <= samples.length; offset += frame) {
    let sum = 0;
    for (let i = offset; i < offset + frame; i += 1) sum += (samples[i] / 32768) ** 2;
    if (Math.sqrt(sum / frame) >= 0.01) active += 30;
  }
  return active;
}

const only = process.argv[2];
for (const scenario of loadScenarios().scenarios) {
  if (only && scenario.name !== only) continue;
  const out = join(BENCH, 'recorded', scenario.name);
  mkdirSync(out, { recursive: true });
  for (const track of ['mic', 'system'] as const) {
    const wav = readFileSync(join(BENCH, 'out', scenario.name, `${track}.wav`));
    const sink: { raw?: unknown } = {};
    await new WorkersAiSegmentTranscriber(restRunner(sink)).transcribe({
      audio: new Uint8Array(wav),
      language: 'en',
    });
    const recorded = { activeMs: activeMs(readWav(wav)), whisper: sink.raw };
    writeFileSync(join(out, `${track}.json`), `${JSON.stringify(recorded, null, 2)}\n`);
  }
  writeFileSync(
    join(out, 'truth.json'),
    readFileSync(join(BENCH, 'out', scenario.name, 'truth.json')),
  );
  console.log(`recorded ${scenario.name}`);
}
