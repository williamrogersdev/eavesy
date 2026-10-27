import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type Io } from '../src/main';
import { VERSION } from '../src/version';

const FIXTURE = join(import.meta.dir, 'fixtures', 'Recordings');

async function cli(argv: string[], extra: Partial<Io> = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    out: (t) => (out += t),
    err: (t) => (err += t),
    env: { EAVESY_RECORDINGS: FIXTURE, HOME: '/nonexistent' },
    ...extra,
  });
  return { code, out, err };
}

describe('eavesy', () => {
  test('recent lists newest first, --kind filters', async () => {
    const all = await cli(['recent']);
    expect(all.code).toBe(0);
    expect(all.out.trim().split('\n')).toHaveLength(5);
    const notes = await cli(['recent', '--kind', 'note', '--json']);
    expect(JSON.parse(notes.out).map((c: { kind: string }) => c.kind)).toEqual(['note']);
  });

  test('search prints a snippet; no match is not an error', async () => {
    const hit = await cli(['search', 'webhook', 'secret']);
    expect(hit.out).toContain('Rotate the staging webhook secret');
    const miss = await cli(['search', 'zzz']);
    expect(miss).toMatchObject({ code: 0, out: '' });
    expect(miss.err).toContain('No captures match');
  });

  test('get prints the files; a missing id exits 1', async () => {
    const got = await cli(['get', 'meeting-design-review', `--root=${FIXTURE}`]);
    expect(got.out).toContain('# Design review');
    expect(got.out).toContain('--- transcript.md ---');
    expect(got.out).toContain('audio.m4a');
    expect((await cli(['get', 'nope'])).code).toBe(1);
  });

  test('drop is not a command: the CLI is read-only', async () => {
    expect((await cli(['drop', '-'])).code).toBe(2);
  });

  test('usage errors exit 2; help and version exit 0', async () => {
    expect((await cli(['frobnicate'])).code).toBe(2);
    expect((await cli(['recent', '--kind', 'podcast'])).code).toBe(2);
    expect((await cli(['recent', '--limit', '0'])).code).toBe(2);
    expect((await cli(['search'])).code).toBe(2);
    expect((await cli(['recent', '--kidn', 'note'])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
    expect(await cli(['--help'])).toMatchObject({ code: 0 });
    expect((await cli(['-v'])).out.trim()).toBe(VERSION);
  });

  test('version matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(pkg.version).toBe(VERSION);
  });
});
