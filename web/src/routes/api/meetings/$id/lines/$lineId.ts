import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as meetingsRepo from '@/db/repo/meetings';
import * as transcriptsRepo from '@/db/repo/transcripts';
import { resolveActor } from '@/server/auth';

const patchSchema = z
  .object({
    text: z.string().trim().min(1).max(10_000).optional(),
    speakerId: z.enum(['you', 'them']).optional(),
  })
  .refine((body) => body.text !== undefined || body.speakerId !== undefined, 'nothing to change');

const restoreSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  speakerId: z.string().max(60).nullable(),
  text: z.string().min(1).max(10_000),
  confidence: z.number().nullable().optional(),
  language: z.string().regex(/^[a-z]{2,3}$/).nullable().optional(),
  isEdited: z.boolean().optional(),
  isFinal: z.boolean().optional(),
});

async function owned(meetingId: string) {
  let actor;
  try {
    actor = await resolveActor();
  } catch {
    return Response.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const meeting = await meetingsRepo.get(getDb(), { meetingId, userId: actor.userId });
  if (!meeting) return Response.json({ error: 'not found' }, { status: 404 });
  return meeting;
}

export const Route = createFileRoute('/api/meetings/$id/lines/$lineId')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        const meeting = await owned(params.id);
        if (meeting instanceof Response) return meeting;
        const parsed = patchSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        await transcriptsRepo.editSegment(getDb(), {
          meetingId: meeting.id,
          segmentId: params.lineId,
          ...parsed.data,
        });
        return Response.json({ ok: true });
      },

      DELETE: async ({ params }) => {
        const meeting = await owned(params.id);
        if (meeting instanceof Response) return meeting;
        const deleted = await transcriptsRepo.deleteSegment(getDb(), {
          meetingId: meeting.id,
          segmentId: params.lineId,
        });
        if (!deleted) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({ ok: true, line: deleted });
      },

      POST: async ({ request, params }) => {
        const meeting = await owned(params.id);
        if (meeting instanceof Response) return meeting;
        const parsed = restoreSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        await transcriptsRepo.restoreSegment(getDb(), {
          id: params.lineId,
          meetingId: meeting.id,
          confidence: null,
          language: null,
          isEdited: false,
          isFinal: true,
          ...parsed.data,
        });
        return Response.json({ ok: true });
      },
    },
  },
});
