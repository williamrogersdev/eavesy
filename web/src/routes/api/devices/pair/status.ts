import { createFileRoute } from '@tanstack/react-router';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { devicePairingCodes } from '@/db/schema';
import { sha256Hex } from '@/server/device-auth';
import { clientIp, rateLimit } from '@/server/rate-limit';

const bodySchema = z.object({ code: z.string().min(6).max(20), deviceId: z.string().uuid() });

export const Route = createFileRoute('/api/devices/pair/status')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const limited = await rateLimit({
          key: `device-pair-status:${clientIp(request)}`,
          limit: 60,
          windowSec: 60,
        });
        if (!limited.allowed) return Response.json({ error: 'rate_limited' }, { status: 429 });
        const parsed = bodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

        const db = getDb();
        const codeHash = await sha256Hex(parsed.data.code.toUpperCase());
        const row = (
          await db
            .select()
            .from(devicePairingCodes)
            .where(
              and(
                eq(devicePairingCodes.codeHash, codeHash),
                eq(devicePairingCodes.deviceId, parsed.data.deviceId),
              ),
            )
            .limit(1)
        )[0];
        if (!row || row.expiresAt <= Date.now()) {
          return Response.json({ status: 'expired' }, { status: 404 });
        }
        if (!row.rawToken) return Response.json({ status: 'pending' });

        // Hand the token over once: only the poll that clears it may return it.
        const handedOff = await db
          .update(devicePairingCodes)
          .set({ rawToken: null, expiresAt: Date.now() })
          .where(and(eq(devicePairingCodes.codeHash, codeHash), eq(devicePairingCodes.rawToken, row.rawToken)))
          .returning({ codeHash: devicePairingCodes.codeHash });
        if (handedOff.length === 0) return Response.json({ status: 'expired' }, { status: 404 });
        return Response.json({ status: 'paired', token: row.rawToken });
      },
    },
  },
});
