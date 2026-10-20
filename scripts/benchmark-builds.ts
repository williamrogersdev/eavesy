import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Run from either checkout to compare its locked dependencies and source.
const root = process.cwd();
for (const project of ['web', 'desktop/launcher-ui']) {
  const cwd = path.join(root, project);
  const vite = JSON.parse(readFileSync(path.join(cwd, 'node_modules/vite/package.json'), 'utf8')).version;
  const samples: number[] = [];
  for (let iteration = 0; iteration < 4; iteration++) {
    const started = performance.now();
    const result = spawnSync('bun', ['run', 'build'], { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`${project} build failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    if (iteration > 0) samples.push((performance.now() - started) / 1000);
  }
  samples.sort((a, b) => a - b);
  console.log(`${project}: Vite ${vite}, median ${samples[1].toFixed(3)}s, range ${samples[0].toFixed(3)}–${samples[2].toFixed(3)}s`);
}
