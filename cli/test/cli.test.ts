import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    readStdin: async () => '',
    env: { EAVESY_RECORDINGS: FIXTURE, HOME: '/nonexistent' },
    credential: () => null,
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

  test('drop - reads stdin and saves locally when signed out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eavesy-cli-'));
    const res = await cli(['drop', '-', '--root', root, '--title', 'From Claude', '--json'], { readStdin: async () => 'agent note' });
    expect(res.code).toBe(0);
    const result = JSON.parse(res.out);
    expect(result.via).toBe('local');
    expect(readFileSync(join(result.folder, 'note.md'), 'utf8')).toBe('agent note');
    expect(result.folder).toContain('From Claude');
  });

  test('drop - on a terminal explains instead of waiting', async () => {
    const res = await cli(['drop', '-'], { stdinIsTTY: true, readStdin: () => new Promise(() => {}) });
    expect(res.code).toBe(2);
    expect(res.err).toContain('pbpaste | eavesy drop -');
  });

  test('usage errors exit 2; help and version exit 0', async () => {
    expect((await cli(['frobnicate'])).code).toBe(2);
    expect((await cli(['recent', '--kind', 'podcast'])).code).toBe(2);
    expect((await cli(['recent', '--limit', '0'])).code).toBe(2);
    expect((await cli(['search'])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
    expect(await cli(['--help'])).toMatchObject({ code: 0 });
    expect((await cli(['-v'])).out.trim()).toBe(VERSION);
  });

  test('version matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(pkg.version).toBe(VERSION);
  });
});
