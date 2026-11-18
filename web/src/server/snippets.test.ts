import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import * as snippets from '@/db/repo/snippets';
import { snippetProblem, triggerKey } from '@/lib/snippets';
import { snippetsRequest } from './snippets';
import { createFakeEnv } from './testing/fake-env';

function setup() {
  const fake = createFakeEnv();
  fake.sqlite.run("INSERT INTO users (id, created_at, updated_at) VALUES ('u1', 1, 1), ('u2', 1, 1)");
  const db = drizzle(fake.env.DB, { schema });
  const request = async (method: string, body?: unknown, userId = 'u1') => {
    const response = await snippetsRequest(new Request('https://test/api/snippets', {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }), db, { userId, isAnonymous: false });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { ...fake, db, request };
}

describe('snippet rules', () => {
  test('a trigger is a spoken phrase of two or more words', () => {
    expect(triggerKey('  My   Email ')).toBe('my email');
    expect(triggerKey('my, email')).toBe('my email');
    expect(snippetProblem('email', 'a@b.co')).toContain('two words');
    expect(snippetProblem('12 34', 'x')).toContain('words you can say');
    expect(snippetProblem('my email', ' ')).toContain('text to insert');
    expect(snippetProblem('my email', 'a@b.co')).toBeNull();
  });
});

describe('snippets API', () => {
  test('adds, lists, edits and removes only the account’s own snippets', async () => {
    const t = setup();
    expect((await t.request('PUT', { trigger: 'My  email', text: 'me@example.com', field: 'email' })).status).toBe(200);
    const listed = (await t.request('GET')).body.snippets as { id: string; trigger: string; field: string }[];
    expect(listed).toMatchObject([{ trigger: 'My email', text: 'me@example.com', field: 'email' }]);
    expect(((await t.request('GET', undefined, 'u2')).body.snippets as unknown[])).toHaveLength(0);
    await t.request('PUT', { id: listed[0].id, trigger: 'my work email', text: 'me@work.com', field: 'email' });
    expect(await snippets.list(t.db, 'u1')).toMatchObject([{ trigger: 'my work email', triggerKey: 'my work email', text: 'me@work.com' }]);
    await t.request('DELETE', { id: listed[0].id }, 'u2');
    expect(await snippets.list(t.db, 'u1')).toHaveLength(1);
    await t.request('DELETE', { id: listed[0].id });
    expect(await snippets.list(t.db, 'u1')).toHaveLength(0);
  });

  test('a phrase belongs to one snippet, and a field to one snippet', async () => {
    const t = setup();
    await t.request('PUT', { trigger: 'my email', text: 'a@example.com', field: 'email' });
    const taken = await t.request('PUT', { trigger: 'MY EMAIL', text: 'b@example.com' });
    expect(taken.status).toBe(409);
    expect((await t.request('PUT', { trigger: 'my, email', text: 'b@example.com' })).status).toBe(409);
    await t.request('PUT', { trigger: 'my other email', text: 'b@example.com', field: 'email' });
    const rows = await snippets.list(t.db, 'u1');
    expect(rows.find((row) => row.trigger === 'my email')?.field).toBeNull();
    expect(rows.find((row) => row.trigger === 'my other email')?.field).toBe('email');
  });

  test('a refused snippet takes no field tag away, and the list has a cap', async () => {
    const t = setup();
    await t.request('PUT', { trigger: 'my email', text: 'a@example.com', field: 'email' });
    for (let i = 1; i < 200; i++) t.sqlite.run(`INSERT INTO snippets (id, user_id, trigger_key, trigger, text, created_at, updated_at) VALUES ('s${i}', 'u1', 'say ${i}', 'say ${i}', 'x', 1, 1)`);
    const full = await t.request('PUT', { trigger: 'one more', text: 'b@example.com', field: 'email' });
    expect(full.status).toBe(400);
    expect(full.body.error).toBe('full');
    expect((await snippets.list(t.db, 'u1')).find((row) => row.trigger === 'my email')?.field).toBe('email');
  });

  test('rejects bad bodies, unknown fields and single-word triggers', async () => {
    const t = setup();
    expect((await t.request('PUT', { trigger: 'email', text: 'x' })).status).toBe(400);
    expect((await t.request('PUT', { trigger: 'my email', text: 'x', field: 'password' })).status).toBe(400);
    expect((await t.request('PUT', { nope: true })).status).toBe(400);
    expect((await t.request('PUT', { id: 'missing', trigger: 'my email', text: 'x' })).status).toBe(404);
    expect(await snippets.list(t.db, 'u1')).toHaveLength(0);
  });
});
