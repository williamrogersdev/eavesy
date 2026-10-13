import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { devicePairingCodes } from '@/db/schema';
import { resolveActor } from '@/server/auth';
import { sha256Hex } from '@/server/device-auth';
import { registerDevice } from '@/server/pair-device';
import { sameNetwork } from '@/lib/http/same-network';
import { pairingOrigin } from '@/server/pairing-origin';
import { clientIp } from '@/server/rate-limit';
import * as activityRepo from '@/db/repo/activity';

const pairSchema = z.union([
  z.object({ code: z.string().trim().min(6).max(20) }),
  z.object({
    deviceId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(120),
    rootFolderPath: z.string().trim().min(1).max(1_024).default('~/Eavesy/Recordings'),
  }),
]);

export const Route = createFileRoute('/api/devices/pair')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const code = new URL(request.url).searchParams.get('code')?.trim() ?? '';
        if (code.length < 6 || code.length > 20) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const codeHash = await sha256Hex(code.toUpperCase());
        const pairing = (
          await getDb()
            .select({ createdAt: devicePairingCodes.createdAt, expiresAt: devicePairingCodes.expiresAt, rawToken: devicePairingCodes.rawToken })
            .from(devicePairingCodes)
            .where(eq(devicePairingCodes.codeHash, codeHash))
            .limit(1)
        )[0];
        if (!pairing || pairing.expiresAt <= Date.now() || pairing.rawToken) {
          return Response.json({ error: 'pairing_code_expired' }, { status: 404 });
        }
        const origin = await pairingOrigin(codeHash);
        const here = clientIp(request);
        return Response.json({
          requestedAt: pairing.createdAt,
          sameNetwork: origin && here !== 'unknown' ? sameNetwork(origin, here) : null,
        });
      },
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = pairSchema.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
        }

        const db = getDb();
        if ('code' in parsed.data) {
          const codeHash = await sha256Hex(parsed.data.code.toUpperCase());
          const pairing = (
            await db.select().from(devicePairingCodes).where(eq(devicePairingCodes.codeHash, codeHash)).limit(1)
          )[0];
          if (!pairing || pairing.expiresAt <= Date.now() || pairing.rawToken) {
            return Response.json({ error: 'pairing_code_expired' }, { status: 404 });
          }
          try {
            const rawToken = await registerDevice(db, {
              userId: actor.userId,
              deviceId: pairing.deviceId,
              name: pairing.name,
              rootFolderPath: pairing.rootFolderPath,
              allowTransfer: true,
            });
            await db
              .update(devicePairingCodes)
              .set({ rawToken, claimedByUserId: actor.userId })
              .where(eq(devicePairingCodes.codeHash, codeHash));
            await activityRepo.log(db, {
              userId: actor.userId,
              eventType: 'device.pair',
              metadata: { platform: 'macos' },
            });
            return Response.json({ ok: true, deviceId: pairing.deviceId });
          } catch (error) {
            if (error instanceof Error && error.message === 'device_already_registered') {
              return Response.json({ error: error.message }, { status: 409 });
            }
            throw error;
          }
        }

        try {
          const rawToken = await registerDevice(db, { userId: actor.userId, ...parsed.data });
          await activityRepo.log(db, {
            userId: actor.userId,
            eventType: 'device.pair',
            metadata: { platform: 'macos' },
          });
          return Response.json({ deviceId: parsed.data.deviceId, token: rawToken }, { status: 201 });
        } catch (error) {
          if (error instanceof Error && error.message === 'device_already_registered') {
            return Response.json({ error: error.message }, { status: 409 });
          }
          throw error;
        }
      },
    },
  },
});
