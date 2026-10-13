export function score(query: string, title: string, body = ''): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = title.toLowerCase();

  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;

  const words = t.split(/[\s—–\-_/]+/);
  if (words.some((w) => w.startsWith(q))) return 600;
  if (t.includes(q)) return 400;

  if (body.toLowerCase().includes(q)) return 150;

  const tokens = q.split(/\s+/);
  if (tokens.length > 1) {
    const hay = `${t} ${body.toLowerCase()}`;
    if (tokens.every((tok) => hay.includes(tok))) return 100;
  }

  return -1;
}
