import { createFileRoute } from '@tanstack/react-router';
import { clampLimit } from '@/lib/http/clamp-limit';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { pid } from '@/db/ids';
import * as dropsRepo from '@/db/repo/drops';
import { resolveActor } from '@/server/auth';
import { publish } from '@/server/drops-hub';
import {
  deviceLabelFrom,
  dropKey,
  INLINE_TEXT_MAX_BYTES,
  MAX_TEXT_BYTES,
  originFrom,
  PREVIEW_CHARS,
  toDto,
} from '@/server/drops';
import { putObject } from '@/server/r2';
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

        const text = parsed.data.text;
        const bytes = new TextEncoder().encode(text).byteLength;
        if (bytes > MAX_TEXT_BYTES) return Response.json({ error: 'text too large' }, { status: 413 });

        const id = pid('drp');
        let r2Key: string | null = null;
        if (bytes > INLINE_TEXT_MAX_BYTES) {
          r2Key = dropKey(actor.userId, id, 'text.txt');
          await putObject(r2Key, text, 'text/plain; charset=utf-8');
        }
        const row: dropsRepo.Drop = {
          id,
          userId: actor.userId,
          kind: 'text',
          text: r2Key ? null : text,
          preview: text.slice(0, PREVIEW_CHARS),
          r2Key,
          filename: null,
          contentType: 'text/plain',
          bytes,
          deviceLabel: deviceLabelFrom(request),
          createdAt: Date.now(),
        };
        await dropsRepo.create(getDb(), row);

        const drop = toDto(row);
        await publish(actor.userId, { type: 'drop', drop, origin: originFrom(request) });
        return Response.json({ drop }, { status: 201 });
      },
    },
  },
});
