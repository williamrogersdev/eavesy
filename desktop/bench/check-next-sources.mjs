// Check the implementation bytes captured by the compiler, not post-run hashes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const results = JSON.parse(readFileSync(resolve(directory, 'next-results.json'), 'utf8'));
let checked = 0;
for (const [run, sources] of Object.entries(results.source_snapshots)) {
  for (const [path, expected] of Object.entries(sources)) {
    const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
    if (actual !== expected) {
      console.error(`Source drift since ${run} measurement: ${path}`);
      process.exitCode = 1;
    }
    checked++;
  }
}
if (!process.exitCode) console.log(`Verified ${checked} compile-time source fingerprints.`);
