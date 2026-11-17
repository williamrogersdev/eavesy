import { createFileRoute } from '@tanstack/react-router';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { folders } from '@/db/schema';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import * as teamAccess from '@/db/repo/team-access';
import { parseSpeakerNames } from '@/lib/transcription/two-track';
import { refreshAgentTranscriptLater } from '@/server/agent-transcript-refresh';
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

export const Route = createFileRoute('/api/meetings/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { id } = params;
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const data = await meetingsRepo.getFull(db, { meetingId: id, userId: actor.userId });
        if (data) return Response.json({ ...data, access: { kind: 'owner' } });
        // A team owner or admin reads a teammate's recording, without its private notes.
        const team = await teamAccess.teamReadableMeeting(db, { viewerId: actor.userId, meetingId: id });
        const shared = team ? await meetingsRepo.getFull(db, { meetingId: id, userId: team.ownerId }) : null;
        if (!team || !shared) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({
          ...shared,
          notes: null,
          access: { kind: 'team', ownerName: team.ownerName || team.ownerEmail || 'A teammate' },
        });
      },

      PATCH: async ({ request, params }) => {
        const { id } = params;
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = patchSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
        }
        const { speakerNames, ...fields } = parsed.data;
        if (fields.folderId) {
          const folder = await getDb()
            .select({ id: folders.id })
            .from(folders)
            .where(and(eq(folders.id, fields.folderId), eq(folders.userId, actor.userId)))
            .limit(1);
          if (folder.length === 0) return Response.json({ error: 'folder not found' }, { status: 404 });
        }
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
        const updated = await meetingsRepo.update(getDb(), { meetingId: id, userId: actor.userId, ...fields, speakerNamesJson });
        if (!updated) return Response.json({ error: 'not found' }, { status: 404 });
        // The cleaned transcript names the title, the project and the speakers.
        if (speakerNames || fields.folderId !== undefined || fields.title !== undefined) {
          refreshAgentTranscriptLater(id, actor.userId, { embed: Boolean(speakerNames) });
        }
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
        const deleted = await meetingsRepo.softDelete(getDb(), { meetingId: id, userId: actor.userId });
        if (!deleted) return Response.json({ error: 'not found' }, { status: 404 });
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
