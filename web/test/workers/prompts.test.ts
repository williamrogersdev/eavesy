import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as PromptsRoute } from '../../src/routes/api/prompts/index';
import { Route as PromptRoute } from '../../src/routes/api/prompts/$id';
import { PROMPT_LIMITS, type SavedPrompt } from '../../src/lib/prompts';
import { handler, insertUser, resetTables, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));

const USER = 'user_prompts';

/** What the routes answer; each test reads the field its call returns. */
type Answer = { prompt: SavedPrompt; items: SavedPrompt[]; error?: string };

async function send(method: string, body?: unknown, id?: string) {
  const path = id ? `/api/prompts/${id}` : '/api/prompts';
  const request = new Request(`https://eavesy.test${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const route = id ? PromptRoute : PromptsRoute;
  const response = await handler(route, method)({ request, params: id ? { id } : {} });
  return { status: response.status, body: await response.json<Answer>() };
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM rate_limits').run().catch(() => undefined);
  await resetTables('saved_prompts', 'users');
  await insertUser(USER);
  actor.userId = USER;
});

describe('/api/prompts', () => {
  it('saves a prompt with a slash-command name, and a clashing name gets a number', async () => {
    const first = await send('POST', { name: 'Triage tickets', body: 'Search every ticket.' });
    expect(first.status).toBe(201);
    expect(first.body.prompt).toMatchObject({ name: 'Triage tickets', slug: 'triage-tickets', body: 'Search every ticket.', useCount: 0 });
    const second = await send('POST', { name: 'Triage tickets!', body: 'Again.' });
    expect(second.body.prompt.slug).toBe('triage-tickets-2');
    expect((await send('GET')).body.items.map((p) => p.slug)).toEqual(['triage-tickets', 'triage-tickets-2']);
  });

  it('gives many concurrent prompts with the same name different commands', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => send('POST', { name: 'Plan', body: 'x' })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const slugs = results.map((r) => r.body.prompt.slug);
    expect(new Set(slugs).size).toBe(20);
    // Numbered in order, with a random suffix only as a last resort.
    expect(slugs.every((slug) => /^plan(-\d+)?(-[0-9a-f]{6})?$/.test(slug))).toBe(true);
    expect(slugs).toEqual(expect.arrayContaining(['plan', 'plan-2']));
  });

  it('counts pastes on their own rate limit, apart from edits', async () => {
    const { prompt } = (await send('POST', { name: 'Plan', body: 'x' })).body;
    await send('PATCH', { used: true }, prompt.id);
    const keys = await testEnv.DB.prepare('SELECT key FROM rate_limits').all<{ key: string }>();
    expect(keys.results.map((row) => row.key.split(':')[0]).sort()).toEqual(['prompts', 'prompts-used']);
    await send('PATCH', { used: true, name: 'x' }, prompt.id);
    const edits = await testEnv.DB.prepare(`SELECT count FROM rate_limits WHERE key LIKE 'prompts:%'`).first<{ count: number }>();
    expect(edits?.count).toBe(2);
  });

  it('refuses a prompt without a name or text', async () => {
    expect((await send('POST', { name: ' ', body: 'x' })).status).toBe(400);
    expect((await send('POST', { name: 'x', body: '   ' })).status).toBe(400);
    expect((await send('POST', { name: 'x', body: 'y'.repeat(PROMPT_LIMITS.body + 1) })).status).toBe(400);
  });

  it('keeps the command through renames and text changes, and counts uses', async () => {
    const { prompt } = (await send('POST', { name: 'Plan', body: 'Make a plan.' })).body;
    const edited = await send('PATCH', { body: 'Make a careful plan.' }, prompt.id);
    expect(edited.body.prompt).toMatchObject({ slug: 'plan', body: 'Make a careful plan.' });
    const renamed = await send('PATCH', { name: 'Write the plan' }, prompt.id);
    expect(renamed.body.prompt).toMatchObject({ name: 'Write the plan', slug: 'plan' });
    const used = await send('PATCH', { used: true }, prompt.id);
    expect(used.body.prompt.useCount).toBe(1);
    expect(used.body.prompt.lastUsedAt).toEqual(expect.any(Number));
    expect((await send('PATCH', { used: true, name: 'sneaky' }, prompt.id)).status).toBe(400);
    expect((await send('PATCH', {}, prompt.id)).status).toBe(400);
  });

  it('keeps its own name when renamed to itself, and deletes', async () => {
    const { prompt } = (await send('POST', { name: 'Plan', body: 'Make a plan.' })).body;
    expect((await send('PATCH', { name: 'Plan' }, prompt.id)).body.prompt.slug).toBe('plan');
    expect((await send('DELETE', undefined, prompt.id)).status).toBe(200);
    expect((await send('GET')).body.items).toEqual([]);
    expect((await send('PATCH', { body: 'x' }, prompt.id)).status).toBe(404);
  });

  it('stops at the account limit', async () => {
    const now = Date.now();
    await testEnv.DB.batch(Array.from({ length: PROMPT_LIMITS.count }, (_, i) => testEnv.DB.prepare(
      `INSERT INTO saved_prompts (id, user_id, name, slug, body, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', ?, ?)`,
    ).bind(`prm_${i}`, USER, `P${i}`, `p${i}`, now, now)));
    const refused = await send('POST', { name: 'One more', body: 'x' });
    expect(refused).toEqual({ status: 400, body: { error: 'too_many_prompts' } });
  });
});
