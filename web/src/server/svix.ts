/** Signed deliveries older or newer than this are refused as replays. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1_000;

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verifies a Svix-signed webhook (HMAC-SHA256 over `id.timestamp.body`), the
 * scheme Resend uses. Accepts both `svix-*` and `webhook-*` headers. Returns
 * the delivery id, or null when the request isn't signed with this secret.
 */
export async function verifySvixWebhook(secret: string, headers: Headers, body: string, now = Date.now()): Promise<string | null> {
  const id = headers.get('webhook-id') ?? headers.get('svix-id');
  const timestamp = headers.get('webhook-timestamp') ?? headers.get('svix-timestamp');
  const signatures = headers.get('webhook-signature') ?? headers.get('svix-signature');
  if (!id || !timestamp || !signatures || !secret.startsWith('whsec_')) return null;
  const sentAt = Number(timestamp) * 1_000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > WEBHOOK_TOLERANCE_MS) return null;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', base64ToBytes(secret.slice('whsec_'.length)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    return null;
  }
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  for (const versioned of signatures.split(' ')) {
    const [version, signature] = versioned.split(',');
    if (version !== 'v1' || !signature) continue;
    try {
      if (equalBytes(base64ToBytes(signature), expected)) return id;
    } catch {
      /* malformed signature: try the next one */
    }
  }
  return null;
}
