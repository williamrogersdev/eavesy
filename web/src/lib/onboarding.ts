import { appReturnPath } from '@/lib/auth-return';
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

/**
 * The project field after a change: names finished with a comma become
 * projects and the text after the last comma stays as the draft. With
 * `finish`, the whole draft is taken, as on Enter, blur or submit.
 */
export function takeProjectDraft(
  projects: readonly string[],
  draft: string,
  finish = false,
): { projects: string[]; draft: string } {
  const cut = finish ? draft.length : draft.lastIndexOf(',');
  if (cut < 0) return { projects: [...projects], draft };
  const added = newProjectNames(draft.slice(0, cut).split(','), projects);
  return {
    projects: [...projects, ...added].slice(0, MAX_ONBOARDING_PROJECTS),
    draft: finish ? '' : draft.slice(cut + 1).trimStart(),
  };
}

/** Where someone new lands after setup: their first recording. */
export const FIRST_RUN_PATH = '/app/record?first=1';

/**
 * Where to go once setup is done. A plain `/app` is the default every sign-up
 * returns to, not a page anyone asked for, so it leads to the first recording
 * instead; a real destination (an invitation, a Mac waiting to pair) is kept.
 */
export function afterOnboardingPath(redirectUrl: unknown): string {
  const target = appReturnPath(redirectUrl, FIRST_RUN_PATH);
  return target === '/app' || target === '/app/' ? FIRST_RUN_PATH : target;
}
