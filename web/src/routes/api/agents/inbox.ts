import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveIngestActor } from '@/server/device-auth';
import { pollForDevice } from '@/server/agent-inbox';

/**
 * A Mac with agent messages on asks for what agents sent through the remote
 * MCP (`send_to_human`, `ask_human`). Device tokens only: a message goes to one
 * Mac, which shows and speaks it.
 */
export const Route = createFileRoute('/api/agents/inbox')({ server: { handlers: {
  POST: async ({ request }) => {
    const actor = await resolveIngestActor(request).catch(() => null);
    if (!actor?.deviceId) return Response.json({ error: 'Connect this Mac to your Eavesy account first.' }, { status: 401 });
    return Response.json(await pollForDevice(getDb(), actor.userId, actor.deviceId));
  },
} } });
