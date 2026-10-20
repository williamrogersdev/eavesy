export interface Project {
  id: string;
  name: string;
  about: string | null;
  vocabulary: string[];
  people: string | null;
  match: string[];
}

export const PROJECT_LIMITS = {
  name: 80,
  about: 600,
  people: 400,
  term: 60,
  vocabulary: 200,
  match: 12,
} as const;


export function parseStringList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? cleanList(parsed.filter((item): item is string => typeof item === 'string')) : [];
  } catch {
    return [];
  }
}

/** Trims, drops blanks and case-insensitive duplicates, keeps the first spelling. */
export function cleanList(items: string[], maxItems: number = PROJECT_LIMITS.vocabulary): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim().replace(/\s+/g, ' ').slice(0, PROJECT_LIMITS.term);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

export interface FrontWindow {
  app: string | null;
  title: string | null;
}

function containsTerm(haystack: string, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return false;
  const text = haystack.toLowerCase();
  let from = 0;
  while (true) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + needle.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

/**
 * The project whose match terms (or, with none set, its name) appear as a
 * whole word in the front window's title or app name. The longest matching
 * term wins, so "eavesy-desktop" beats "eavesy".
 */
export function matchProject<T extends Pick<Project, 'name' | 'match'>>(
  projects: T[],
  front: FrontWindow | null | undefined,
): T | null {
  if (!front) return null;
  const haystacks = [front.title, front.app].filter((value): value is string => Boolean(value?.trim()));
  if (haystacks.length === 0) return null;
  let best: { project: T; length: number } | null = null;
  for (const project of projects) {
    const terms = project.match.length > 0 ? project.match : [project.name];
    for (const term of terms) {
      if (!haystacks.some((haystack) => containsTerm(haystack, term))) continue;
      if (!best || term.length > best.length) best = { project, length: term.length };
    }
  }
  return best?.project ?? null;
}

/**
 * The words a project wants spelled right: its vocabulary, then the names in
 * its people line. Transcription puts them ahead of the user's own words.
 */
export function projectTerms(project: Pick<Project, 'vocabulary' | 'people'> | null | undefined): string[] {
  return [...(project?.vocabulary ?? []), ...namesIn(project?.people)];
}

/**
 * The one list of words the editor shows: the vocabulary, then the names from
 * an older people line that are not already in it.
 */
export function projectWords(project: Pick<Project, 'vocabulary' | 'people'>): string[] {
  return cleanList(projectTerms(project), Number.MAX_SAFE_INTEGER);
}

/**
 * Stores edited words as vocabulary and retires the old people line, whose
 * names the editor already shows as words. The editor holds to the limit.
 */
export function wordsToFields(words: string[]): Pick<Project, 'vocabulary' | 'people'> {
  return { vocabulary: cleanList(words, PROJECT_LIMITS.vocabulary), people: null };
}

function namesIn(people: string | null | undefined): string[] {
  if (!people) return [];
  return people
    .split(/[,;\n]/)
    .map((entry) => entry.replace(/\(.*?\)/g, '').trim())
    .filter((entry) => entry.length > 0 && entry.length <= 40);
}

/** Ground truth about the project for summaries and transcript cleanup. */
export function projectContext(project: Project | null | undefined): string {
  if (!project) return '';
  const lines = [`Project: ${project.name}`];
  if (project.about?.trim()) lines.push(`About: ${project.about.trim()}`);
  if (project.people?.trim()) lines.push(`People: ${project.people.trim()}`);
  if (project.vocabulary.length > 0) lines.push(`Terms (spell exactly like this): ${project.vocabulary.join(', ')}`);
  return lines.join('\n');
}

export function combinedContext(
  contextBlurb: string | null | undefined,
  project: Project | null | undefined,
  userVocabulary: readonly string[] = [],
) {
  const words = userVocabulary.length > 0 ? `More terms (spell exactly like this): ${userVocabulary.join(', ')}` : '';
  const parts = [projectContext(project), words, contextBlurb?.trim() ?? ''].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}
