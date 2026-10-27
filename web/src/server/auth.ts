import { auth, clerkClient } from '@clerk/tanstack-react-start/server';
import { timeSpan } from '@/server/perf';
import { getDb } from '@/db/client';
import { ensureClerkUser, getByClerkId } from '@/db/repo/users';
import type { users } from '@/db/schema';
import { LOCAL_TEST } from '@/lib/local-test';
import { ensureLocalTestUser, LOCAL_TEST_USER_ID } from '@/server/local-test-seed';

async function loadClerkIdentity(clerkId: string): Promise<{
  email?: string;
  displayName?: string;
  phoneNumber?: string;
}> {
  try {
    const client = clerkClient();
    const u = await client.users.getUser(clerkId);
    if (!u) return {};
    const primaryEmail = u.emailAddresses?.find(
      (e) => e.id === u.primaryEmailAddressId,
    )?.emailAddress;
    const email = primaryEmail ?? u.emailAddresses?.[0]?.emailAddress ?? undefined;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    const displayName = name || u.username || undefined;
    const primaryPhone = u.phoneNumbers?.find(
      (p) => p.id === u.primaryPhoneNumberId,
    )?.phoneNumber;
    const phoneNumber = primaryPhone ?? u.phoneNumbers?.[0]?.phoneNumber ?? undefined;
    return { email, displayName, phoneNumber };
  } catch {
    return {};
  }
}

const IDENTITY_RETRY_MS = 10 * 60 * 1000;
const IDENTITY_RETRY_MAX_ENTRIES = 1000;
const identityTriedAt = new Map<string, number>();

/** True when this isolate hasn't asked Clerk about `clerkId` recently; records the attempt. */
function shouldRetryIdentity(clerkId: string, now = Date.now()): boolean {
  const last = identityTriedAt.get(clerkId);
  if (last !== undefined && now - last < IDENTITY_RETRY_MS) return false;
  if (identityTriedAt.size >= IDENTITY_RETRY_MAX_ENTRIES) identityTriedAt.clear();
  identityTriedAt.set(clerkId, now);
  return true;
}

export interface ResolvedActor {
  userId: string;
  /** Always false: anonymous sessions were retired; kept for callers that build R2 keys. */
  isAnonymous: false;
  clerkUserId?: string;
  user?: typeof users.$inferSelect;
}

export async function resolveActor(): Promise<ResolvedActor> {
  const db = getDb();

  if (LOCAL_TEST && (await import('@tanstack/react-start/server')).getCookie('eavesy_local_test') === '1') {
    await ensureLocalTestUser(db);
    return { userId: LOCAL_TEST_USER_ID, isAnonymous: false };
  }

  try {
    const { userId: clerkId } = await timeSpan('auth', () => auth());
    if (clerkId) {
      const existing = await getByClerkId(db, clerkId);
      // A known user is resolved from D1 alone. Clerk is asked again only to
      // fill in a missing email, and then at most once per isolate per
      // IDENTITY_RETRY_MS, so an account without an email doesn't call
      // Clerk's API on every request.
      if (existing && (existing.email || !shouldRetryIdentity(clerkId))) {
        return { userId: existing.id, isAnonymous: false, clerkUserId: clerkId, user: existing };
      }
      const identity = await loadClerkIdentity(clerkId);
      const user = await ensureClerkUser(db, { clerkUserId: clerkId, ...identity });
      return { userId: user.id, isAnonymous: false, clerkUserId: clerkId, user };
    }
  } catch {
    /* fall through to not authenticated */
  }

  throw new Error('not_authenticated');
}

export async function tryResolveActor(): Promise<ResolvedActor | null> {
  try {
    return await resolveActor();
  } catch {
    return null;
  }
}
