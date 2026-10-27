#!/usr/bin/env node
// Entry for the Node bundle (`bun run build` → dist/eavesy.js).
import { run } from './main';

run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
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
