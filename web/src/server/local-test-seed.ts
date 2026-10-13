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
    meeting('mtg_local_complete', 'Pricing review with Sarah', now - 2 * HOUR, 'complete', 1834),
    meeting('mtg_local_processing', 'Standup', now - 0.2 * HOUR, 'processing', 640),
    meeting('mtg_local_failed', 'Call with the design agency', now - 30 * HOUR, 'failed', 95),
  ]);
  await db.insert(summaries).values({
    id: 'sum_local_complete',
    meetingId: 'mtg_local_complete',
    tldr: 'Agreed to keep the free tier unlimited and launch Pro at $12/month in November.',
    decisionsJson: JSON.stringify([{ text: 'Pro launches at $12/month.' }, { text: 'No length limit on the free tier.' }]),
    actionItemsJson: JSON.stringify([
      { text: 'Draft the pricing page copy', owner: 'Sarah', due: 'Friday', completed: false },
      { text: 'Wire up Stripe checkout', owner: 'Will', completed: true },
    ]),
    openQuestionsJson: JSON.stringify([{ text: 'Do we offer an annual discount?' }]),
    chaptersJson: JSON.stringify([{ startMs: 0, title: 'Free tier' }, { startMs: 60_000, title: 'Pro price' }]),
    generatedByModel: 'local-test',
    generatedAt: now,
  });
  const lines = [
    ['you', 'Let’s settle the free tier first. I don’t want a length cap.'],
    ['them', 'Agreed. People hit the cap mid-meeting and it feels terrible.'],
    ['you', 'Then Pro is about volume and team features, not length.'],
    ['them', 'Twelve dollars a month feels right for that.'],
  ] as const;
  await db.insert(transcriptSegments).values(
    lines.map(([speakerId, text], i) => ({
      id: `seg_local_${i}`,
      meetingId: 'mtg_local_complete',
      startMs: i * 30_000,
      endMs: i * 30_000 + 25_000,
      speakerId,
      text,
    })),
  );
  await db.insert(userNotes).values({ meetingId: 'mtg_local_complete', contentMd: 'Check annual pricing with finance.', updatedAt: now });
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
    transcript: 'Stripe checkout shows “Your card was declined.” under the pay button.',
    transcriptStatus: 'complete',
    createdAt: now - 26 * HOUR,
    updatedAt: now - 26 * HOUR,
  });
  await db.insert(dictations).values({
    id: 'dic_local_1',
    userId: LOCAL_TEST_USER_ID,
    title: 'Reply to Sarah',
    transcript: 'thanks sarah lets go with twelve a month and revisit annual next week',
    cleanedText: 'Thanks Sarah, let’s go with $12 a month and revisit annual pricing next week.',
    durationSec: 9,
    createdAt: now - 3 * HOUR,
  });
}
