/** Escapes angle brackets so data can't open or close the tags it's wrapped in. */
export function fence(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
