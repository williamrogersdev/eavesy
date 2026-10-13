import { createFileRoute } from '@tanstack/react-router';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { encode } from '@/db/codec';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import * as templatesRepo from '@/db/repo/templates';
import * as usersRepo from '@/db/repo/users';
import { meetings, summaries } from '@/db/schema';
import { MODELS } from '@/lib/ai/client';
import { summarizeMeeting } from '@/lib/ai/summarize';
import { briefFormatPrompt, isBriefFormatId, type BriefFormatId } from '@/lib/brief-formats';
import { guardUserQuota } from '@/server/rate-limit';
import { resolveModelPlan } from '@/lib/providers/router';
import { resolveActor } from '@/server/auth';

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
        const overQuota = await guardUserQuota(actor.userId, 'regenerate');
        if (overQuota) return overQuota;
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

        const transcript = data.meeting.transcriptOverrideMd?.trim()
          || data.segments.map((segment) => segment.text).join('\n').trim();
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

        const user = await usersRepo.getById(db, actor.userId);
        const plan = resolveModelPlan(user);
        let generated;
        try {
          generated = await summarizeMeeting({
            transcript,
            userNotes: data.notes?.contentMd,
            contextBlurb: data.meeting.contextBlurb ?? undefined,
            customTemplatePrompt: templatePrompt,
            openRouter: plan.openRouter,
            byoApiKey: plan.summary.apiKey,
          });
        } catch (error) {
          console.error('[meeting-regenerate] failed', error);
          return Response.json(
            { error: 'regeneration_failed', message: 'Eavesy could not regenerate this brief. Try again.' },
            { status: 502 },
          );
        }

        const now = Date.now();
        const generatedByModel = plan.openRouter
          ? 'openrouter:anthropic/claude-sonnet-4.6'
          : plan.summary.apiKey
            ? `byo-anthropic:${MODELS.summary}`
            : MODELS.summary;
        const values = {
          tldr: generated.tldr,
          decisionsJson: encode(generated.decisions),
          actionItemsJson: encode(generated.actionItems),
          followUpsJson: encode(generated.followUps),
          openQuestionsJson: encode(generated.openQuestions),
          topicsJson: encode(generated.topics),
          mentionsJson: encode(generated.mentions),
          generatedByModel,
          templateId: body.templateId ?? body.format,
          generatedAt: now,
          userEditedAt: null,
        };
        await db
          .insert(summaries)
          .values({ id: `summary_${params.id}`, meetingId: params.id, ...values })
          .onConflictDoUpdate({ target: summaries.meetingId, set: values });
        await db
          .update(meetings)
          .set({
            title: generated.title,
            description: generated.description,
            summaryOverrideMd: null,
            status: 'complete',
            statusError: null,
            updatedAt: now,
          })
          .where(and(eq(meetings.id, params.id), eq(meetings.userId, actor.userId)));
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
