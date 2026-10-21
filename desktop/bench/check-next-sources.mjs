// Check the implementation bytes captured by the compiler, not post-run hashes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
// The optional filename is only for negative-test fixtures; omit it for committed provenance.
const results = JSON.parse(readFileSync(process.argv[2] ?? resolve(directory, 'next-results.json'), 'utf8'));
for (const group of ['history_and_queue', 'reconciliation']) {
  const sources = results.source_snapshots?.[group];
  if (!sources || typeof sources !== 'object' || Array.isArray(sources) || !Object.keys(sources).length) {
    console.error(`Missing compile-time source fingerprints for ${group}.`);
    process.exit(1);
  }
}
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
if (!checked) { console.error('No source fingerprints were verified.'); process.exit(1); }
if (!process.exitCode) console.log(`Verified ${checked} compile-time source fingerprints.`);
