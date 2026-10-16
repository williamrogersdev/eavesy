#!/usr/bin/env node
// Entry for both the npm package (bundled for Node) and the binary the Mac app
// ships (`bun build --compile`).
import { run } from './main';

/** Same cap as a drop upload. */
const MAX_STDIN_BYTES = 100 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += (chunk as Buffer).byteLength;
    if (total > MAX_STDIN_BYTES) throw new Error('stdin is larger than 100 MB');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  readStdin,
  stdinIsTTY: process.stdin.isTTY === true,
  env: process.env,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`eavesy: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
