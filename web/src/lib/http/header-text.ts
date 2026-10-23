/** A header value percent-decoded, printable characters only, at most 200 of them. */
export function headerText(raw: string | null): string {
  let value = raw ?? '';
  try {
    value = decodeURIComponent(value);
  } catch {
    // Not percent-encoded; use it as-is.
  }
  return value
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 200);
}
