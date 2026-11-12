import { describe, expect, test } from 'bun:test';
import { createFakeEnv } from '@/server/testing/fake-env';
import { canInvite, canManage, DEPART_STATEMENTS, normalizeEmail } from './teams';

describe('team roles', () => {
  test('owners manage everyone, admins only members, members nobody', () => {
    expect(canManage('owner', 'owner')).toBe(true);
    expect(canManage('owner', 'admin')).toBe(true);
    expect(canManage('admin', 'member')).toBe(true);
    expect(canManage('admin', 'admin')).toBe(false);
    expect(canManage('admin', 'owner')).toBe(false);
    expect(canManage('member', 'member')).toBe(false);
  });
  test('owners and admins invite', () => {
    expect([canInvite('owner'), canInvite('admin'), canInvite('member')]).toEqual([true, true, false]);
  });
  test('emails compare without case or stray spaces', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});

describe('leaving a team', () => {
  function setup() {
    const { sqlite } = createFakeEnv();
    const user = (id: string) => sqlite.run(`INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)`, [id]);
    const team = (id: string) => sqlite.run(`INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES (?, ?, 'x', 1, 1)`, [id, id]);
    const member = (teamId: string, userId: string, role: string, at: number) => {
      user(userId);
      sqlite.run(`INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`, [teamId, userId, role, at]);
    };
    const depart = (userId: string) => {
      for (const statement of DEPART_STATEMENTS) sqlite.run(statement, [userId]);
    };
    const roles = (teamId: string) =>
      Object.fromEntries(
        (sqlite.query(`SELECT user_id, role FROM team_members WHERE team_id = ?`).all(teamId) as { user_id: string; role: string }[]).map((r) => [r.user_id, r.role]),
      );
    return { sqlite, team, member, depart, roles };
  }

  test('the only owner hands over to the longest-standing admin, else member', () => {
    const t = setup();
    t.team('a');
    t.member('a', 'owner', 'owner', 1);
    t.member('a', 'old-member', 'member', 2);
    t.member('a', 'admin', 'admin', 3);
    t.depart('owner');
    expect(t.roles('a')).toEqual({ 'old-member': 'member', admin: 'owner' });
    t.depart('admin');
    expect(t.roles('a')).toEqual({ 'old-member': 'owner' });
  });

  test('nobody is promoted while another owner remains, or when a non-owner leaves', () => {
    const t = setup();
    t.team('a');
    t.member('a', 'o1', 'owner', 1);
    t.member('a', 'o2', 'owner', 2);
    t.member('a', 'm', 'member', 3);
    t.depart('o1');
    expect(t.roles('a')).toEqual({ o2: 'owner', m: 'member' });
    t.depart('m');
    expect(t.roles('a')).toEqual({ o2: 'owner' });
  });

  test('the last person leaving deletes the team and its invitations, and no other team', () => {
    const t = setup();
    t.team('a');
    t.team('b');
    t.member('a', 'solo', 'owner', 1);
    t.member('b', 'other', 'owner', 1);
    t.sqlite.run(`INSERT INTO team_invites (id, team_id, email, role, invited_by, created_at, expires_at) VALUES ('i1', 'a', 'x@example.com', 'member', 'solo', 1, 2)`);
    t.sqlite.run(`INSERT INTO team_invites (id, team_id, email, role, invited_by, created_at, expires_at) VALUES ('i2', 'b', 'y@example.com', 'member', 'other', 1, 2)`);
    t.depart('solo');
    expect(t.sqlite.query(`SELECT id FROM teams`).all()).toEqual([{ id: 'b' }]);
    expect(t.sqlite.query(`SELECT id FROM team_invites`).all()).toEqual([{ id: 'i2' }]);
    expect(t.roles('b')).toEqual({ other: 'owner' });
  });

  test('someone in no team changes nothing', () => {
    const t = setup();
    t.team('a');
    t.member('a', 'o', 'owner', 1);
    t.depart('stranger');
    expect(t.roles('a')).toEqual({ o: 'owner' });
  });
});
