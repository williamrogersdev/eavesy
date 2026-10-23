import { createFileRoute } from '@tanstack/react-router';
import { resolveActor } from '@/server/auth';
import { issueLiveTicket } from '@/server/drops-hub';

// Mints a one-time ticket the browser trades for a live WebSocket at
// /api/drops/live (see DropsHub).
export const Route = createFileRoute('/api/drops/ticket')({
  server: {
    handlers: {
      POST: async () => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const ticket = await issueLiveTicket(actor.userId);
        return Response.json({ userId: actor.userId, ticket }, { headers: { 'cache-control': 'no-store' } });
      },
    },
  },
});
