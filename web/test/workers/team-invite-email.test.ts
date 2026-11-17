import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as TeamRoute } from '../../src/routes/api/team';
import { Route as InvitesRoute } from '../../src/routes/api/team/invites';
import { handler, insertUser, resetTables, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_ada' }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => ({ userId: actor.userId, isAnonymous: false }),
  tryResolveActor: async () => ({ userId: actor.userId, isAnonymous: false }),
}));
vi.mock('../../src/server/cloudflare-context', async () => {
  const { env } = await import('cloudflare:workers');
  const withEmail = Object.create(env as object, {
    RESEND_API_KEY: { value: 're_test' },
    EMAIL_FROM: { value: 'Eavesy <team@example.com>' },
    APP_URL: { value: 'https://app.example.com/' },
  }) as unknown;
  return { getCloudflareContext: () => ({ env: withEmail }) };
});

async function as(who: string, route: { options: unknown }, path: string, body: unknown) {
  actor.userId = who;
  const response = await handler(route, 'POST')({
    request: new Request(`https://test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    params: {},
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetTables('team_invites', 'team_members', 'teams', 'users');
  await insertUser('user_ada');
  await testEnv.DB.prepare("UPDATE users SET email = 'ada@example.com', display_name = 'Ada Lovelace' WHERE id = 'user_ada'").run();
  expect((await as('user_ada', TeamRoute, '/api/team', { name: 'Acme' })).status).toBe(200);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('team invitation emails', () => {
  it('emails the invited address who invited them, to which team, and where to accept', async () => {
    const sent: { headers: Headers; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ id: 'email_1' });
    }));

    const invited = await as('user_ada', InvitesRoute, '/api/team/invites', { email: ' Bo@Example.com ', role: 'admin' });
    expect(invited).toMatchObject({ status: 200, body: { emailed: true } });
    expect(sent).toHaveLength(1);
    const email = sent[0]!.body;
    expect(email.to).toEqual(['bo@example.com']);
    expect(email.from).toBe('Eavesy <team@example.com>');
    expect(email.subject).toBe('Ada Lovelace invited you to Acme on Eavesy');
    expect(email.text).toContain('as an admin');
    expect(email.text).toContain('https://app.example.com/app/team');
    expect(sent[0]!.headers.get('idempotency-key')).toMatch(new RegExp(`^team-invite:${String(invited.body.id)}:\\d+$`));
  });

  it('keeps the invitation and says so when the email is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'validation_error' }, { status: 422 })));
    const invited = await as('user_ada', InvitesRoute, '/api/team/invites', { email: 'bo@example.com' });
    expect(invited).toMatchObject({ status: 200, body: { emailed: false } });
    expect(await testEnv.DB.prepare('SELECT count(*) AS n FROM team_invites').first('n')).toBe(1);
  });
});

describe('team invitation email limits', () => {
  it('stops a burst of invitations before it sends more email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'email_1' })));
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await as('user_ada', InvitesRoute, '/api/team/invites', { email: `p${i}@example.com` })).status);
    }
    expect(statuses).toContain(429);
  });
});
