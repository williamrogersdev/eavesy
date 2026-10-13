import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import { parseSpeakerNames } from '@/lib/transcription/two-track';
import { resolveActor } from '@/server/auth';

const platformValues = ['zoom', 'meet', 'teams', 'in-person', 'phone', 'other'] as const;
const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  folderId: z.string().nullable().optional(),
  platform: z.enum(platformValues).optional(),
  speakerNames: z
    .object({ you: z.string().trim().max(60).optional(), them: z.string().trim().max(60).optional() })
    .optional(),
});

function tokenFrom(request: Request, url: URL): string | undefined {
  return (
    request.headers.get('x-anonymous-token') ??
    url.searchParams.get('anonymousSessionToken') ??
    undefined
  );
}

export const Route = createFileRoute('/api/meetings/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { id } = params;
        const url = new URL(request.url);
        let actor;
        try {
          actor = await resolveActor({ anonymousSessionToken: tokenFrom(request, url) });
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const data = await meetingsRepo.getFull(getDb(), {
          meetingId: id,
          userId: actor.userId,
        });
        if (!data) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json(data);
      },

      PATCH: async ({ request, params }) => {
        const { id } = params;
        const parsed = patchSchema.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
        }
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const { speakerNames, ...fields } = parsed.data;
        let speakerNamesJson: string | undefined;
        if (speakerNames) {
          const meeting = await meetingsRepo.get(getDb(), { meetingId: id, userId: actor.userId });
          if (!meeting) return Response.json({ error: 'not found' }, { status: 404 });
          const merged: Record<string, string> = { ...parseSpeakerNames(meeting.speakerNamesJson) };
          for (const [speaker, name] of Object.entries(speakerNames)) {
            if (name) merged[speaker] = name;
            else delete merged[speaker];
          }
          speakerNamesJson = JSON.stringify(merged);
        }
        await meetingsRepo.update(getDb(), { meetingId: id, userId: actor.userId, ...fields, speakerNamesJson });
        return Response.json({ ok: true });
      },

      DELETE: async ({ params }) => {
        const { id } = params;
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        await meetingsRepo.softDelete(getDb(), { meetingId: id, userId: actor.userId });
        await activityRepo.log(getDb(), {
          userId: actor.userId,
          eventType: 'meeting.delete',
          meetingId: id,
        });
        return Response.json({ ok: true });
      },
    },
  },
});
