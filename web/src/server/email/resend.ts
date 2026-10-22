/**
 * Resend, the transactional email provider for meeting recaps.
 * https://resend.com/docs — sends one email per call and verifies its webhooks.
 */

export interface EmailEnv {
  RESEND_API_KEY?: string;
  /** The Svix `whsec_…` secret of the Resend webhook that reports delivery events. */
  RESEND_WEBHOOK_SECRET?: string;
  /** Sender, on a domain verified in Resend, e.g. `Eavesy <recaps@eavesy.com>`. */
  EMAIL_FROM?: string;
  /** Origin links in emails point at; defaults to the hosted app. */
  APP_URL?: string;
}

export type ConfiguredEmailEnv = EmailEnv & { RESEND_API_KEY: string; RESEND_WEBHOOK_SECRET: string; EMAIL_FROM: string };
/** What sending needs; webhooks are only for delivery tracking. */
export type SendingEmailEnv = Pick<ConfiguredEmailEnv, 'RESEND_API_KEY' | 'EMAIL_FROM'>;

/**
 * Thrown for any provider failure. `uncertain` means the email may have gone out;
 * `retryable` means it certainly didn't and asking again later can succeed.
 */
export class EmailError extends Error {
  constructor(message: string, readonly status: number | null, readonly uncertain: boolean, readonly retryable = false) {
    super(message);
  }
}

const API_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;
export const DEFAULT_APP_URL = 'https://eavesy.com';

export function emailConfigured(env: EmailEnv): env is ConfiguredEmailEnv {
  return Boolean(env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET && env.EMAIL_FROM);
}

export function appUrl(env: EmailEnv) {
  return (env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string; contentType: string }[];
  /** Echoed back on every webhook for this email, so an unconfirmed send can still be matched. */
  tags: Record<string, string>;
  /** Resend refuses a second send with the same key for 24 hours. */
  idempotencyKey: string;
}

export function sendBody(env: SendingEmailEnv, email: OutgoingEmail) {
  return {
    from: env.EMAIL_FROM,
    to: [email.to],
    subject: email.subject,
    html: email.html,
    text: email.text,
    ...(email.attachments?.length
      ? { attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })) }
      : {}),
    tags: Object.entries(email.tags).map(([name, value]) => ({ name, value })),
  };
}

export async function sendEmail(env: SendingEmailEnv, email: OutgoingEmail): Promise<{ id: string }> {
  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
        'idempotency-key': email.idempotencyKey,
      },
      body: JSON.stringify(sendBody(env, email)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or dropped connection can still have reached Resend.
    throw new EmailError(`Resend request failed: ${error instanceof Error ? error.message : String(error)}`, null, true);
  }
  if (!response.ok) {
    // Only Resend's error code: its message can echo the recipient's address.
    const body = await response.json().catch(() => null) as { name?: unknown } | null;
    const code = typeof body?.name === 'string' ? body.name.replace(/[^a-z_]/gi, '').slice(0, 60) : 'error';
    const status = response.status;
    // 409: another request with this key is in flight or already went out.
    // 5xx: Resend may have accepted it before failing. 429: refused before sending.
    throw new EmailError(`Resend returned ${status}: ${code}`, status, status === 409 || status >= 500, status === 429);
  }
  const result = await response.json().catch(() => null) as { id?: unknown } | null;
  // A 2xx means it was accepted, even if the body didn't say as what.
  if (typeof result?.id !== 'string' || !result.id) throw new EmailError('Resend returned no email id', response.status, true);
  return { id: result.id };
}
