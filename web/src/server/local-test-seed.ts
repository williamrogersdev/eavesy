import { eq } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { captures, dictations, meetings, summaries, transcriptSegments, userNotes, users } from '@/db/schema';

export const LOCAL_TEST_USER_ID = 'user_local_test';
const HOUR = 3_600_000;

let seeded: Promise<void> | null = null;

export function ensureLocalTestUser(db: AppDb): Promise<void> {
  seeded ??= seed(db).catch((error: unknown) => {
    seeded = null;
    throw error;
  });
  return seeded;
}

async function seed(db: AppDb) {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.id, LOCAL_TEST_USER_ID)).limit(1);
  if (existing[0]) return;
  const now = Date.now();
  await db.insert(users).values({
    id: LOCAL_TEST_USER_ID,
    email: 'test@eavesy.local',
    displayName: 'Local Tester',
    defaultTranscriptionEngine: 'whisper',
    defaultLanguage: 'en',
    isAnonymous: false,
    onboardingCompletedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const meeting = (id: string, title: string, at: number, status: 'complete' | 'processing' | 'failed', durationSec: number) => ({
    id,
    userId: LOCAL_TEST_USER_ID,
    title,
    startedAt: at,
    endedAt: at + durationSec * 1000,
    durationSec,
    source: 'desktop' as const,
    status,
    statusError: status === 'failed' ? 'Transcription failed: the audio file was empty.' : null,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(meetings).values([
    meeting('mtg_local_complete', 'Launch review with Sarah', now - 2 * HOUR, 'complete', 1834),
    meeting('mtg_local_processing', 'Standup', now - 0.2 * HOUR, 'processing', 640),
    meeting('mtg_local_failed', 'Call with the design agency', now - 30 * HOUR, 'failed', 95),
  ]);
  await db.insert(summaries).values({
    id: 'sum_local_complete',
    meetingId: 'mtg_local_complete',
    tldr: 'Agreed to keep the beta open and ship the new onboarding flow in November.',
    decisionsJson: JSON.stringify([{ text: 'Onboarding ships in November.' }, { text: 'No length limit during the beta.' }]),
    actionItemsJson: JSON.stringify([
      { text: 'Draft the launch announcement', owner: 'Sarah', due: 'Friday', completed: false },
      { text: 'Finish the onboarding flow', owner: 'Will', completed: true },
    ]),
    openQuestionsJson: JSON.stringify([{ text: 'Do we need a staged rollout?' }]),
    chaptersJson: JSON.stringify([{ startMs: 0, title: 'Beta scope' }, { startMs: 60_000, title: 'Launch date' }]),
    generatedByModel: 'local-test',
    generatedAt: now,
  });
  const lines = [
    ['you', 'Let’s settle the free tier first. I don’t want a length cap.', 'en'],
    ['them', 'De acuerdo. La gente llega al límite a mitad de la reunión y es horrible.', 'es'],
    ['you', 'Then Pro is about volume and team features, not length.', 'en'],
    ['them', 'Doce dólares al mes me parece bien para eso.', 'es'],
  ] as const;
  await db.insert(transcriptSegments).values(
    lines.map(([speakerId, text, language], i) => ({
      id: `seg_local_${i}`,
      meetingId: 'mtg_local_complete',
      startMs: i * 30_000,
      endMs: i * 30_000 + 25_000,
      speakerId,
      text,
      language,
    })),
  );
  await db.insert(userNotes).values({ meetingId: 'mtg_local_complete', contentMd: 'Check the launch budget with finance.', updatedAt: now });
  await db.insert(captures).values({
    id: 'cap_local_screenshot',
    userId: LOCAL_TEST_USER_ID,
    kind: 'image',
    captureMode: 'screenshot',
    source: 'desktop',
    title: 'Checkout error',
    r2Key: 'local-test/missing.png',
    contentType: 'image/png',
    bytes: 182_000,
    width: 1440,
    height: 900,
    transcript: 'The checkout page shows “Your card was declined.” under the pay button.',
    transcriptStatus: 'complete',
    createdAt: now - 26 * HOUR,
    updatedAt: now - 26 * HOUR,
  });
  await db.insert(dictations).values({
    id: 'dic_local_1',
    userId: LOCAL_TEST_USER_ID,
    title: 'Reply to Sarah',
    transcript: 'thanks sarah lets go with the november date and revisit the rollout next week',
    cleanedText: 'Thanks Sarah, let’s go with the November date and revisit the rollout next week.',
    durationSec: 9,
    createdAt: now - 3 * HOUR,
  });
}
