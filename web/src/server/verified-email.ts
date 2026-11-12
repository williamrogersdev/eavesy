interface ClerkEmail {
  id: string;
  emailAddress: string;
  verification?: { status?: string | null } | null;
}

/**
 * The address to store for an account: its primary one, else the first other, and
 * only ever one the sign-in provider verified. Team invitations are handed to
 * whoever holds the invited address, so an unproven one must never be stored.
 */
export function verifiedEmail(addresses: readonly ClerkEmail[] | null | undefined, primaryId: string | null | undefined): string | undefined {
  const verified = (addresses ?? []).filter((e) => e.verification?.status === 'verified');
  return (verified.find((e) => e.id === primaryId) ?? verified[0])?.emailAddress;
}
