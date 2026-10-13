import { auth, clerkClient } from '@clerk/tanstack-react-start/server';
import { getDb } from '@/db/client';
import { ensureClerkUser, getByClerkId } from '@/db/repo/users';
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

export interface ResolvedActor {
  userId: string;
  isAnonymous: boolean;
  clerkUserId?: string;
}

export async function resolveActor(_args?: {
  anonymousSessionToken?: string | null;
}): Promise<ResolvedActor> {
  const db = getDb();

  if (LOCAL_TEST && (await import('@tanstack/react-start/server')).getCookie('eavesy_local_test') === '1') {
    await ensureLocalTestUser(db);
    return { userId: LOCAL_TEST_USER_ID, isAnonymous: false };
  }

  try {
    const { userId: clerkId } = await auth();
    if (clerkId) {
      const existing = await getByClerkId(db, clerkId);
      if (existing && existing.email) {
        return { userId: existing.id, isAnonymous: false, clerkUserId: clerkId };
      }
      const identity = await loadClerkIdentity(clerkId);
      const user = await ensureClerkUser(db, { clerkUserId: clerkId, ...identity });
      return { userId: user.id, isAnonymous: false, clerkUserId: clerkId };
    }
  } catch {
    /* fall through to anonymous */
  }

  throw new Error('not_authenticated');
}

export async function tryResolveActor(args?: {
  anonymousSessionToken?: string | null;
}): Promise<ResolvedActor | null> {
  try {
    return await resolveActor(args);
  } catch {
    return null;
  }
}
