import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { resolveIngestActor } from '@/server/device-auth';

const patchSchema = z.object({ recordChoice: z.enum(['record', 'skip']).nullable() });

// Whether to record one meeting: `record` or `skip` it, or null to follow the
// Mac's "Record my meetings automatically" setting. Even `record` only starts
// the countdown prompt when the call begins; nothing records unseen.
export const Route = createFileRoute('/api/calendar-events/$id')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = patchSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success || params.id.length > 100) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const found = await calendarRepo.setRecordChoice(getDb(), actor.userId, params.id, parsed.data.recordChoice);
        if (!found) return Response.json({ error: 'not_found' }, { status: 404 });
        return Response.json({ id: params.id, recordChoice: parsed.data.recordChoice });
      },
    },
  },
});
