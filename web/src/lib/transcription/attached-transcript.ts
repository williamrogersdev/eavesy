/**
 * A message Eavesy rewrote for an AI agent carries the whole dictation with
 * it, word for word, so the agent never loses what the rewrite left out. The
 * block's note says plainly that the message above it was rewritten; a
 * message without the block is the words as said.
 */

const TAG = 'eavesy-transcript';

export const ATTACHED_NOTE = 'Eavesy rewrote the message above for an AI agent. This is the full transcript, tidied only by removing filler words and spelling known names.';

const ATTACHED = new RegExp(`\\n*<${TAG}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${TAG}>\\s*$`);

/** `message` with `transcript` attached after it, in a block an agent can tell apart. */
export function attachTranscript(message: string, transcript: string): string {
  if (!transcript.trim()) return message;
  return `${message.trimEnd()}\n\n<${TAG} note="${ATTACHED_NOTE}">\n${escapeTag(transcript.trim())}\n</${TAG}>`;
}

/** The tag said aloud inside a transcript can't close its block early. */
const SPOKEN_TAG = new RegExp(`<(/?${TAG})`, 'g');
const ESCAPED_TAG = new RegExp(`&lt;(/?${TAG})`, 'g');
const escapeTag = (text: string) => text.replace(SPOKEN_TAG, '&lt;$1');
const unescapeTag = (text: string) => text.replace(ESCAPED_TAG, '<$1');

/** A message and the transcript attached to it, when one is. */
export function splitAttached(text: string): { message: string; transcript: string | null } {
  const match = ATTACHED.exec(text);
  if (!match) return { message: text, transcript: null };
  return { message: text.slice(0, match.index).trimEnd(), transcript: unescapeTag(match[1].trim()) };
}

/** Whether `text` is a rewritten message with its transcript attached. */
export function hasAttachedTranscript(text: string): boolean {
  return !!splitAttached(text).transcript;
}

/**
 * What a rewrite starts from: the transcript a message carries when it has
 * one (empty when its block is), never the rewrite above it; otherwise the
 * words as sent.
 */
export function rewriteSource(sent: string): { source: string; carried: boolean } {
  const { transcript } = splitAttached(sent);
  return transcript === null ? { source: sent, carried: false } : { source: transcript, carried: true };
}

/**
 * The words that go out: a prompt for an AI agent the model wrote gets the
 * transcript it came from attached. Plain cleanup, verbatim words and tones
 * for people go out as they are.
 */
export function deliverable(result: { text: string; polished: boolean }, tone: { style: string; forAgents: boolean }, transcript: string): { text: string; reformatted: boolean } {
  const reformatted = result.polished && tone.forAgents && tone.style !== 'verbatim' && !!transcript.trim();
  return { text: reformatted ? attachTranscript(result.text, transcript) : result.text, reformatted };
}
