import { createFileRoute } from '@tanstack/react-router';
import { resolveIngestActor } from '@/server/device-auth';
import { issueDeviceLiveTicket } from '@/server/drops-hub';

// Mints a one-time ticket the Mac app trades for a live WebSocket at
// /api/drops/live (see DropsHub), over which it hears at once that a note or
// image was saved on another of the user's devices.
export const Route = createFileRoute('/api/devices/live')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const ticket = await issueDeviceLiveTicket(actor.userId, actor.deviceId);
        return Response.json({ userId: actor.userId, ticket }, { headers: { 'cache-control': 'no-store' } });
      },
    },
  },
});
