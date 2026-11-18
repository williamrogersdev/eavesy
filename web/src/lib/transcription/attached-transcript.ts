/**
 * A message Eavesy rewrote for an AI agent carries the whole dictation with
 * it, word for word, so the agent never loses what the rewrite left out. The
 * block's note says plainly that the message above it was rewritten; a
 * message without the block is the words as said.
 */

const TAG = 'eavesy-transcript';

export const ATTACHED_NOTE = 'Eavesy rewrote the message above for an AI agent. This is the full transcript, tidied only by removing filler words and spelling known names.';

const OPEN = `<${TAG}`;
const CLOSE = `</${TAG}>`;

/** `message` with `transcript` attached after it, in a block an agent can tell apart. */
export function attachTranscript(message: string, transcript: string): string {
  if (!transcript.trim()) return message;
  return `${message.trimEnd()}\n\n<${TAG} note="${ATTACHED_NOTE}">\n${escapeTag(transcript.trim())}\n</${TAG}>`;
}

/**
 * The tag said aloud inside a transcript can't close its block early: a
 * zero-width space goes after its "<", and comes out again when read back.
 * Speech is never written down with one, so nothing said is changed.
 */
const ZWSP = '\u200B';
const SPOKEN_TAG = new RegExp(`<(/?${TAG})`, 'g');
const ESCAPED_TAG = new RegExp(`<${ZWSP}(/?${TAG})`, 'g');
const escapeTag = (text: string) => text.replace(SPOKEN_TAG, `<${ZWSP}$1`);
const unescapeTag = (text: string) => text.replace(ESCAPED_TAG, '<$1');

/**
 * A message and the transcript attached to it, when one is: a block that
 * closes at the very end of the text. Found from the end with plain index
 * lookups, so any text, however long, is read once.
 */
export function splitAttached(text: string): { message: string; transcript: string | null } {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(CLOSE)) return { message: text, transcript: null };
  const closeAt = trimmed.length - CLOSE.length;
  const openAt = trimmed.lastIndexOf(OPEN, closeAt);
  const after = trimmed[openAt + OPEN.length];
  const tagEnd = openAt < 0 || (after !== '>' && !/\s/.test(after ?? '')) ? -1 : trimmed.indexOf('>', openAt);
  if (tagEnd < 0 || tagEnd >= closeAt) return { message: text, transcript: null };
  return { message: trimmed.slice(0, openAt).trimEnd(), transcript: unescapeTag(trimmed.slice(tagEnd + 1, closeAt).trim()) };
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
