import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../web', import.meta.url));
const commands = ['lint:eslint', 'lint:oxlint'] as const;
function run(command: string) {
  const started = performance.now();
  const result = spawnSync('bun', ['run', command], { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return (performance.now() - started) / 1000;
}

// No cache flags: compare complete successful commands, including the ESLint
// residual pass. Validate coverage and negative probes before any timing.
run('lint:parity');
for (const command of commands) run(command);
const samples = { 'lint:eslint': [] as number[], 'lint:oxlint': [] as number[] };
for (let round = 0; round < 5; round++) {
  for (const command of round % 2 ? [...commands].reverse() : commands) samples[command].push(run(command));
}
for (const command of commands) {
  samples[command].sort((a, b) => a - b);
  console.log(`${command}: median ${samples[command][2].toFixed(3)}s; range ${samples[command][0].toFixed(3)}–${samples[command][4].toFixed(3)}s`);
}
console.log(`Combined-command speedup: ${(samples['lint:eslint'][2] / samples['lint:oxlint'][2]).toFixed(2)}x`);
