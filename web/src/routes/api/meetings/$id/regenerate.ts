import { createFileRoute } from '@tanstack/react-router';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import * as projectsRepo from '@/db/repo/projects';
import { upsertSummary } from '@/db/repo/summaries';
import * as templatesRepo from '@/db/repo/templates';
import * as usersRepo from '@/db/repo/users';
import { meetings } from '@/db/schema';
import { speakerNote, summarizeMeeting, summarizeMeetingModel } from '@/lib/ai/summarize';
import { briefFormatPrompt, isBriefFormatId, type BriefFormatId } from '@/lib/brief-formats';
import { combinedContext } from '@/lib/projects';
import { resolveModelPlan } from '@/lib/providers/router';
import { resolveActor } from '@/server/auth';
import { transcriptText } from '@/server/processing/summarize';
import { enqueue } from '@/server/queue';
import { guardUserQuota } from '@/server/rate-limit';

/** Statuses whose brief the pipeline is done with, so a regenerate can't race it. */
const REGENERABLE_STATUSES: meetingsRepo.MeetingStatus[] = ['complete', 'failed'];

const schema = z.object({
  format: z.custom<BriefFormatId>(isBriefFormatId).default('standard'),
  templateId: z.string().min(1).optional(),
});

export const Route = createFileRoute('/api/meetings/$id/regenerate')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = schema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request' }, { status: 400 });
        }
        const body = parsed.data;
        const db = getDb();
        const data = await meetingsRepo.getFull(db, {
          meetingId: params.id,
          userId: actor.userId,
        });
        if (!data) return Response.json({ error: 'not_found' }, { status: 404 });
        // While the meeting is still recording or processing, the pipeline will
        // write the real brief; a brief from the partial transcript would be
        // overwritten at best, or (by marking it complete) stop the final one.
        if (!REGENERABLE_STATUSES.includes(data.meeting.status)) {
          return Response.json(
            { error: 'meeting_in_progress', message: 'Wait for the recording to finish processing before regenerating.' },
            { status: 409 },
          );
        }

        // The same rendering the pipeline summarizes from: lines carry their
        // speaker when the meeting has both sides, and the model is told who
        // the labels are. A transcript the user rewrote by hand wins as is.
        const override = data.meeting.transcriptOverrideMd?.trim();
        const rendered = transcriptText(data.segments, data.meeting.speakerNamesJson);
        const transcript = override || rendered.text.trim();
        if (!transcript) {
          return Response.json(
            { error: 'transcript_not_ready', message: 'A transcript is required before regenerating.' },
            { status: 409 },
          );
        }

        let templatePrompt = briefFormatPrompt(body.format);
        if (body.templateId) {
          const template = await templatesRepo.getForUser(db, {
            id: body.templateId,
            userId: actor.userId,
          });
          if (!template || !['meeting', 'both'].includes(template.appliesTo)) {
            return Response.json({ error: 'template_not_found' }, { status: 404 });
          }
          templatePrompt = template.systemPrompt;
        }

        // Spend the quota only on a request that will actually generate.
        const overQuota = await guardUserQuota(actor.userId, 'regenerate');
        if (overQuota) return overQuota;

        const user = await usersRepo.getById(db, actor.userId);
        const plan = resolveModelPlan(user);
        const project = await projectsRepo.getForMeeting(db, data.meeting);
        let generated;
        try {
          generated = await summarizeMeeting({
            transcript,
            userNotes: data.notes?.contentMd,
            contextBlurb: combinedContext(data.meeting.contextBlurb, project) || undefined,
            speakers: override ? undefined : speakerNote(rendered),
            customTemplatePrompt: templatePrompt,
            openRouter: plan.openRouter,
            byoApiKey: plan.summary.apiKey,
            notesLanguage: user?.notesLanguage,
          });
        } catch (error) {
          console.error('[meeting-regenerate] failed', error);
          return Response.json(
            { error: 'regeneration_failed', message: 'Eavesy could not regenerate this brief. Try again.' },
            { status: 502 },
          );
        }

        const now = Date.now();
        await upsertSummary(db, {
          meetingId: params.id,
          summary: generated,
          generatedByModel: summarizeMeetingModel(plan),
          templateId: body.templateId ?? body.format,
          generatedAt: now,
        });
        const updated = await db
          .update(meetings)
          .set({
            title: generated.title,
            description: generated.description,
            summaryOverrideMd: null,
            // A failed meeting now has a brief; a complete one stays complete.
            // Only those two are touched, so a meeting that went back into
            // processing meanwhile keeps its pipeline status.
            status: 'complete',
            statusError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(meetings.id, params.id),
              eq(meetings.userId, actor.userId),
              inArray(meetings.status, REGENERABLE_STATUSES),
            ),
          )
          .returning({ status: meetings.status });
        if (updated.length) {
          // What follows a new brief, as after the pipeline's own: the search
          // index (the brief changed, and a meeting that was failed never had
          // one) and the cleaned transcript agents paste, rebuilt from scratch
          // because the title and description are part of it.
          await enqueue({ kind: 'embed', meetingId: params.id });
          await enqueue({ kind: 'agent-transcript', meetingId: params.id });
        }
        await activityRepo.log(db, {
          userId: actor.userId,
          eventType: 'meeting.regenerate',
          meetingId: params.id,
          metadata: { format: body.format, custom: Boolean(body.templateId) },
        });
        return Response.json({ ok: true, summary: generated });
      },
    },
  },
});
