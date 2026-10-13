import type { KVNamespace } from '@cloudflare/workers-types';
import { getCloudflareContext } from '@/server/cloudflare-context';

function kv(): KVNamespace | null {
  try {
    return (getCloudflareContext().env as unknown as { CACHE?: KVNamespace }).CACHE ?? null;
  } catch {
    return null;
  }
}

const key = (codeHash: string) => `pair-origin:${codeHash}`;

export async function rememberPairingOrigin(codeHash: string, ip: string, ttlSec: number): Promise<void> {
  if (ip === 'unknown') return;
  try {
    await kv()?.put(key(codeHash), ip, { expirationTtl: Math.max(60, ttlSec) });
  } catch {
    /* best effort: without it the page just shows no network hint */
  }
}

export async function pairingOrigin(codeHash: string): Promise<string | null> {
  try {
    return (await kv()?.get(key(codeHash))) ?? null;
  } catch {
    return null;
  }
}
