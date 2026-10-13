import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import * as usersRepo from '@/db/repo/users';
import { chatWithMeeting } from '@/lib/ai/chat-meeting';
import { guardUserQuota } from '@/server/rate-limit';
import { resolveModelPlan } from '@/lib/providers/router';
import { resolveActor } from '@/server/auth';

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
  anonymousSessionToken: z.string().optional(),
});

export const Route = createFileRoute('/api/meetings/$id/chat')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { id } = params;

        let body: z.infer<typeof schema>;
        try {
          body = schema.parse(await request.json());
        } catch {
          return Response.json({ error: 'invalid_request' }, { status: 400 });
        }
        if (body.messages[body.messages.length - 1]?.role !== 'user') {
          return Response.json({ error: 'last_message_must_be_user' }, { status: 400 });
        }

        let actor;
        try {
          actor = await resolveActor({
            anonymousSessionToken:
              request.headers.get('x-anonymous-token') ?? body.anonymousSessionToken,
          });
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const overQuota = await guardUserQuota(actor.userId, 'chat');
        if (overQuota) return overQuota;

        const db = getDb();
        const data = await meetingsRepo.getFull(db, { meetingId: id, userId: actor.userId });
        if (!data) return Response.json({ error: 'not_found' }, { status: 404 });
        if (data.meeting.status !== 'complete' && !data.segments.length) {
          return Response.json(
            { error: 'not_ready', message: 'This meeting is still processing.' },
            { status: 409 },
          );
        }

        const planUser = actor.isAnonymous ? null : await usersRepo.getById(db, actor.userId);
        const plan = resolveModelPlan(planUser);

        let reply: string;
        try {
          reply = await chatWithMeeting({
            context: buildContext(data),
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

function buildContext(data: Awaited<ReturnType<typeof meetingsRepo.getFull>>): string {
  if (!data) return '';
  const { meeting, summary, segments, notes } = data;
  const out: string[] = [`Title: ${meeting.title}`, `When: ${new Date(meeting.startedAt).toISOString()}`];

  if (meeting.contextBlurb?.trim()) {
    out.push(
      '',
      'User-supplied meeting context (ground truth; substitutes for absent speaker labels):',
      meeting.contextBlurb.trim(),
    );
  }

  if (meeting.summaryOverrideMd?.trim()) {
    out.push('', 'User-edited brief:', meeting.summaryOverrideMd.trim());
  } else if (summary) {
    if (summary.tldr) out.push('', `TL;DR: ${summary.tldr}`);
    if (summary.decisions?.length) {
      out.push('', 'Decisions:', ...summary.decisions.map((d) => `- ${d.text}`));
    }
    if (summary.actionItems?.length) {
      out.push(
        '',
        'Action items:',
        ...summary.actionItems.map(
          (a) => `- ${a.owner ? a.owner + ': ' : ''}${a.text}${a.due ? ` (due ${a.due})` : ''}`,
        ),
      );
    }
    if (summary.openQuestions?.length) {
      out.push('', 'Open questions:', ...summary.openQuestions.map((q) => `- ${q.text}`));
    }
  }

  if (notes?.contentMd?.trim()) out.push('', 'User notes:', notes.contentMd.trim());

  if (meeting.transcriptOverrideMd?.trim()) {
    const transcript = meeting.transcriptOverrideMd.trim();
    const MAX = 18000;
    out.push('', 'User-edited transcript:', transcript.length > MAX ? transcript.slice(-MAX) : transcript);
  } else if (segments?.length) {
    const transcript = segments
      .map((s) => `${s.speakerId ? humanizeSpeaker(s.speakerId) + ': ' : ''}${s.text}`)
      .join('\n');
    const MAX = 18000;
    out.push(
      '',
      'Transcript:',
      transcript.length > MAX ? transcript.slice(-MAX) : transcript,
    );
  }

  return out.join('\n');
}

function humanizeSpeaker(id: string): string {
  const m = id.match(/^speaker_(\d+)$/);
  return m ? `Speaker ${Number(m[1]) + 1}` : id;
}
