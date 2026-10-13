import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { devicePairingCodes } from '@/db/schema';
import { sha256Hex } from '@/server/device-auth';
import { rememberPairingOrigin } from '@/server/pairing-origin';
import { clientIp, rateLimit } from '@/server/rate-limit';

const bodySchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  rootFolderPath: z.string().trim().min(1).max(1_024),
});
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function pairingCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export const Route = createFileRoute('/api/devices/pair/start')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const limited = await rateLimit({
          key: `device-pair:${clientIp(request)}`,
          limit: 10,
          windowSec: 60,
        });
        if (!limited.allowed) {
          return Response.json(
            { error: 'too_many_pairing_attempts' },
            { status: 429, headers: { 'retry-after': String(limited.retryAfterSec) } },
          );
        }
        const parsed = bodySchema.safeParse(await request.json());
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

        const code = pairingCode();
        const now = Date.now();
        const codeHash = await sha256Hex(code);
        await getDb().insert(devicePairingCodes).values({
          codeHash,
          deviceId: parsed.data.deviceId,
          name: parsed.data.name,
          rootFolderPath: parsed.data.rootFolderPath,
          expiresAt: now + 10 * 60 * 1_000,
          createdAt: now,
        });
        await rememberPairingOrigin(codeHash, clientIp(request), 600);
        return Response.json({
          code,
          verificationUrl: `${new URL(request.url).origin}/connect/mac?code=${code}`,
          expiresInSec: 600,
        });
      },
    },
  },
});
