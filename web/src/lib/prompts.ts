/**
 * Saved prompts: text the user sends often, pasted from the panel or run as an
 * MCP slash command. No imports: the MCP Worker uses this module directly.
 */

export const PROMPT_LIMITS = { name: 80, slug: 48, body: 20_000, count: 200 } as const;

/** Where a prompt's run-time details go; without one they are added at the end. */
export const DETAILS_SLOT = '{{details}}';

export interface SavedPrompt {
  id: string;
  name: string;
  /** The slash-command name: lowercase words joined by hyphens, unique per account. */
  slug: string;
  body: string;
  useCount: number;
  lastUsedAt: number | null;
  updatedAt: number;
}

/** The MCP server's name in the Eavesy plugin's `.mcp.json`. */
export const MCP_SERVER_NAME = 'eavesy';

/** How Claude Code names an MCP prompt in its slash menu. */
export function claudeCodeCommand(slug: string): string {
  return `/mcp__${MCP_SERVER_NAME}__${slug}`;
}

/** "Debug support tickets!" → "debug-support-tickets". Never empty. */
export function promptSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, PROMPT_LIMITS.slug)
    .replace(/^-+|-+$/g, '');
  return slug || 'prompt';
}

/** `slug`, or `slug-2`, `slug-3`… when another prompt already has it. */
export function freeSlug(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${slug.slice(0, PROMPT_LIMITS.slug - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The prompt as sent: `details` fill its slot, or follow it after a blank line. */
export function fillPrompt(body: string, details?: string | null): string {
  const extra = details?.trim() ?? '';
  if (body.includes(DETAILS_SLOT)) return body.split(DETAILS_SLOT).join(extra).trim();
  return extra ? `${body.trimEnd()}\n\n${extra}` : body;
}

function rank(prompt: SavedPrompt, q: string): number {
  const name = prompt.name.toLowerCase();
  if (prompt.slug === q || name === q) return 1000;
  if (prompt.slug.startsWith(q) || name.startsWith(q)) return 800;
  if (name.split(/[\s\-_/]+/).some((word) => word.startsWith(q))) return 600;
  if (name.includes(q) || prompt.slug.includes(q)) return 400;
  const words = q.split(/\s+/);
  const hay = `${name} ${prompt.body.toLowerCase()}`;
  return words.every((word) => hay.includes(word)) ? 150 : -1;
}

/**
 * The prompts a panel search finds, best first, ties going to the one used most.
 * A query starting with `/` looks only for prompts, and `/` alone lists them all.
 */
export function matchPrompts(prompts: readonly SavedPrompt[], query: string): SavedPrompt[] {
  const q = query.trim().replace(/^\//, '').trim().toLowerCase();
  if (!q) return query.trim().startsWith('/') ? [...prompts].sort(byUse) : [];
  return prompts
    .map((prompt) => ({ prompt, score: rank(prompt, q) }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => b.score - a.score || byUse(a.prompt, b.prompt))
    .map((hit) => hit.prompt);
}

function byUse(a: SavedPrompt, b: SavedPrompt): number {
  return b.useCount - a.useCount || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name);
}

/** Whether a panel search is asking for prompts only. */
export function promptsOnly(query: string): boolean {
  return query.trimStart().startsWith('/');
}

export function parseSavedPrompt(value: unknown): SavedPrompt | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.slug !== 'string' || typeof v.body !== 'string') return null;
  return {
    id: v.id,
    name: v.name,
    slug: v.slug,
    body: v.body,
    useCount: typeof v.useCount === 'number' ? v.useCount : 0,
    lastUsedAt: typeof v.lastUsedAt === 'number' ? v.lastUsedAt : null,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
  };
}
