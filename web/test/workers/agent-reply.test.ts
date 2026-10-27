import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from '../../src/routes/api/agents/reply-suggestion';
import { guardSpend, guardUserQuota } from '../../src/server/rate-limit';
import { handler, insertDeviceActor, resetTables, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));

// The model is never called for real.
const model = vi.hoisted(() => ({ calls: 0, down: false }));
vi.mock('../../src/lib/ai/client', async (importOriginal) => {
  const client = () => ({
    messages: {
      create: async () => {
        model.calls += 1;
        if (model.down) throw new Error('model down');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: 'wants to know whether to ship.', needsYou: true, suggestedReply: 'Ship it.' }) }] };
      },
    },
  });
  return { ...(await importOriginal<object>()), anthropic: client, anthropicForUser: client };
});

// Pass-through spies: the route must charge the agent-reply scopes.
vi.mock('../../src/server/rate-limit', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/server/rate-limit')>();
  return { ...original, guardSpend: vi.fn(original.guardSpend), guardUserQuota: vi.fn(original.guardUserQuota) };
});

const USER = 'user_agent_reply';
const body = { kind: 'stop', session: 'eavesy', message: 'Done. Ship it?' };

async function post(token?: string, payload: unknown = body) {
  const request = new Request('https://eavesy.test/api/agents/reply-suggestion', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  const response = await handler(Route, 'POST')({ request, params: {} });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM rate_limits').run().catch(() => undefined);
  await resetTables('device_tokens', 'devices', 'users');
  actor.userId = null;
  model.calls = 0;
  model.down = false;
  vi.mocked(guardSpend).mockClear();
  vi.mocked(guardUserQuota).mockClear();
});

describe('/api/agents/reply-suggestion', () => {
  it('refuses a caller with no credentials before charging anything', async () => {
    const { status, body: answer } = await post();
    expect(status).toBe(401);
    expect(answer.error).toBeTypeOf('string');
    expect(guardUserQuota).not.toHaveBeenCalled();
    expect(guardSpend).not.toHaveBeenCalled();
    expect(model.calls).toBe(0);
  });

  it('refuses a revoked device token', async () => {
    const token = await insertDeviceActor(USER, 'device_agent_reply');
    await testEnv.DB.prepare('UPDATE device_tokens SET revoked_at = ?').bind(Date.now()).run();
    expect((await post(token)).status).toBe(401);
  });

  it('answers a paired device and charges its user quota and the spend budget', async () => {
    const token = await insertDeviceActor(USER, 'device_agent_reply');
    const { status, body: answer } = await post(token);
    expect(status).toBe(200);
    expect(answer).toEqual({ summary: 'wants to know whether to ship.', needsYou: true, suggestedReply: 'Ship it.' });
    expect(guardUserQuota).toHaveBeenCalledWith(USER, 'agent-reply', expect.any(Number));
    expect(vi.mocked(guardSpend).mock.calls[0]?.[1]).toBe('agent-reply');
  });

  it('stops at the daily user quota without calling the model', async () => {
    const token = await insertDeviceActor(USER, 'device_agent_reply');
    process.env.QUOTA_AGENT_REPLY_PER_DAY = '1';
    try {
      expect((await post(token)).status).toBe(200);
      const { status, body: answer } = await post(token);
      expect(status).toBe(429);
      expect(answer.code).toBe('daily_quota');
      expect(model.calls).toBe(1);
    } finally {
      delete process.env.QUOTA_AGENT_REPLY_PER_DAY;
    }
  });

  it('does not charge the quota for an invalid request', async () => {
    const token = await insertDeviceActor(USER, 'device_agent_reply');
    expect((await post(token, { kind: 'stop', session: '', message: 'x' })).status).toBe(400);
    expect(guardUserQuota).not.toHaveBeenCalled();
    expect(guardSpend).not.toHaveBeenCalled();
  });

  it('gives the daily use and the global budget unit back when the model call fails', async () => {
    const token = await insertDeviceActor(USER, 'device_agent_reply');
    process.env.QUOTA_AGENT_REPLY_PER_DAY = '1';
    process.env.BUDGET_AGENT_REPLY_PER_DAY = '1';
    try {
      model.down = true;
      const failed = await post(token);
      expect(failed.status).toBe(502);
      expect(JSON.stringify(failed.body)).not.toContain('model down');
      model.down = false;
      expect((await post(token)).status).toBe(200);
    } finally {
      delete process.env.QUOTA_AGENT_REPLY_PER_DAY;
      delete process.env.BUDGET_AGENT_REPLY_PER_DAY;
    }
  });
});
