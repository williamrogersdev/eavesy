import { openUserKeys, sealSecret } from '@/server/secret-box';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { users } from '../schema';

export async function ensureClerkUser(
  db: AppDb,
  args: { clerkUserId: string; email?: string; displayName?: string; phoneNumber?: string },
): Promise<typeof users.$inferSelect> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, args.clerkUserId))
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    const next = {
      email: existing[0].email ?? args.email ?? null,
      displayName: existing[0].displayName ?? args.displayName ?? null,
      phoneNumber: existing[0].phoneNumber ?? args.phoneNumber ?? null,
    };
    const changed =
      next.email !== existing[0].email ||
      next.displayName !== existing[0].displayName ||
      next.phoneNumber !== existing[0].phoneNumber;
    if (changed) {
      await db.update(users).set({ ...next, updatedAt: now }).where(eq(users.id, existing[0].id));
      return { ...existing[0], ...next, updatedAt: now };
    }
    return existing[0];
  }
  const id = pid('user');
  await db.insert(users).values({
    id,
    clerkUserId: args.clerkUserId,
    email: args.email,
    displayName: args.displayName,
    phoneNumber: args.phoneNumber,
    defaultTranscriptionEngine: 'whisper',
    defaultLanguage: 'en',
    isAnonymous: false,
    createdAt: now,
    updatedAt: now,
  });
  return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
}

export async function ensureAnonymousUser(
  db: AppDb,
  sessionToken: string,
): Promise<typeof users.$inferSelect> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.anonymousSessionToken, sessionToken))
    .limit(1);
  if (existing[0]) return existing[0];

  const id = pid('user');
  const now = Date.now();
  await db.insert(users).values({
    id,
    anonymousSessionToken: sessionToken,
    defaultTranscriptionEngine: 'whisper',
    defaultLanguage: 'en',
    isAnonymous: true,
    createdAt: now,
    updatedAt: now,
  });
  return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
}

export async function getByClerkId(db: AppDb, clerkUserId: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getByAnonymousToken(db: AppDb, token: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.anonymousSessionToken, token))
    .limit(1);
  return rows[0] ?? null;
}

export async function upgradeAnonymous(
  db: AppDb,
  args: { anonymousSessionToken: string; clerkUserId: string; email?: string },
): Promise<string | null> {
  const anon = await getByAnonymousToken(db, args.anonymousSessionToken);
  if (!anon || !anon.isAnonymous) return null;

  const existing = await getByClerkId(db, args.clerkUserId);
  const now = Date.now();

  if (!existing) {
    await db
      .update(users)
      .set({
        clerkUserId: args.clerkUserId,
        email: args.email,
        isAnonymous: false,
        anonymousSessionToken: null,
        updatedAt: now,
      })
      .where(eq(users.id, anon.id));
    return anon.id;
  }

  const { meetings: meetingsTbl } = await import('../schema');
  const { dictations: dictationsTbl } = await import('../schema');
  await db
    .update(meetingsTbl)
    .set({ userId: existing.id, expiresAt: null, updatedAt: now })
    .where(eq(meetingsTbl.userId, anon.id));
  await db.update(dictationsTbl).set({ userId: existing.id }).where(eq(dictationsTbl.userId, anon.id));
  await db.delete(users).where(eq(users.id, anon.id));
  return existing.id;
}

export async function updateByoKeys(
  db: AppDb,
  userId: string,
  args: { anthropicKey?: string | null; deepgramKey?: string | null },
) {
  const patch: Partial<typeof users.$inferInsert> = { updatedAt: Date.now() };
  if (args.anthropicKey !== undefined) patch.byoAnthropicKey = await sealSecret(args.anthropicKey);
  if (args.deepgramKey !== undefined) patch.byoDeepgramKey = await sealSecret(args.deepgramKey);
  await db.update(users).set(patch).where(eq(users.id, userId));
}

export async function setOpenRouterPkceVerifier(
  db: AppDb,
  userId: string,
  verifier: string,
) {
  await db
    .update(users)
    .set({ openRouterPkceVerifier: verifier, updatedAt: Date.now() })
    .where(eq(users.id, userId));
}

export async function setOpenRouterConnection(db: AppDb, userId: string, key: string) {
  const now = Date.now();
  await db
    .update(users)
    .set({
      byoOpenRouterKey: await sealSecret(key),
      byoOpenRouterConnectedAt: now,
      openRouterPkceVerifier: null,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
}

export async function clearOpenRouterConnection(db: AppDb, userId: string) {
  await db
    .update(users)
    .set({
      byoOpenRouterKey: null,
      byoOpenRouterConnectedAt: null,
      openRouterPkceVerifier: null,
      updatedAt: Date.now(),
    })
    .where(eq(users.id, userId));
}

export async function updateProfile(
  db: AppDb,
  userId: string,
  args: {
    displayName?: string;
    companyName?: string | null;
    role?: string | null;
    phoneNumber?: string | null;
  },
) {
  const patch: Partial<typeof users.$inferInsert> = { updatedAt: Date.now() };
  if (args.displayName !== undefined) patch.displayName = args.displayName;
  if (args.companyName !== undefined) patch.companyName = args.companyName;
  if (args.role !== undefined) patch.role = args.role;
  if (args.phoneNumber !== undefined) patch.phoneNumber = args.phoneNumber;
  await db.update(users).set(patch).where(eq(users.id, userId));
}

export async function markOnboarded(db: AppDb, userId: string) {
  const now = Date.now();
  await db
    .update(users)
    .set({ onboardingCompletedAt: now, updatedAt: now })
    .where(eq(users.id, userId));
}

export async function getById(db: AppDb, userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ? openUserKeys(rows[0]) : null;
}
