import { describe, expect, test } from 'bun:test';
import { buildAuthorizeUrl, deriveCodeChallenge, generateCodeVerifier } from './openrouter';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('generateCodeVerifier', () => {
  test('is a 43-char base64url string with no padding', () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(43);
    expect(v).toMatch(BASE64URL);
    expect(v).not.toContain('=');
  });

  test('is unpredictable across calls', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    expect(set.size).toBe(50);
  });
});

describe('deriveCodeChallenge', () => {
  test('matches the RFC 7636 S256 reference vector', async () => {
    const challenge = await deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('is deterministic and base64url', async () => {
    const v = generateCodeVerifier();
    const a = await deriveCodeChallenge(v);
    const b = await deriveCodeChallenge(v);
    expect(a).toBe(b);
    expect(a).toMatch(BASE64URL);
  });
});

describe('buildAuthorizeUrl', () => {
  test('targets OpenRouter with S256 and encodes the callback', () => {
    const url = new URL(
      buildAuthorizeUrl({
        callbackUrl: 'https://eavesy.com/api/connections/openrouter/callback',
        codeChallenge: 'abc123',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('abc123');
    expect(url.searchParams.get('callback_url')).toBe(
      'https://eavesy.com/api/connections/openrouter/callback',
    );
  });
});
