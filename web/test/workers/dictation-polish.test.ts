import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from '../../src/routes/api/dictations/polish';
import { handler, insertUser, resetTables, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));

const USER = 'user_polish';
const PROJECT = 'proj_polish';

type Answer = { text: string; polished: boolean; written?: { style: string; forAgents: boolean; projectId: string | null; applied: boolean } };

async function polish(body: unknown) {
  const request = new Request('https://eavesy.test/api/dictations/polish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handler(Route, 'POST')({ request, params: {} });
  return { status: response.status, body: await response.json<Answer>() };
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM rate_limits').run().catch(() => undefined);
  await resetTables('folders', 'users');
  await insertUser(USER);
  await testEnv.DB.prepare(`UPDATE users SET dictation_style = 'professional', dictation_for_agents = 1 WHERE id = ?`).bind(USER).run();
  actor.userId = USER;
});

/**
 * The reply's `written` is what the Mac app's tone row shows: the tone in
 * force for the words, and whether the model applied it. A dictation too
 * short for the model goes out plain, so `applied` is false while the tone
 * is still the saved one.
 */
describe('/api/dictations/polish written', () => {
  it('reports the saved tone as not applied when the words went out plain', async () => {
    const { status, body } = await polish({ text: 'um ship it' });
    expect(status).toBe(200);
    expect(body.polished).toBe(false);
    expect(body.text).toBe('Ship it');
    expect(body.written).toEqual({ style: 'professional', forAgents: true, projectId: null, applied: false });
  });

  it('names the project whose own tone is in force', async () => {
    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO folders (id, user_id, name, dictation_style, created_at, updated_at) VALUES (?, ?, 'Acme', 'concise', ?, ?)`,
    ).bind(PROJECT, USER, now, now).run();
    const { body } = await polish({ text: 'um ship it', projectId: PROJECT });
    expect(body.written).toEqual({ style: 'concise', forAgents: true, projectId: PROJECT, applied: false });
  });

  it('reports the tone a rewrite asked for', async () => {
    const { body } = await polish({ text: 'um ship it', style: 'natural', forAgents: false });
    expect(body.written).toMatchObject({ style: 'natural', forAgents: false, projectId: null });
  });

  it('says nothing about the tone when there are no words to write', async () => {
    const { body } = await polish({ text: '   ' });
    expect(body.polished).toBe(false);
    expect(body.written).toBeUndefined();
  });
});
