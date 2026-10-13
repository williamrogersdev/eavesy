import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as templatesRepo from '@/db/repo/templates';
import { resolveActor } from '@/server/auth';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  systemPrompt: z.string().min(1).max(8000),
  description: z.string().max(500).optional(),
  hotkey: z.string().max(50).optional(),
  appliesTo: z.enum(['dictation', 'meeting', 'both']),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const updateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  systemPrompt: z.string().min(1).max(8000).optional(),
  description: z.string().max(500).nullable().optional(),
  hotkey: z.string().max(50).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export const Route = createFileRoute('/api/templates')({
  server: {
    handlers: {
      GET: async () => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const items = await templatesRepo.listForUser(getDb(), actor.userId);
        return Response.json({ items });
      },

      POST: async ({ request }) => {
        const body = createSchema.parse(await request.json());
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const id = await templatesRepo.create(getDb(), { userId: actor.userId, ...body });
        return Response.json({ id });
      },

      PATCH: async ({ request }) => {
        const body = updateSchema.parse(await request.json());
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        await templatesRepo.update(getDb(), { userId: actor.userId, ...body });
        return Response.json({ ok: true });
      },

      DELETE: async ({ request }) => {
        const url = new URL(request.url);
        const id = url.searchParams.get('id');
        if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        await templatesRepo.remove(getDb(), { id, userId: actor.userId });
        return Response.json({ ok: true });
      },
    },
  },
});
