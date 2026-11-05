import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import * as usersRepo from '@/db/repo/users';
import { resolveActor } from '@/server/auth';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { guardBurst, guardUserQuota } from '@/server/rate-limit';
import type { RecapEnv } from '@/server/email/recaps';
import { emailConfigured } from '@/server/email/resend';
import { MAX_NOTE_LENGTH, MAX_NOTE_RECIPIENTS, queueMeetingNotes, shareOverview } from '@/server/email/meeting-notes';

const sendSchema = z.object({
  recipients: z.array(z.string().max(320)).min(1).max(MAX_NOTE_RECIPIENTS),
  note: z.string().max(MAX_NOTE_LENGTH).nullable().optional(),
});

/**
 * The "Send to everyone" confirm page's API. GET only reads, so a mail scanner
 * opening the emailed link sends nothing; sending is a JSON POST from the
 * signed-in owner's own page.
 */
export const Route = createFileRoute('/api/meetings/$id/share-notes')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const [meeting, user] = await Promise.all([
          meetingsRepo.get(db, { meetingId: params.id, userId: actor.userId }),
          usersRepo.getById(db, actor.userId),
        ]);
        if (!meeting || !user) return Response.json({ error: 'not_found' }, { status: 404 });
        return Response.json(await shareOverview(db, getCloudflareContext<RecapEnv>().env, user, meeting));
      },

      POST: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        // A form on another site can't send JSON without a preflight; refuse anything else.
        if (request.headers.get('sec-fetch-site') === 'cross-site'
          || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }
        const parsed = sendSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

        const db = getDb();
        const env = getCloudflareContext<RecapEnv>().env;
        const [meeting, user] = await Promise.all([
          meetingsRepo.get(db, { meetingId: params.id, userId: actor.userId }),
          usersRepo.getById(db, actor.userId),
        ]);
        if (!meeting || !user) return Response.json({ error: 'not_found' }, { status: 404 });
        if (user.isAnonymous || !user.email) {
          return Response.json({ error: 'Add an email address to your account to send notes.' }, { status: 400 });
        }
        if (!emailConfigured(env)) return Response.json({ error: 'Email is not set up on this server.' }, { status: 503 });
        if (meeting.status !== 'complete') {
          return Response.json({ error: 'The notes are not ready yet.' }, { status: 409 });
        }

        const limited = await guardBurst(actor.userId, 'share-notes') ?? await guardUserQuota(actor.userId, 'share-notes');
        if (limited) return limited;

        const results = await queueMeetingNotes(db, env, {
          user,
          meeting,
          recipients: parsed.data.recipients,
          note: parsed.data.note ?? null,
        });
        const queued = results.filter((r) => r.outcome === 'queued').length;
        await activityRepo.log(db, {
          userId: actor.userId,
          eventType: 'meeting.share',
          meetingId: meeting.id,
          metadata: { kind: 'notes_email', queued, skipped: results.length - queued },
        });
        return Response.json({ results });
      },
    },
  },
});
