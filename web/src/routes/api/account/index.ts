import { createFileRoute } from '@tanstack/react-router';
import { clerkClient } from '@clerk/tanstack-react-start/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as usersRepo from '@/db/repo/users';
import { captures, deviceTokens, dictations, mcpTokens, meetings, personalDictionary, users } from '@/db/schema';
import { resolveActor } from '@/server/auth';
import { reportError } from '@/server/observability';
import { enqueue } from '@/server/queue';

const bodySchema = z.object({ confirm: z.string().trim().min(1).max(320) });

export const Route = createFileRoute('/api/account/')({
  server: {
    handlers: {
      DELETE: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = bodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'confirmation_required' }, { status: 400 });

        const db = getDb();
        const user = await usersRepo.getById(db, actor.userId);
        if (!user) return Response.json({ error: 'not_found' }, { status: 404 });
        const expected = user.email ?? 'DELETE';
        if (parsed.data.confirm.toLowerCase() !== expected.toLowerCase()) {
          return Response.json({ error: 'confirmation_mismatch' }, { status: 400 });
        }

        const now = Date.now();
        // One D1 batch is one transaction: either the account is gone or nothing changed.
        await db.batch([
          db.delete(personalDictionary).where(eq(personalDictionary.userId, actor.userId)),
          db
            .update(deviceTokens)
            .set({ revokedAt: now })
            .where(and(eq(deviceTokens.userId, actor.userId), isNull(deviceTokens.revokedAt))),
          db
            .update(mcpTokens)
            .set({ revokedAt: now })
            .where(and(eq(mcpTokens.userId, actor.userId), isNull(mcpTokens.revokedAt))),
          db
            .update(meetings)
            .set({ deletedAt: now })
            .where(and(eq(meetings.userId, actor.userId), isNull(meetings.deletedAt))),
          db
            .update(captures)
            .set({ deletedAt: now })
            .where(and(eq(captures.userId, actor.userId), isNull(captures.deletedAt))),
          db
            .update(dictations)
            .set({ deletedAt: now })
            .where(and(eq(dictations.userId, actor.userId), isNull(dictations.deletedAt))),
          db
            .update(users)
            .set({
              clerkUserId: null,
              email: null,
              displayName: null,
              companyName: null,
              role: null,
              phoneNumber: null,
              byoAnthropicKey: null,
              byoDeepgramKey: null,
              byoOpenRouterKey: null,
              openRouterPkceVerifier: null,
              updatedAt: now,
            })
            .where(eq(users.id, actor.userId)),
        ]);

        await enqueue({ kind: 'purge-account', userId: actor.userId }).catch((error: unknown) =>
          reportError('account purge enqueue failed', error, { userId: actor.userId }),
        );

        let signInRemoved = true;
        if (actor.clerkUserId) {
          try {
            await clerkClient().users.deleteUser(actor.clerkUserId);
          } catch (error) {
            signInRemoved = false;
            reportError('clerk user delete failed', error, { userId: actor.userId });
          }
        }
        return Response.json({ ok: true, signInRemoved });
      },
    },
  },
});
