// Check the implementation bytes captured by the compiler, not post-run hashes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
let resultsFile = resolve(directory, 'next-results.json');
const fixtureMode = process.argv.length > 2;
if (fixtureMode) {
  if (process.argv[2] !== '--test-fixture' || !process.argv[3] || process.argv.length !== 4) {
    console.error('Usage: check-next-sources.mjs [--test-fixture path]');
    process.exit(2);
  }
  resultsFile = process.argv[3];
  console.warn('TEST FIXTURE MODE: this does not verify the committed benchmark record.');
}
const results = JSON.parse(readFileSync(resultsFile, 'utf8'));
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
if (!process.exitCode) console.log(fixtureMode ? `Verified ${checked} TEST FIXTURE fingerprints.` : `Verified ${checked} compile-time source fingerprints.`);
