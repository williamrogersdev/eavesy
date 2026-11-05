/**
 * How a calendar meeting is captured. `mac`: the Mac app records it, with no
 * bot in the call. `notetaker`: the account's Notetaker bot joins and records.
 * `both` ("Full context"): the Mac records the audio and the Notetaker joins
 * for speaker names and chat. `skip`: nothing records it.
 */
export type CaptureMode = 'mac' | 'notetaker' | 'both' | 'skip';
export type CaptureDefault = Exclude<CaptureMode, 'skip'>;

export const CAPTURE_MODES: readonly CaptureMode[] = ['mac', 'notetaker', 'both', 'skip'];
export const CAPTURE_DEFAULTS: readonly CaptureDefault[] = ['mac', 'notetaker', 'both'];

/**
 * The plan for one meeting: its own choice, else the account's default. A
 * meeting the Notetaker can't join (a Zoom call, no link) falls back to the
 * Mac, so a Notetaker default never leaves it unrecorded.
 */
export function effectiveMode(choice: CaptureMode | null | undefined, accountDefault: CaptureDefault, notetakerCanJoin = true): CaptureMode {
  const mode = choice ?? accountDefault;
  return !notetakerCanJoin && wantsNotetaker(mode) ? 'mac' : mode;
}

export function wantsNotetaker(mode: CaptureMode): boolean {
  return mode === 'notetaker' || mode === 'both';
}

/**
 * What a Mac app from before capture modes reads (`recordChoice`): it must
 * stay out of a meeting the Notetaker alone covers, record one chosen for the
 * Mac, and otherwise follow its own "record automatically" setting.
 */
export function legacyRecordChoice(choice: CaptureMode | null, accountDefault: CaptureDefault, notetakerCanJoin = true): 'record' | 'skip' | null {
  const mode = effectiveMode(choice, accountDefault, notetakerCanJoin);
  if (mode === 'skip' || mode === 'notetaker') return 'skip';
  // A Notetaker-only plan the bot can't carry out falls to the Mac: record it.
  return choice || effectiveMode(choice, accountDefault) === 'notetaker' ? 'record' : null;
}

export const MAX_NOTETAKER_NAME = 60;
export const FALLBACK_NOTETAKER_NAME = 'Eavesy Notetaker';

/** A possessive that reads right: "William Rogers' Notetaker", "Sam's Notetaker". */
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** The name the Notetaker joins under: the one the person chose, else "<their name>'s Notetaker". */
export function notetakerName(custom: string | null | undefined, displayName: string | null | undefined): string {
  const chosen = cleanNotetakerName(custom);
  if (chosen) return chosen;
  const name = displayName?.trim().replace(/\s+/g, ' ');
  if (!name) return FALLBACK_NOTETAKER_NAME;
  return `${possessive(name)} Notetaker`.slice(0, MAX_NOTETAKER_NAME);
}

/** A typed name, tidied: control characters gone, spaces collapsed, capped; null when nothing is left. */
export function cleanNotetakerName(value: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = value?.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, MAX_NOTETAKER_NAME) : null;
}
