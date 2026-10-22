import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { devices, users } from '@/db/schema';
import * as activityRepo from '@/db/repo/activity';
import * as usersRepo from '@/db/repo/users';
import {
  AUTO_LANGUAGE,
  isNotesLanguage,
  isTranscriptionLanguage,
  MAX_SPOKEN_LANGUAGES,
  normalizeSpokenLanguages,
  spokenLanguages,
} from '@/lib/transcription/language';
import { dictationStyle, isDictationStyle } from '@/lib/transcription/dictation-style';
import { MAX_TERM_LENGTH, MAX_VOCABULARY_TERMS, normalizeVocabulary, parseVocabulary } from '@/lib/transcription/vocabulary';
import { openUserKeys } from '@/server/secret-box';
import { resolveIngestActor } from '@/server/device-auth';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { type EmailEnv, emailConfigured } from '@/server/email/resend';

/** What the Mac app may change with its device token; the rest needs a web sign-in. */
const MAC_WRITABLE = new Set(['spokenLanguages', 'customVocabulary', 'dictationStyle', 'dictationForAgents']);

const updateSchema = z.object({
  displayName: z.string().max(100).optional(),
  companyName: z.string().max(120).nullable().optional(),
  role: z.string().max(60).nullable().optional(),
  phoneNumber: z.string().max(40).nullable().optional(),
  defaultTranscriptionEngine: z.literal('whisper').optional(),
  defaultLanguage: z.string().refine(isTranscriptionLanguage, 'unsupported language').optional(),
  notesLanguage: z.string().refine(isNotesLanguage, 'unsupported language').nullable().optional(),
  spokenLanguages: z.array(z.string().max(12)).max(MAX_SPOKEN_LANGUAGES * 2).optional(),
  byoAnthropicKey: z.string().max(200).nullable().optional(),
  dictationStyle: z.string().refine(isDictationStyle, 'unsupported style').optional(),
  dictationForAgents: z.boolean().optional(),
  emailRecaps: z.boolean().optional(),
  emailRecapTranscript: z.boolean().optional(),
  customVocabulary: z.array(z.string().max(MAX_TERM_LENGTH * 2)).max(MAX_VOCABULARY_TERMS * 2).optional(),
});

export const Route = createFileRoute('/api/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const [u, [macDevice]] = await Promise.all([
          actor.user ? openUserKeys(actor.user) : usersRepo.getById(db, actor.userId),
          db.batch([
            db
              .select({ id: devices.id })
              .from(devices)
              .where(and(eq(devices.userId, actor.userId), eq(devices.platform, 'macos')))
              .limit(1),
          ]),
        ]);
        if (!u) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          companyName: u.companyName,
          role: u.role,
          phoneNumber: u.phoneNumber,
          isAnonymous: u.isAnonymous,
          onboardingCompleted: !!u.onboardingCompletedAt,
          defaultTranscriptionEngine: 'whisper',
          defaultLanguage: u.defaultLanguage,
          notesLanguage: u.notesLanguage ?? null,
          spokenLanguages: spokenLanguages(u),
          customVocabulary: parseVocabulary(u.customVocabularyJson),
          dictationStyle: dictationStyle(u.dictationStyle),
          dictationForAgents: u.dictationForAgents,
          emailRecaps: u.emailRecaps,
          emailRecapTranscript: u.emailRecapTranscript,
          emailRecapsAvailable: emailConfigured(getCloudflareContext<EmailEnv>().env),
          hasAnthropicKey: !!u.byoAnthropicKey,
          anthropicKeyHint: maskedHint(u.byoAnthropicKey),
          hasOpenRouterKey: !!u.byoOpenRouterKey,
          openRouterConnectedAt: u.byoOpenRouterConnectedAt ?? null,
          hasMac: macDevice.length > 0,
        });
      },

      PATCH: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsedBody = updateSchema.safeParse(await request.json().catch(() => null));
        if (!parsedBody.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const body = parsedBody.data;
        const db = getDb();
        const fromMac = 'deviceId' in actor;
        if (fromMac && Object.keys(body).some((key) => !MAC_WRITABLE.has(key))) {
          return Response.json({ error: 'sign_in_on_web' }, { status: 403 });
        }
        if ('byoAnthropicKey' in body) {
          await usersRepo.updateByoKeys(db, actor.userId, {
            anthropicKey: body.byoAnthropicKey,
          });
        }
        const patch: Partial<typeof users.$inferInsert> = { updatedAt: Date.now() };
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.companyName !== undefined) patch.companyName = body.companyName;
        if (body.role !== undefined) patch.role = body.role;
        if (body.phoneNumber !== undefined) patch.phoneNumber = body.phoneNumber;
        if (body.defaultTranscriptionEngine) patch.defaultTranscriptionEngine = body.defaultTranscriptionEngine;
        if (body.defaultLanguage) patch.defaultLanguage = body.defaultLanguage;
        if (body.notesLanguage !== undefined) patch.notesLanguage = body.notesLanguage;
        if (body.spokenLanguages) {
          const spoken = normalizeSpokenLanguages(body.spokenLanguages);
          patch.spokenLanguagesJson = spoken.length > 0 ? JSON.stringify(spoken) : null;
          patch.defaultLanguage = AUTO_LANGUAGE;
        }
        if (body.dictationStyle) patch.dictationStyle = body.dictationStyle === 'natural' ? null : body.dictationStyle;
        if (body.dictationForAgents !== undefined) patch.dictationForAgents = body.dictationForAgents;
        if (body.emailRecaps !== undefined) {
          // Recaps go to the account's own address, so a guest account has nowhere to send them.
          const [owner] = await db.select({ email: users.email, isAnonymous: users.isAnonymous }).from(users).where(eq(users.id, actor.userId)).limit(1);
          if (body.emailRecaps && (owner?.isAnonymous || !owner?.email)) {
            return Response.json({ error: 'Add an email address to your account to get recaps.' }, { status: 400 });
          }
          patch.emailRecaps = body.emailRecaps;
        }
        if (body.emailRecapTranscript !== undefined) patch.emailRecapTranscript = body.emailRecapTranscript;
        if (body.customVocabulary) {
          const vocabulary = normalizeVocabulary(body.customVocabulary);
          patch.customVocabularyJson = vocabulary.length > 0 ? JSON.stringify(vocabulary) : null;
        }
        await db.update(users).set(patch).where(eq(users.id, actor.userId));
        await activityRepo.log(db, { userId: actor.userId, eventType: 'settings.update' });
        return Response.json({ ok: true });
      },
    },
  },
});

function maskedHint(key: string | null | undefined): string | null {
  if (!key) return null;
  return key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}
