export interface TocItem {
  depth: 2 | 3;
  text: string;
  id: string;
}

function stripInline(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim();
}

const PUNCTUATION =
  /[\u2000-\u206f\u2e00-\u2e7f\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g;

function slugify(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().replace(PUNCTUATION, '').replace(/ /g, '-');
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

export function extractToc(source: string): TocItem[] {
  const seen = new Map<string, number>();
  const items: TocItem[] = [];
  let inFence = false;

  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{2,3})\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;

    const depth = match[1].length as 2 | 3;
    const text = stripInline(match[2]);
    if (!text) continue;
    items.push({ depth, text, id: slugify(text, seen) });
  }

  return items;
}
