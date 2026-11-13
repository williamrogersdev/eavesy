import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as AccountRoute } from '../../src/routes/api/account/index';
import { Route as TeamRoute } from '../../src/routes/api/team';
import { Route as InvitesRoute } from '../../src/routes/api/team/invites';
import { Route as AnswerRoute } from '../../src/routes/api/team/invites/answer';
import { Route as MembersRoute } from '../../src/routes/api/team/members';
import { handler, insertUser, resetTables, row, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_ada' }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => ({ userId: actor.userId, isAnonymous: false }),
  tryResolveActor: async () => ({ userId: actor.userId, isAnonymous: false }),
}));

const ADA = 'user_ada';
const BO = 'user_bo';
const CY = 'user_cy';

/** Calls a team route as `who` and returns its status and JSON body. */
async function as(who: string, route: { options: unknown }, method: string, path: string, body?: unknown) {
  actor.userId = who;
  const response = await handler(route, method)({
    request: new Request(`https://test${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params: {},
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function addUser(id: string, email: string) {
  await insertUser(id);
  await testEnv.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, id).run();
}

const roleOf = async (userId: string) =>
  (await row<{ role: string }>('SELECT role FROM team_members WHERE user_id = ?', userId))?.role ?? null;

/** Ada's team with an invitation for Bo's address; returns the invitation id. */
async function teamWithInvite(role: 'member' | 'admin' = 'member'): Promise<string> {
  expect((await as(ADA, TeamRoute, 'POST', '/api/team', { name: 'Acme' })).status).toBe(200);
  const invited = await as(ADA, InvitesRoute, 'POST', '/api/team/invites', { email: ' Bo@Example.com ', role });
  expect(invited.status).toBe(200);
  return invited.body.id as string;
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetTables('team_invites', 'team_members', 'teams', 'users');
  await addUser(ADA, 'ada@example.com');
  await addUser(BO, 'bo@example.com');
  await addUser(CY, 'cy@example.com');
});

describe('teams', () => {
  it('makes the creator the owner, and refuses a second team', async () => {
    expect((await as(ADA, TeamRoute, 'POST', '/api/team', { name: 'Acme' })).status).toBe(200);
    expect(await roleOf(ADA)).toBe('owner');
    const again = await as(ADA, TeamRoute, 'POST', '/api/team', { name: 'Second' });
    expect(again).toMatchObject({ status: 409, body: { error: 'already_in_team' } });
  });

  it('shows an invitation to the invited address, who joins by accepting it', async () => {
    const id = await teamWithInvite();
    const waiting = await as(BO, TeamRoute, 'GET', '/api/team');
    expect(waiting.body).toMatchObject({ team: null, invitations: [{ id, teamName: 'Acme', role: 'member' }] });

    expect((await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true })).status).toBe(200);
    expect(await roleOf(BO)).toBe('member');
    expect(await row('SELECT id FROM team_invites WHERE id = ?', id)).toBeNull();

    const team = await as(BO, TeamRoute, 'GET', '/api/team');
    expect(team.body).toMatchObject({ team: { name: 'Acme', role: 'member' }, me: BO, invites: [] });
    expect((team.body.members as unknown[]).length).toBe(2);
  });

  it('does not let another address see or accept the invitation', async () => {
    const id = await teamWithInvite();
    expect((await as(CY, TeamRoute, 'GET', '/api/team')).body).toMatchObject({ team: null, invitations: [] });
    expect((await as(CY, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true })).status).toBe(404);
    expect(await roleOf(CY)).toBeNull();
    expect(await row('SELECT id FROM team_invites WHERE id = ?', id)).not.toBeNull();
  });

  it('does not accept an expired invitation', async () => {
    const id = await teamWithInvite();
    await testEnv.DB.prepare('UPDATE team_invites SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, id).run();
    expect((await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true })).status).toBe(404);
    expect(await roleOf(BO)).toBeNull();
  });

  it('declining removes the invitation without joining', async () => {
    const id = await teamWithInvite();
    expect((await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: false })).status).toBe(200);
    expect(await roleOf(BO)).toBeNull();
    expect(await row('SELECT id FROM team_invites WHERE id = ?', id)).toBeNull();
  });

  it('keeps members from inviting, renaming, or removing people', async () => {
    const id = await teamWithInvite();
    await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true });
    expect((await as(BO, InvitesRoute, 'POST', '/api/team/invites', { email: 'cy@example.com' })).status).toBe(403);
    expect((await as(BO, TeamRoute, 'PATCH', '/api/team', { name: 'Bo Inc' })).status).toBe(403);
    expect((await as(BO, MembersRoute, 'DELETE', '/api/team/members', { userId: ADA })).status).toBe(403);
    expect((await as(BO, MembersRoute, 'PATCH', '/api/team/members', { userId: BO, role: 'owner' })).status).toBe(403);
    expect(await row('SELECT name FROM teams')).toEqual({ name: 'Acme' });
    expect(await roleOf(ADA)).toBe('owner');
  });

  it('lets an admin invite members but not admins, and not remove the owner', async () => {
    const id = await teamWithInvite('admin');
    await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true });
    expect(await roleOf(BO)).toBe('admin');
    expect((await as(BO, InvitesRoute, 'POST', '/api/team/invites', { email: 'cy@example.com' })).status).toBe(200);
    expect((await as(BO, InvitesRoute, 'POST', '/api/team/invites', { email: 'dee@example.com', role: 'admin' })).status).toBe(403);
    expect((await as(BO, MembersRoute, 'DELETE', '/api/team/members', { userId: ADA })).status).toBe(403);
    expect((await as(BO, MembersRoute, 'PATCH', '/api/team/members', { userId: BO, role: 'owner' })).status).toBe(403);
    expect((await as(BO, MembersRoute, 'PATCH', '/api/team/members', { userId: ADA, role: 'member' })).status).toBe(403);
    expect(await roleOf(ADA)).toBe('owner');
    expect(await roleOf(BO)).toBe('admin');
  });

  it('inviting the same address again renews the one invitation', async () => {
    const id = await teamWithInvite();
    await testEnv.DB.prepare('UPDATE team_invites SET expires_at = 5 WHERE id = ?').bind(id).run();
    const again = await as(ADA, InvitesRoute, 'POST', '/api/team/invites', { email: 'bo@example.com', role: 'admin' });
    expect(again.status).toBe(200);
    const rows = await testEnv.DB.prepare('SELECT role, expires_at FROM team_invites').all<{ role: string; expires_at: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].role).toBe('admin');
    expect(rows.results[0].expires_at).toBeGreaterThan(Date.now());
  });

  it('a full team refuses new and lapsed invitations but renews an open one', async () => {
    const lapsed = await teamWithInvite();
    const open = (await as(ADA, InvitesRoute, 'POST', '/api/team/invites', { email: 'cy@example.com' })).body.id as string;
    await testEnv.DB.prepare('UPDATE team_invites SET expires_at = 5 WHERE id = ?').bind(lapsed).run();
    const team = (await row<{ id: string }>('SELECT id FROM teams'))!.id;
    // Ada, Cy's open invitation and 48 more fill all 50 seats.
    for (let i = 0; i < 48; i++) {
      await testEnv.DB.prepare(
        `INSERT INTO team_invites (id, team_id, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, 'member', ?, 1, ?)`,
      ).bind(`fill_${i}`, team, `fill${i}@example.com`, ADA, Date.now() + 60_000).run();
    }
    expect((await as(ADA, InvitesRoute, 'POST', '/api/team/invites', { email: 'bo@example.com' })).status).toBe(409);
    expect((await as(ADA, InvitesRoute, 'POST', '/api/team/invites', { email: 'new@example.com' })).status).toBe(409);
    const renewed = await as(ADA, InvitesRoute, 'POST', '/api/team/invites', { email: 'cy@example.com' });
    expect(renewed.status).toBe(200);
    expect(renewed.body.id).toBe(open);
  });

  it('two owners can step down only one at a time', async () => {
    const id = await teamWithInvite();
    await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true });
    expect((await as(ADA, MembersRoute, 'PATCH', '/api/team/members', { userId: BO, role: 'owner' })).status).toBe(200);
    expect((await as(BO, MembersRoute, 'PATCH', '/api/team/members', { userId: ADA, role: 'member' })).status).toBe(200);
    expect((await as(ADA, MembersRoute, 'DELETE', '/api/team/members', { userId: BO })).status).toBe(403);
    expect((await as(BO, MembersRoute, 'PATCH', '/api/team/members', { userId: BO, role: 'admin' })).status).toBe(409);
    expect(await roleOf(BO)).toBe('owner');
  });

  it('never leaves a team without an owner', async () => {
    const id = await teamWithInvite();
    await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true });
    // The only owner can't be demoted.
    expect((await as(ADA, MembersRoute, 'PATCH', '/api/team/members', { userId: ADA, role: 'member' })).status).toBe(409);
    // When they leave, the next person takes over.
    expect((await as(ADA, TeamRoute, 'DELETE', '/api/team')).status).toBe(200);
    expect(await roleOf(ADA)).toBeNull();
    expect(await roleOf(BO)).toBe('owner');
    // The last person leaving deletes the team and its invitations.
    await as(BO, InvitesRoute, 'POST', '/api/team/invites', { email: 'cy@example.com' });
    expect((await as(BO, TeamRoute, 'DELETE', '/api/team')).status).toBe(200);
    expect(await row('SELECT id FROM teams')).toBeNull();
    expect(await row('SELECT id FROM team_invites')).toBeNull();
  });

  it('deleting an account takes it out of its team in the same step', async () => {
    const id = await teamWithInvite();
    await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true });
    expect((await as(ADA, AccountRoute, 'DELETE', '/api/account', { confirm: 'ada@example.com' })).status).toBe(200);
    expect(await roleOf(ADA)).toBeNull();
    expect(await roleOf(BO)).toBe('owner');
    expect(await row('SELECT email FROM users WHERE id = ?', ADA)).toEqual({ email: null });
  });

  it('an account delete that cannot leave its team changes nothing', async () => {
    await teamWithInvite();
    await testEnv.DB.exec(`CREATE TRIGGER stuck BEFORE DELETE ON team_members BEGIN SELECT RAISE(ABORT, 'stuck'); END`);
    try {
      await expect(as(ADA, AccountRoute, 'DELETE', '/api/account', { confirm: 'ada@example.com' })).rejects.toThrow();
    } finally {
      await testEnv.DB.exec(`DROP TRIGGER stuck`);
    }
    expect(await row('SELECT email FROM users WHERE id = ?', ADA)).toEqual({ email: 'ada@example.com' });
    expect(await roleOf(ADA)).toBe('owner');
  });

  it('refuses an invitation for someone already in the team', async () => {
    const id = await teamWithInvite();
    await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true });
    const again = await as(ADA, InvitesRoute, 'POST', '/api/team/invites', { email: 'BO@example.com' });
    expect(again).toMatchObject({ status: 409, body: { error: 'already_member' } });
  });

  it('only an owner deletes the team for everyone', async () => {
    const id = await teamWithInvite('admin');
    await as(BO, AnswerRoute, 'POST', '/api/team/invites/answer', { id, accept: true });
    expect((await as(BO, TeamRoute, 'DELETE', '/api/team?everyone=1')).status).toBe(403);
    expect((await as(ADA, TeamRoute, 'DELETE', '/api/team?everyone=1')).status).toBe(200);
    expect(await row('SELECT team_id FROM team_members')).toBeNull();
    expect(await row('SELECT id FROM teams')).toBeNull();
  });
});
