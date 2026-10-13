const PREFIX = 'enc:v1:';

function configuredSecret(): string | undefined {
  const secret = typeof process !== 'undefined' ? process.env.BYO_KEY_SECRET : undefined;
  return secret && secret.length >= 32 ? secret : undefined;
}

const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(secret))
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
    keys.set(secret, key);
  }
  return key;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function isSealed(value: string | null | undefined): boolean {
  return !!value?.startsWith(PREFIX);
}

export async function sealSecret(
  value: string | null | undefined,
  secret = configuredSecret(),
): Promise<string | null | undefined> {
  if (!value || isSealed(value)) return value;
  if (!secret) {
    console.warn('[secret-box] BYO_KEY_SECRET is unset or too short; storing key unencrypted');
    return value;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await keyFor(secret),
    new TextEncoder().encode(value),
  );
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), iv.length);
  return PREFIX + toBase64(out);
}

export async function openSecret(
  value: string | null | undefined,
  secret = configuredSecret(),
): Promise<string | null | undefined> {
  if (!value || !isSealed(value)) return value;
  if (!secret) return null;
  try {
    const bytes = Uint8Array.from(atob(value.slice(PREFIX.length)), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
      await keyFor(secret),
      bytes.subarray(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

type KeyFields = {
  byoAnthropicKey?: string | null;
  byoDeepgramKey?: string | null;
  byoOpenRouterKey?: string | null;
};

export async function openUserKeys<T extends KeyFields>(user: T): Promise<T> {
  return {
    ...user,
    byoAnthropicKey: await openSecret(user.byoAnthropicKey),
    byoDeepgramKey: await openSecret(user.byoDeepgramKey),
    byoOpenRouterKey: await openSecret(user.byoOpenRouterKey),
  };
}
