import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import * as meetingsRepo from '@/db/repo/meetings';
import { resolveIngestActor } from '@/server/device-auth';

const createSessionSchema = z.object({
  clientSessionId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  language: z.string().trim().min(2).max(10).default('en'),
  contextBlurb: z.string().trim().max(4_000).optional(),
  localFolderSlug: z.string().trim().max(200).optional(),
  archiveFormat: z.enum(['m4a', 'webm', 'opus']).default('m4a'),
});

export const Route = createFileRoute('/api/sessions/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const parsed = createSessionSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
        }

        const db = getDb();
        const existing = (
          await db
            .select({ id: meetings.id, status: meetings.status })
            .from(meetings)
            .where(
              and(
                eq(meetings.userId, actor.userId),
                eq(meetings.clientSessionId, parsed.data.clientSessionId),
              ),
            )
            .limit(1)
        )[0];
        if (existing) {
          return Response.json({
            meetingId: existing.id,
            nextSegmentIdx: 0,
            nextPartNumber: 1,
            status: existing.status,
            idempotent: true,
          });
        }

        const meetingId = await meetingsRepo.start(db, {
          userId: actor.userId,
          source: actor.deviceId ? 'desktop' : 'web',
          title: parsed.data.title,
          language: parsed.data.language,
          contextBlurb: parsed.data.contextBlurb,
          localFolderSlug: parsed.data.localFolderSlug,
          deviceId: actor.deviceId,
          clientSessionId: parsed.data.clientSessionId,
          isAnonymous: false,
          audioFormat: parsed.data.archiveFormat,
        });

        return Response.json(
          { meetingId, nextSegmentIdx: 0, nextPartNumber: 1, status: 'recording' },
          { status: 201 },
        );
      },
    },
  },
});
