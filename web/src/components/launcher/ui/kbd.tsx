import { cn } from '@/lib/utils';

export type KbdProps = {
  /** One key ("/"), a combo string ("⌘⇧Space") or explicit caps (['⌘', '⇧', 'Space']). */
  keys: string | string[];
  size?: 'sm' | 'md';
  tone?: 'well' | 'hud';
  className?: string;
};

const MODIFIERS = new Set(['⌘', '⇧', '⌥', '⌃']);

/** Splits "⌘⇧Space" into ["⌘", "⇧", "Space"]. Plain words stay whole. */
export function splitKeys(keys: string | string[]): string[] {
  if (Array.isArray(keys)) return keys;
  const caps: string[] = [];
  let rest = '';
  for (const ch of keys) {
    if (MODIFIERS.has(ch)) {
      if (rest) caps.push(rest);
      rest = '';
      caps.push(ch);
    } else rest += ch;
  }
  if (rest) caps.push(rest);
  return caps;
}

/** Keys as glyphs on little key caps (DESIGN.md §2: never "Fn / Globe tap"). */
export function Kbd({ keys, size = 'sm', tone = 'well', className }: KbdProps) {
  const caps = splitKeys(keys);
  return (
    <span className={cn('ev-kbd', className)} data-size={size} data-tone={tone}>
      {caps.map((key, i) => (
        <kbd key={`${key}-${i}`}>{key}</kbd>
      ))}
    </span>
  );
}
