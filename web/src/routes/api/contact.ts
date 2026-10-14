import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as contactRepo from '@/db/repo/contact-messages';
import { clientIp, rateLimit } from '@/server/rate-limit';

const ContactSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().email('A valid email is required').max(200),
  topic: z.string().trim().max(80).optional(),
  message: z.string().trim().min(10, 'Message is too short').max(5000),
  company: z.string().max(0).optional(),
});

export const Route = createFileRoute('/api/contact')({
  server: {
    handlers: {
      POST: async ({ request }): Promise<Response> => {
        const limited = await rateLimit({ key: `contact:${clientIp(request)}`, limit: 5, windowSec: 600, failMode: 'closed' });
        if (!limited.allowed) {
          return Response.json(
            { ok: false, error: 'Too many messages. Please try again later.' },
            { status: 429, headers: { 'retry-after': String(limited.retryAfterSec) } },
          );
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
        }

        const parsed = ContactSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' },
            { status: 422 },
          );
        }

        if (parsed.data.company) {
          return Response.json({ ok: true });
        }

        const { name, email, topic, message } = parsed.data;

        try {
          await contactRepo.create(getDb(), { name, email, topic, message });
        } catch (err) {
          console.error('[contact] failed to persist message', err);
          return Response.json(
            { ok: false, error: 'Could not send your message. Please try again.' },
            { status: 500 },
          );
        }

        return Response.json({ ok: true });
      },
    },
  },
});
