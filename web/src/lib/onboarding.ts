import { PROJECT_LIMITS } from '@/lib/projects';

/** Enough for the few things someone is working on now; more come later from the app. */
export const MAX_ONBOARDING_PROJECTS = 5;

/** Project names without blanks or case-insensitive repeats, against each other and what exists. */
export function newProjectNames(names: readonly string[], existing: readonly string[]): string[] {
  const seen = new Set(existing.map((name) => name.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, ' ').slice(0, PROJECT_LIMITS.name);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_ONBOARDING_PROJECTS) break;
  }
  return out;
}
