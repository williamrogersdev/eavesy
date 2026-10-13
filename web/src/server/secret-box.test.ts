import { expect, test } from 'bun:test';
import { isSealed, openSecret, openUserKeys, sealSecret } from '@/server/secret-box';

const SECRET = 'x'.repeat(48);

test('sealed keys round-trip and never contain the plaintext', async () => {
  const sealed = await sealSecret('sk-ant-supersecret', SECRET);
  expect(isSealed(sealed)).toBe(true);
  expect(sealed).not.toContain('supersecret');
  expect(await openSecret(sealed, SECRET)).toBe('sk-ant-supersecret');
  expect(await sealSecret('sk-ant-supersecret', SECRET)).not.toBe(sealed);
});

test('legacy plaintext still reads; a wrong secret reads as no key', async () => {
  expect(await openSecret('sk-or-legacy', SECRET)).toBe('sk-or-legacy');
  const sealed = await sealSecret('sk-or-new', SECRET);
  expect(await openSecret(sealed, 'y'.repeat(48))).toBeNull();
  expect(await openSecret(sealed, undefined)).toBeNull();
});

test('without a secret, values are stored as given', async () => {
  expect(await sealSecret('sk-ant-dev', undefined)).toBe('sk-ant-dev');
  expect(await sealSecret(null, SECRET)).toBeNull();
});

test('openUserKeys decrypts every BYO field', async () => {
  process.env.BYO_KEY_SECRET = SECRET;
  try {
    const user = await openUserKeys({
      id: 'u1',
      byoAnthropicKey: await sealSecret('a-key'),
      byoDeepgramKey: null,
      byoOpenRouterKey: 'legacy-or',
    });
    expect(user).toEqual({ id: 'u1', byoAnthropicKey: 'a-key', byoDeepgramKey: null, byoOpenRouterKey: 'legacy-or' });
  } finally {
    delete process.env.BYO_KEY_SECRET;
  }
});
