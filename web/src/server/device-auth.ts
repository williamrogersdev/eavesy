import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { deviceTokens } from '@/db/schema';
import { sha256Hex } from '@/lib/sha256';
import { resolveActor, type ResolvedActor } from '@/server/auth';

export interface ResolvedIngestActor extends ResolvedActor {
  deviceId?: string;
}

export const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

export { sha256Hex };

export async function resolveIngestActor(request: Request): Promise<ResolvedIngestActor> {
  const authorization = request.headers.get('authorization') ?? '';
  const rawToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (rawToken) {
    const db = getDb();
    const tokenHash = await sha256Hex(rawToken);
    const token = (
      await db.select().from(deviceTokens).where(eq(deviceTokens.tokenHash, tokenHash)).limit(1)
    )[0];
    if (!token || token.revokedAt) throw new Error('invalid_device_token');

    const now = Date.now();
    if (!token.lastUsedAt || now - token.lastUsedAt > LAST_USED_RESOLUTION_MS) {
      await db.update(deviceTokens).set({ lastUsedAt: now }).where(eq(deviceTokens.id, token.id));
    }

    return {
      userId: token.userId,
      deviceId: token.deviceId,
      isAnonymous: false,
    };
  }

  return resolveActor();
}

export function mintDeviceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `eavesy_device_${encoded}`;
}
