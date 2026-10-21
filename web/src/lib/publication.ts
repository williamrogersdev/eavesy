/** Shared publication policy for lists, direct routes, and sitemap entries. */
export function isPublished(
  metadata: { draft?: boolean; date?: string },
  now = Date.now(),
): boolean {
  if (metadata.draft) return false;
  if (!metadata.date) return true;
  const publishedAt = Date.parse(metadata.date);
  return Number.isFinite(publishedAt) && publishedAt <= now;
}
