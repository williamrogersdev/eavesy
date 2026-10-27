import { isDictationStyle } from '@/lib/transcription/dictation-style';
import { z } from 'zod';
import { PROJECT_LIMITS } from '@/lib/projects';
import { resolveIngestActor } from '@/server/device-auth';

export const projectFieldsSchema = z.object({
  name: z.string().trim().min(1).max(PROJECT_LIMITS.name),
  about: z.string().max(PROJECT_LIMITS.about * 2).nullable().optional(),
  vocabulary: z.array(z.string().max(PROJECT_LIMITS.term * 2)).max(PROJECT_LIMITS.vocabulary * 2).optional(),
  people: z.string().max(PROJECT_LIMITS.people * 2).nullable().optional(),
  match: z.array(z.string().max(PROJECT_LIMITS.term * 2)).max(PROJECT_LIMITS.match * 2).optional(),
  dictationStyle: z.string().refine(isDictationStyle, 'unsupported style').nullable().optional(),
  dictationForAgents: z.boolean().nullable().optional(),
});

/** Signed-in web user or paired desktop. */
export async function projectActor(request: Request) {
  return await resolveIngestActor(request);
}
