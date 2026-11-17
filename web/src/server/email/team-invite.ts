import { escapeHtml } from './recaps';
import { appUrl, EmailError, sendEmail, type EmailEnv } from './resend';

export interface TeamInviteContent {
  inviterName: string;
  teamName: string;
  role: 'admin' | 'member';
  /** Where the invitee signs in and accepts. */
  link: string;
  expiresAt: number;
}

/** The email someone gets when they're invited to a team: who asked, which team, and how to join. */
export function renderTeamInvite(content: TeamInviteContent) {
  const subject = `${content.inviterName} invited you to ${content.teamName} on Eavesy`.slice(0, 200);
  const role = content.role === 'admin' ? 'an admin' : 'a member';
  const until = new Date(content.expiresAt).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });
  const intro = `${content.inviterName} invited you to join ${content.teamName} on Eavesy as ${role}.`;
  const how = 'Sign in to Eavesy with this email address, then accept the invitation on the Team page.';
  const notice = 'Team owners and admins can see the recordings you make after you join.';
  const expiry = `The invitation is open until ${until}. If you weren’t expecting it, you can ignore this email.`;

  const text = [intro, '', how, content.link, '', notice, '', expiry].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#16213f;line-height:1.5;max-width:600px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">Join ${escapeHtml(content.teamName)} on Eavesy</h1>
<p style="margin:0 0 16px">${escapeHtml(intro)}</p>
<p style="margin:0 0 24px">${escapeHtml(how)}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(content.link)}" style="display:inline-block;background:#f2b233;color:#16213f;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:999px">Open the invitation</a></p>
<p style="color:#505a75;font-size:13px;margin:0 0 8px">${escapeHtml(notice)}</p>
<p style="color:#666d85;font-size:12px;margin-top:32px">${escapeHtml(expiry)}</p>
</body></html>`;
  return { subject, html, text };
}

/**
 * Emails a new invitation. Returns whether it went out; a failure leaves the
 * invitation in place, and the inviter is told to let the person know themselves.
 */
export async function sendTeamInvite(
  env: EmailEnv,
  invite: TeamInviteContent & { id: string; email: string; sentAt: number },
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  try {
    await sendEmail(
      { RESEND_API_KEY: env.RESEND_API_KEY, EMAIL_FROM: env.EMAIL_FROM },
      {
        to: invite.email,
        ...renderTeamInvite(invite),
        tags: { kind: 'team_invite', invite: invite.id },
        // One email per invite click: inviting the same address again sends a fresh one.
        idempotencyKey: `team-invite:${invite.id}:${invite.sentAt}`,
      },
    );
    return true;
  } catch (error) {
    if (error instanceof EmailError) {
      console.warn('team invite email failed', { invite: invite.id, status: error.status, uncertain: error.uncertain });
      // It may have reached Resend: don't tell the inviter it didn't go out.
      return error.uncertain;
    }
    throw error;
  }
}

/** Where the invitation link points: the Team page, which shows open invitations for the signed-in address. */
export function teamInviteLink(env: EmailEnv) {
  return `${appUrl(env)}/app/team`;
}
