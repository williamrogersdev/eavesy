/**
 * A `?limit=` value as a whole number between 1 and `max`. Missing, zero,
 * negative or non-numeric input falls back to `fallback`, so `LIMIT -1` (no
 * limit in SQLite) or `NaN` never reaches a query.
 */
export function clampLimit(value: string | null | undefined, fallback: number, max: number): number {
  const parsed = Math.floor(Number(value));
  const n = Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
  return Math.min(Math.max(n, 1), max);
}
