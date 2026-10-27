import { createFileRoute } from '@tanstack/react-router';
import { clampLimit } from '@/lib/http/clamp-limit';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as dropsRepo from '@/db/repo/drops';
import { resolveActor } from '@/server/auth';
import { createTextDrop, DropTooLargeError } from '@/server/create-drop';
import { deviceLabelFrom, MAX_TEXT_BYTES, originFrom, toDto } from '@/server/drops';
import { guardUserQuota } from '@/server/rate-limit';

const textSchema = z.object({ text: z.string().min(1) });

export const Route = createFileRoute('/api/drops')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const limit = clampLimit(new URL(request.url).searchParams.get('limit'), 50, 100);
        const rows = await dropsRepo.listForUser(getDb(), { userId: actor.userId, limit });
        return Response.json({ items: rows.map((row) => toDto(row)) });
      },

      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const declared = Number(request.headers.get('content-length') ?? '0');
        if (declared > MAX_TEXT_BYTES * 1.1) return Response.json({ error: 'text too large' }, { status: 413 });
        const parsed = textSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'missing text' }, { status: 400 });

        const overQuota = await guardUserQuota(actor.userId, 'drop');
        if (overQuota) return overQuota;

        let drop;
        try {
          drop = await createTextDrop(getDb(), {
            userId: actor.userId,
            text: parsed.data.text,
            deviceLabel: deviceLabelFrom(request),
            origin: originFrom(request),
          });
        } catch (error) {
          if (error instanceof DropTooLargeError) return Response.json({ error: 'text too large' }, { status: 413 });
          throw error;
        }
        return Response.json({ drop }, { status: 201 });
      },
    },
  },
});
