/** "Cmd+Shift+D" → "⌘⇧D"; fn on its own → "fn"; fn with a key → "fn Space". */
export function prettyAccel(accel: string): string {
  const caps = accel
    .split('+')
    .map((p) => {
      const k = p.trim().toLowerCase();
      if (k === 'cmd' || k === 'command' || k === 'super' || k === 'meta')
        return '⌘';
      if (k === 'shift') return '⇧';
      if (k === 'alt' || k === 'option') return '⌥';
      if (k === 'ctrl' || k === 'control') return '⌃';
      if (k === 'fn') return 'fn';
      return p.trim().length === 1 ? p.trim().toUpperCase() : p.trim();
    });
  if (caps[0] === 'fn' && caps.length > 1) return `fn ${caps.slice(1).join('')}`;
  return caps.join('');
}
