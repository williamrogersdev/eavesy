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
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsedBody = createSchema.safeParse(await request.json().catch(() => null));
        if (!parsedBody.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const body = parsedBody.data;
        try {
          const id = await templatesRepo.create(getDb(), { userId: actor.userId, ...body });
          return Response.json({ id });
        } catch (error) {
          if (error instanceof templatesRepo.TooManyTemplates) {
            return Response.json(
              { error: 'too_many_templates', message: `You can keep up to ${templatesRepo.TEMPLATE_LIMIT} templates. Delete one to add another.` },
              { status: 409 },
            );
          }
          throw error;
        }
      },

      PATCH: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsedBody = updateSchema.safeParse(await request.json().catch(() => null));
        if (!parsedBody.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const body = parsedBody.data;
        await templatesRepo.update(getDb(), { userId: actor.userId, ...body });
        return Response.json({ ok: true });
      },

      DELETE: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const url = new URL(request.url);
        const id = url.searchParams.get('id');
        if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
        await templatesRepo.remove(getDb(), { id, userId: actor.userId });
        return Response.json({ ok: true });
      },
    },
  },
});
