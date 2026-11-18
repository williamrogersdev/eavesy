/**
 * A message Eavesy rewrote for an AI agent carries the whole dictation with
 * it, word for word, so the agent never loses what the rewrite left out. The
 * block's note says plainly that the message above it was rewritten; a
 * message without the block is the words as said.
 */

const TAG = 'eavesy-transcript';

export const ATTACHED_NOTE = 'Eavesy rewrote the message above for an AI agent. This is the full transcript, as said.';

const ATTACHED = new RegExp(`\\n*<${TAG}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${TAG}>\\s*$`);

/** `message` with `transcript` attached after it, in a block an agent can tell apart. */
export function attachTranscript(message: string, transcript: string): string {
  return `${message.trimEnd()}\n\n<${TAG} note="${ATTACHED_NOTE}">\n${transcript.trim()}\n</${TAG}>`;
}

/** A message and the transcript attached to it, when one is. */
export function splitAttached(text: string): { message: string; transcript: string | null } {
  const match = ATTACHED.exec(text);
  if (!match) return { message: text, transcript: null };
  return { message: text.slice(0, match.index).trimEnd(), transcript: match[1].trim() || null };
}

/** Whether `text` is a rewritten message with its transcript attached. */
export function hasAttachedTranscript(text: string): boolean {
  return splitAttached(text).transcript !== null;
}
