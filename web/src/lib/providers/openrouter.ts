import { isRecord } from '@/lib/json';

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function buildAuthorizeUrl(opts: {
  callbackUrl: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    callback_url: opts.callbackUrl,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${OPENROUTER_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForKey(opts: {
  code: string;
  codeVerifier: string;
}): Promise<{ key: string }> {
  const res = await fetch(OPENROUTER_KEY_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: opts.code,
      code_verifier: opts.codeVerifier,
      code_challenge_method: 'S256',
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter key exchange failed (${res.status})`);
  }

  const json: unknown = await res.json();
  if (!isRecord(json) || typeof json.key !== 'string' || json.key.length === 0) {
    throw new Error('OpenRouter key exchange returned no key');
  }
  return { key: json.key };
}
