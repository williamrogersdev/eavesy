import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import * as meetingsRepo from '@/db/repo/meetings';
import { isTranscriptionLanguage } from '@/lib/transcription/language';
import { resolveIngestActor } from '@/server/device-auth';
import { guardBurst } from '@/server/rate-limit';

/** Past this offset the list reads as ended, so a client paging through wraps around. */
const MAX_LIST_OFFSET = 100_000;

const createSessionSchema = z.object({
  clientSessionId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  language: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((language) => (language && isTranscriptionLanguage(language) ? language : undefined)),
  contextBlurb: z.string().trim().max(4_000).optional(),
  localFolderSlug: z.string().trim().max(200).optional(),
  archiveFormat: z.enum(['m4a', 'webm', 'opus']).default('m4a'),
});

export const Route = createFileRoute('/api/sessions/')({
  server: {
    handlers: {
      // Finished meetings this device did not record, so a second Mac can show them.
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const search = new URL(request.url).searchParams;
        const limit = Math.min(Math.max(Number(search.get('limit')) || 50, 1), 200);
        const offset = Math.max(Math.floor(Number(search.get('offset')) || 0), 0);
        if (offset > MAX_LIST_OFFSET) return Response.json({ items: [] });
        const items = await getDb()
          .select({
            id: meetings.id,
            title: meetings.title,
            startedAt: meetings.startedAt,
            durationSec: meetings.durationSec,
            source: meetings.source,
            updatedAt: meetings.updatedAt,
          })
          .from(meetings)
          .where(
            and(
              eq(meetings.userId, actor.userId),
              eq(meetings.status, 'complete'),
              isNull(meetings.deletedAt),
              actor.deviceId ? or(isNull(meetings.deviceId), ne(meetings.deviceId, actor.deviceId)) : undefined,
            ),
          )
          .orderBy(desc(meetings.startedAt), desc(meetings.id))
          .limit(limit)
          .offset(offset);
        return Response.json({ items });
      },
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const limited = await guardBurst(actor.userId, 'session-create');
        if (limited) return limited;

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
