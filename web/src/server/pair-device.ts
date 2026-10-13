import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { pid } from '@/db/ids';
import { devices, deviceTokens } from '@/db/schema';
import { mintDeviceToken, sha256Hex } from '@/server/device-auth';

export const STALE_DEVICE_MS = 14 * 24 * 60 * 60 * 1000;

export async function registerDevice(
  db: AppDb,
  args: {
    userId: string;
    deviceId: string;
    name: string;
    rootFolderPath: string;
    allowTransfer?: boolean;
  },
): Promise<string> {
  const now = Date.now();
  const existing = (await db.select().from(devices).where(eq(devices.id, args.deviceId)).limit(1))[0];
  if (existing && existing.userId !== args.userId) {
    if (!args.allowTransfer) throw new Error('device_already_registered');
    const live = await db
      .select({ createdAt: deviceTokens.createdAt, lastUsedAt: deviceTokens.lastUsedAt })
      .from(deviceTokens)
      .where(and(eq(deviceTokens.deviceId, args.deviceId), eq(deviceTokens.userId, existing.userId), isNull(deviceTokens.revokedAt)));
    if (live.some((token) => now - (token.lastUsedAt ?? token.createdAt) < STALE_DEVICE_MS)) {
      throw new Error('device_already_registered');
    }
    await db.update(deviceTokens).set({ revokedAt: now }).where(and(eq(deviceTokens.deviceId, args.deviceId), isNull(deviceTokens.revokedAt)));
    await db.update(devices).set({ userId: args.userId }).where(eq(devices.id, args.deviceId));
  }

  await db
    .insert(devices)
    .values({
      id: args.deviceId,
      userId: args.userId,
      name: args.name,
      platform: 'macos',
      rootFolderPath: args.rootFolderPath,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
    })
    .onConflictDoUpdate({
      target: devices.id,
      set: { name: args.name, rootFolderPath: args.rootFolderPath, lastSeenAt: now },
    });

  await db
    .update(deviceTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(deviceTokens.deviceId, args.deviceId),
        eq(deviceTokens.userId, args.userId),
        isNull(deviceTokens.revokedAt),
      ),
    );

  const rawToken = mintDeviceToken();
  await db.insert(deviceTokens).values({
    id: pid('dtok'),
    userId: args.userId,
    deviceId: args.deviceId,
    tokenHash: await sha256Hex(rawToken),
    name: args.name,
    createdAt: now,
  });
  return rawToken;
}
