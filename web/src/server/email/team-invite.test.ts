import { describe, expect, it } from 'bun:test';
import { renderTeamInvite } from './team-invite';

describe('renderTeamInvite', () => {
  const content = {
    inviterName: 'Ada <script>',
    inviterEmail: 'ada@example.com',
    teamName: 'Acme & Co',
    role: 'member' as const,
    link: 'https://eavesy.com/app/team',
    expiresAt: Date.UTC(2026, 11, 1),
  };

  it('says who invited them, to which team, and until when', () => {
    const { subject, text } = renderTeamInvite(content);
    expect(subject).toBe('You’re invited to join a team on Eavesy');
    expect(text).toContain('Invited by: Ada <script> (ada@example.com)');
    expect(text).toContain('Team: Acme & Co');
    expect(text).toContain('as a member');
    expect(text).toContain('December 1, 2026');
    expect(text).toContain('owners and admins can see the recordings');
  });

  it('escapes names in the HTML', () => {
    const { html } = renderTeamInvite(content);
    expect(html).not.toContain('<script>');
    expect(html).toContain('Acme &amp; Co');
  });

  it('keeps a typed name to one short line', () => {
    const { text } = renderTeamInvite({ ...content, teamName: `Acme\n\nVerify your account now ${'x'.repeat(200)}` });
    const line = text.split('\n').find((l) => l.startsWith('Team: '))!;
    expect(line.startsWith('Team: Acme Verify your account now')).toBe(true);
    expect(Array.from(line).length).toBeLessThanOrEqual('Team: '.length + 80);
  });
});
