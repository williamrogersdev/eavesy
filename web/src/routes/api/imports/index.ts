import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveActor } from '@/server/auth';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { meetings, recordingImports } from '@/db/schema';
import { guardSpend, guardUserQuota } from '@/server/rate-limit';
import { createImport } from '@/server/imports/service';
export const Route = createFileRoute('/api/imports/')({ server: { handlers: {
  GET: async () => {
    let actor;
    try { actor = await resolveActor(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
    const rows = await getDb().select({ meetingId: meetings.id, title: meetings.title, status: meetings.status, state: recordingImports.state, error: meetings.statusError })
      .from(recordingImports).innerJoin(meetings, eq(meetings.id, recordingImports.meetingId))
      .where(and(eq(recordingImports.userId, actor.userId), isNull(meetings.deletedAt))).orderBy(desc(recordingImports.createdAt)).limit(50);
    return Response.json({ imports: rows });
  },
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveActor(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
    if (actor.isAnonymous) return Response.json({ error: 'Sign in to import recordings' }, { status: 403 });
    const quota = await guardUserQuota(actor.userId, 'process');
    if (quota) return quota;
    const limited = await guardSpend(request, 'process', { perMin: 10, perDay: 2000 });
    if (limited) return limited;
    try { return await createImport(getDb(), actor.userId, await request.json()); }
    catch { return Response.json({ error: 'Import could not be created. Please retry.' }, { status: 503 }); }
  },
} } });
