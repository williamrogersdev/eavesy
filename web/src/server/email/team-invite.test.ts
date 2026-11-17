import { describe, expect, it } from 'bun:test';
import { renderTeamInvite } from './team-invite';

describe('renderTeamInvite', () => {
  const content = {
    inviterName: 'Ada <script>',
    teamName: 'Acme & Co',
    role: 'member' as const,
    link: 'https://eavesy.com/app/team',
    expiresAt: Date.UTC(2026, 11, 1),
  };

  it('says who invited them, to which team, and until when', () => {
    const { subject, text } = renderTeamInvite(content);
    expect(subject).toBe('Ada <script> invited you to Acme & Co on Eavesy');
    expect(text).toContain('as a member');
    expect(text).toContain('December 1, 2026');
    expect(text).toContain('owners and admins can see the recordings');
  });

  it('escapes names in the HTML', () => {
    const { html } = renderTeamInvite(content);
    expect(html).not.toContain('<script>');
    expect(html).toContain('Acme &amp; Co');
  });
});
