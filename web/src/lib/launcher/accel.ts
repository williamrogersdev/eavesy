export function prettyAccel(accel: string): string {
  return accel
    .split('+')
    .map((p) => {
      const k = p.trim().toLowerCase();
      if (k === 'cmd' || k === 'command' || k === 'super' || k === 'meta')
        return '⌘';
      if (k === 'shift') return '⇧';
      if (k === 'alt' || k === 'option') return '⌥';
      if (k === 'ctrl' || k === 'control') return '⌃';
      return p.trim().length === 1 ? p.trim().toUpperCase() : p.trim();
    })
    .join('');
}
