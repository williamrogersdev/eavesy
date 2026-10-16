#!/usr/bin/env node
// Entry for both the npm package (bundled for Node) and the binary the Mac app
// ships (`bun build --compile`).
import { run } from './main';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  readStdin,
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
