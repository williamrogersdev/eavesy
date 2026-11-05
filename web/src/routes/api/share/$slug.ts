import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { summaries } from '@/db/schema';
import { type ActionItem, type Decision, decode } from '@/db/codec';
import * as meetingsRepo from '@/db/repo/meetings';

/**
 * Public, read-only notes behind a meeting's share link (`meetings.share_slug`,
 * until `share_expires_at`): the summary, decisions and action items. No
 * transcript, audio or private notes.
 */
export const Route = createFileRoute('/api/share/$slug')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(params.slug)) return Response.json({ error: 'not_found' }, { status: 404 });
        const db = getDb();
        const meeting = await meetingsRepo.getByShareSlug(db, params.slug);
        if (!meeting || meeting.status !== 'complete') return Response.json({ error: 'not_found' }, { status: 404 });
        const summary = (await db.select().from(summaries).where(eq(summaries.meetingId, meeting.id)).limit(1))[0];
        return Response.json({
          title: meeting.title,
          startedAt: meeting.startedAt,
          durationSec: meeting.durationSec,
          summaryMd: meeting.summaryOverrideMd ?? null,
          tldr: summary?.tldr ?? '',
          decisions: decode<Decision[]>(summary?.decisionsJson, []).map((d) => d.text).filter(Boolean),
          actionItems: decode<ActionItem[]>(summary?.actionItemsJson, []).filter((a) => a.text)
            .map((a) => ({ text: a.text, owner: a.owner ?? null, due: a.due ?? null, completed: a.completed === true })),
        }, { headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } });
      },
    },
  },
});
