import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Run from either checkout to compare its locked dependencies and source.
const root = process.cwd();
const timedRuns = 3;
if (!['web/package.json', 'desktop/launcher-ui/package.json'].every((file) => existsSync(path.join(root, file)))) throw new Error('Run this benchmark from an Eavesy repository root with both frontend packages installed.');
for (const project of ['web', 'desktop/launcher-ui']) {
  const cwd = path.join(root, project);
  const vite = JSON.parse(readFileSync(path.join(cwd, 'node_modules/vite/package.json'), 'utf8')).version;
  const samples: number[] = [];
  for (let iteration = 0; iteration <= timedRuns; iteration++) {
    const started = performance.now();
    const result = spawnSync('bun', ['run', 'build'], { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`${project} build failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    if (iteration > 0) samples.push((performance.now() - started) / 1000);
  }
  samples.sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
  console.log(`${project}: Vite ${vite}, median ${median.toFixed(3)}s, range ${samples[0].toFixed(3)}–${samples[samples.length - 1].toFixed(3)}s`);
}
