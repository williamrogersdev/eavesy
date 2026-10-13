import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { devices, users } from '@/db/schema';
import * as activityRepo from '@/db/repo/activity';
import * as usersRepo from '@/db/repo/users';
import * as subsRepo from '@/db/repo/subscriptions';
import { openUserKeys } from '@/server/secret-box';
import { resolveActor } from '@/server/auth';

const updateSchema = z.object({
  displayName: z.string().max(100).optional(),
  companyName: z.string().max(120).nullable().optional(),
  role: z.string().max(60).nullable().optional(),
  phoneNumber: z.string().max(40).nullable().optional(),
  defaultTranscriptionEngine: z.literal('whisper').optional(),
  defaultLanguage: z.string().max(10).optional(),
  byoAnthropicKey: z.string().max(200).nullable().optional(),
});

export const Route = createFileRoute('/api/me')({
  server: {
    handlers: {
      GET: async () => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const rows = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
        const u = rows[0] ? await openUserKeys(rows[0]) : undefined;
        if (!u) return Response.json({ error: 'not found' }, { status: 404 });
        const sub = await subsRepo.getByUserId(db, actor.userId);
        const macDevice = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.userId, actor.userId), eq(devices.platform, 'macos')))
          .limit(1);
        return Response.json({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          companyName: u.companyName,
          role: u.role,
          phoneNumber: u.phoneNumber,
          isAnonymous: u.isAnonymous,
          onboardingCompleted: !!u.onboardingCompletedAt,
          plan: sub?.plan ?? 'free',
          subscriptionStatus: sub?.status ?? 'none',
          hasBilling: !!sub?.stripeCustomerId,
          defaultTranscriptionEngine: 'whisper',
          defaultLanguage: u.defaultLanguage,
          hasAnthropicKey: !!u.byoAnthropicKey,
          anthropicKeyHint: maskedHint(u.byoAnthropicKey),
          hasOpenRouterKey: !!u.byoOpenRouterKey,
          openRouterConnectedAt: u.byoOpenRouterConnectedAt ?? null,
          hasMac: macDevice.length > 0,
        });
      },

      PATCH: async ({ request }) => {
        const body = updateSchema.parse(await request.json());
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        if ('byoAnthropicKey' in body) {
          await usersRepo.updateByoKeys(db, actor.userId, {
            anthropicKey: body.byoAnthropicKey,
          });
        }
        const patch: Partial<typeof users.$inferInsert> = { updatedAt: Date.now() };
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.companyName !== undefined) patch.companyName = body.companyName;
        if (body.role !== undefined) patch.role = body.role;
        if (body.phoneNumber !== undefined) patch.phoneNumber = body.phoneNumber;
        if (body.defaultTranscriptionEngine) patch.defaultTranscriptionEngine = body.defaultTranscriptionEngine;
        if (body.defaultLanguage) patch.defaultLanguage = body.defaultLanguage;
        await db.update(users).set(patch).where(eq(users.id, actor.userId));
        await activityRepo.log(db, { userId: actor.userId, eventType: 'settings.update' });
        return Response.json({ ok: true });
      },
    },
  },
});

function maskedHint(key: string | null | undefined): string | null {
  if (!key) return null;
  return key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}
