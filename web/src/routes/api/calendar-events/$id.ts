import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { resolveIngestActor } from '@/server/device-auth';
import { waitUntil } from 'cloudflare:workers';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { reconcileCalendarBots } from '@/server/meeting-bots/calendar-plan';
import type { MeetingBotsEnv } from '@/server/meeting-bots/control';
import { botsAvailable } from '@/server/meeting-bots/service';

// `captureMode` from current apps; `recordChoice` from Mac apps from before capture modes.
const patchSchema = z.union([
  z.object({ captureMode: z.enum(['mac', 'notetaker', 'both', 'skip']).nullable() }),
  z.object({ recordChoice: z.enum(['record', 'skip']).nullable() }),
]);

// How to capture one meeting: on the Mac, with the Notetaker, both, or not at
// all; null follows the account default. On the Mac, even `mac` only starts
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
        const db = getDb();
        const found = 'captureMode' in parsed.data
          ? await calendarRepo.setCaptureMode(db, actor.userId, params.id, parsed.data.captureMode)
          : await calendarRepo.setRecordChoice(db, actor.userId, params.id, parsed.data.recordChoice);
        if (!found) return Response.json({ error: 'not_found' }, { status: 404 });
        // Send or withdraw the Notetaker for this meeting right away, not at the next sync.
        const botEnv = getCloudflareContext<MeetingBotsEnv>().env;
        if (botsAvailable(botEnv)) waitUntil(reconcileCalendarBots(db, botEnv, actor.userId).catch((error: unknown) => console.error('[calendar-events] notetaker plan', error)));
        return Response.json('captureMode' in parsed.data
          ? { id: params.id, captureMode: parsed.data.captureMode }
          : { id: params.id, recordChoice: parsed.data.recordChoice });
      },
    },
  },
});
