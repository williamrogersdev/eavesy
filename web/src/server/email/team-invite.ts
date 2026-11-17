import { escapeHtml } from './recaps';
import { appUrl, EmailError, sendEmail, type EmailEnv } from './resend';

export interface TeamInviteContent {
  inviterName: string;
  /** Shown next to the name, so the recipient can tell who really sent it. */
  inviterEmail: string | null;
  teamName: string;
  role: 'admin' | 'member';
  /** Where the invitee signs in and accepts. */
  link: string;
  expiresAt: number;
}

/** The email someone gets when they're invited to a team: who asked, which team, and how to join. */
export function renderTeamInvite(content: TeamInviteContent) {
  // A fixed subject: names are typed by users, and the subject is what a phishing mail would lean on.
  const subject = 'You’re invited to join a team on Eavesy';
  const role = content.role === 'admin' ? 'an admin' : 'a member';
  const until = new Date(content.expiresAt).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });
  // Names are typed by users: they stay out of our own sentences, labelled, on one short line each.
  // The name is capped on its own, so the address after it always shows in full.
  const inviter = content.inviterEmail ? `${plain(content.inviterName)} (${plain(content.inviterEmail, 320)})` : plain(content.inviterName);
  const team = plain(content.teamName);
  const intro = `Someone on Eavesy invited you to join their team as ${role}.`;
  const fields = [['Invited by', inviter], ['Team', team]] as const;
  const how = 'Sign in to Eavesy with this email address, then accept the invitation on the Team page.';
  const notice = 'Team owners and admins can see the recordings you make after you join.';
  const expiry = `The invitation is open until ${until}. If you weren’t expecting it, you can ignore this email.`;
  const safety = 'Eavesy never asks for your password or payment details by email.';

  const text = [intro, '', ...fields.map(([label, value]) => `${label}: ${value}`), '', how, content.link, '', notice, '', expiry, safety].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#16213f;line-height:1.5;max-width:600px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">You’re invited to a team on Eavesy</h1>
<p style="margin:0 0 16px">${escapeHtml(intro)}</p>
<table role="presentation" style="margin:0 0 16px;border-collapse:collapse;font-size:14px">${fields.map(([label, value]) => `<tr><td style="color:#505a75;padding:2px 12px 2px 0">${label}</td><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`).join('')}</table>
<p style="margin:0 0 24px">${escapeHtml(how)}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(content.link)}" style="display:inline-block;background:#f2b233;color:#16213f;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:999px">Open the invitation</a></p>
<p style="color:#505a75;font-size:13px;margin:0 0 8px">${escapeHtml(notice)}</p>
<p style="color:#666d85;font-size:12px;margin-top:32px">${escapeHtml(expiry)}<br>${escapeHtml(safety)}</p>
</body></html>`;
  return { subject, html, text };
}

const NAME_MAX = 80;

/** One line of user-typed text: control characters and line breaks gone, and capped. */
function plain(value: string, max = NAME_MAX) {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/** Whether the email went out: `unknown` when Resend may have taken it without saying so. */
export type InviteEmailResult = 'sent' | 'failed' | 'unknown' | 'off';

/**
 * Emails a new invitation. Never throws: the invitation is already saved, and
 * the inviter is told to let the person know when it isn't certain it went out.
 */
export async function sendTeamInvite(
  env: EmailEnv,
  invite: TeamInviteContent & { id: string; email: string; sentAt: number },
): Promise<InviteEmailResult> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return 'off';
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
    return 'sent';
  } catch (error) {
    const uncertain = error instanceof EmailError ? error.uncertain : true;
    console.warn('team invite email failed', { invite: invite.id, status: error instanceof EmailError ? error.status : null, uncertain });
    return uncertain ? 'unknown' : 'failed';
  }
}

/** Where the invitation link points: the Team page, which shows open invitations for the signed-in address. */
export function teamInviteLink(env: EmailEnv) {
  return `${appUrl(env)}/app/team`;
}
