export const CHIP_SEPARATORS = /[,\n\r\t]/;

/** Splits typed or pasted text on commas, tabs and line breaks. */
export function splitChips(text: string): string[] {
  return text
    .split(CHIP_SEPARATORS)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function hasChipSeparator(text: string): boolean {
  return CHIP_SEPARATORS.test(text);
}

/**
 * Appends new chips to a list: trimmed, capped in length, without
 * case-insensitive duplicates, and never past `max`. Existing chips are kept
 * as they are, even when there are already more than `max`.
 */
export function addChips(
  current: readonly string[],
  incoming: readonly string[],
  { max, maxLength }: { max: number; maxLength: number },
): string[] {
  const seen = new Set(current.map((chip) => chip.toLowerCase()));
  const next = [...current];
  for (const raw of incoming) {
    if (next.length >= max) break;
    const chip = raw.replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
    const key = chip.toLowerCase();
    if (!chip || seen.has(key)) continue;
    seen.add(key);
    next.push(chip);
  }
  return next;
}

export function removeChip(current: readonly string[], chip: string): string[] {
  return current.filter((item) => item !== chip);
}

export function sameChips(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((chip, index) => chip === b[index]);
}
