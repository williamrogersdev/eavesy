import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import * as usersRepo from '@/db/repo/users';
import { chatWithMeeting } from '@/lib/ai/chat-meeting';
import { MAX_HEARD, meetingChatContext } from '@/lib/ai/meeting-chat-context';
import { guardUserQuota } from '@/server/rate-limit';
import { resolveModelPlan } from '@/lib/providers/router';
import { resolveIngestActor } from '@/server/device-auth';

const schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
  /**
   * From the recorder's Mac, while the meeting is still going on: what it has
   * heard that the transcript may not hold yet (the cloud writes a line about
   * a minute after it is said).
   */
  heard: z.string().max(MAX_HEARD).optional(),
});

export const Route = createFileRoute('/api/meetings/$id/chat')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { id } = params;

        // The website's session, or the Mac that is recording the meeting.
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        let body: z.infer<typeof schema>;
        try {
          body = schema.parse(await request.json().catch(() => null));
        } catch {
          return Response.json({ error: 'invalid_request' }, { status: 400 });
        }
        if (body.messages[body.messages.length - 1]?.role !== 'user') {
          return Response.json({ error: 'last_message_must_be_user' }, { status: 400 });
        }
        const overQuota = await guardUserQuota(actor.userId, 'chat');
        if (overQuota) return overQuota;

        const db = getDb();
        const data = await meetingsRepo.getFull(db, { meetingId: id, userId: actor.userId });
        if (!data) return Response.json({ error: 'not_found' }, { status: 404 });
        if (data.meeting.status !== 'complete' && !data.segments.length && !body.heard?.trim()) {
          return Response.json(
            { error: 'not_ready', message: 'This meeting is still processing.' },
            { status: 409 },
          );
        }

        const planUser = await usersRepo.getById(db, actor.userId);
        const plan = resolveModelPlan(planUser);

        let reply: string;
        try {
          reply = await chatWithMeeting({
            context: meetingChatContext(data, { heard: body.heard, now: Date.now() }),
            history: body.messages,
            openRouter: plan.openRouter,
            byoApiKey: plan.summary.apiKey,
          });
        } catch (err) {
          console.error('[meeting-chat] failed', err);
          return Response.json({ error: 'chat_failed' }, { status: 502 });
        }

        await activityRepo.log(db, { userId: actor.userId, eventType: 'meeting.chat', meetingId: id });
        return Response.json({ reply });
      },
    },
  },
});
