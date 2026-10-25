import type { HotkeyAction, HotkeyConflict, HotkeyError } from '@/lib/desktop/bridge';

/** The accelerator for the fn / 🌐 key on its own. */
export const FN = 'Fn';

/** What people call each action (DESIGN.md §5 Settings). */
export const SHORTCUT_LABELS: Record<HotkeyAction, string> = { toggle: 'Open Eavesy', dictation: 'Talk', assistant: 'Talk to Eavesy' };

/** How the Talk shortcut behaves: fn is a tap (fn_key.rs); other keys, fn chords included, tap or hold (dictate.rs). */
export function talkHint(accelerator: string): string {
  return accelerator === FN
    ? 'Tap fn and talk. Tap it again to paste where your cursor is.'
    : 'Hold to talk and let go to paste, or tap to start and stop.';
}

/** The one rule, shown wherever a shortcut is refused for lacking a modifier. */
export const MODIFIER_RULE = 'Use ⌘, ⌃, ⌥ or fn with a key, or fn on its own.';

const MODIFIER_GLYPHS: Record<string, string> = {
  cmd: '⌘', command: '⌘', super: '⌘', meta: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧', fn: 'fn',
};

/** Whether an accelerator is fn held with a key ("Fn+Space"), not fn on its own. */
export function isFnChord(accelerator: string): boolean {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
  return parts.length > 1 && parts.includes('fn');
}

/** Key caps for an accelerator, in the order it's written: "Cmd+Shift+D" → ["⌘", "⇧", "D"], "Fn+Space" → ["fn", "Space"]. */
export function keyCaps(accelerator: string): string[] {
  if (!accelerator) return [];
  if (accelerator === FN) return ['fn'];
  return accelerator
    .split('+')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((part) => MODIFIER_GLYPHS[part.toLowerCase()] ?? (part === 'Enter' ? '↩' : part.length === 1 ? part.toUpperCase() : part));
}

/** "⌘⇧Space" style, for sentences; fn chords read "fn Space". */
export function keysText(accelerator: string): string {
  const caps = keyCaps(accelerator);
  if (caps[0] === 'fn' && caps.length > 1) return `fn ${caps.slice(1).join('')}`;
  return caps.join('');
}

export type HeldModifiers = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };

/** Modifier caps held right now, in the order a recorded shortcut spells them. */
export function heldCaps(held: HeldModifiers): string[] {
  return [held.meta && '⌘', held.ctrl && '⌃', held.alt && '⌥', held.shift && '⇧'].filter((cap): cap is string => !!cap);
}

const NAMED_CODES: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backslash: '\\', Slash: '/', Period: '.', Comma: ',',
  Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
};

type KeyEvent = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

function modifierNames(e: KeyEvent): string[] {
  return [e.metaKey && 'Cmd', e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter((name): name is string => !!name);
}

/**
 * The accelerator for a key press, or null while only modifiers are down.
 * The Mac app decides whether it's allowed; this only spells it.
 */
export function acceleratorFromEvent(e: KeyEvent): string | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = NAMED_CODES[e.code] ?? null;
  if (!key) return null;
  return [...modifierNames(e), key].join('+');
}

/**
 * The key fn can be held with (a letter, a digit or Space), as an accelerator
 * spells it, or null. Arrows, F-keys and the like carry fn on their own, so
 * they never count (hotkeys.rs `CHORD_KEYS`).
 */
function chordKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code === 'Space' ? 'Space' : null;
}

/** Whether the Mac app may report this key press as an fn chord (so the recorder waits for it). */
export function mayBeFnChord(e: Pick<KeyboardEvent, 'code'>): boolean {
  return chordKey(e.code) !== null;
}

/** The fn chord for a key pressed while fn is held: "Fn+Space", "Fn+Shift+K"; null for keys fn can't be held with. */
export function fnChordFromEvent(e: KeyEvent): string | null {
  const key = chordKey(e.code);
  if (!key) return null;
  return [FN, ...modifierNames(e), key].join('+');
}

/** The line shown under a row when the Mac app refuses a shortcut. */
export function hotkeyErrorText(error: HotkeyError, accelerator: string): string {
  switch (error.kind) {
    case 'needsModifier':
      return MODIFIER_RULE;
    case 'taken':
      return error.by === 'other'
        ? `Another app is using ${keysText(accelerator)}. Pick another.`
        : `Already used for ${SHORTCUT_LABELS[error.by]}.`;
    case 'inputMonitoring':
      return 'fn needs Input Monitoring for Eavesy.';
    case 'accessibility':
      return `${keysText(accelerator) || 'fn with a key'} needs Accessibility for Eavesy.`;
    case 'invalid':
      return error.message;
  }
}

/** The sentence in a conflict card, before saving. */
export function conflictText(conflict: HotkeyConflict, accelerator: string): string {
  const keys = keysText(accelerator);
  switch (conflict.kind) {
    case 'system':
      return `${keys} is used by ${conflict.name}. Turn it off in Keyboard Shortcuts, or Eavesy and macOS will both react.`;
    case 'app':
      return `${keys} is also ${conflict.name}’s shortcut. Only one of them will get it.`;
    case 'globe':
      return `${keys} is also ${conflict.name} in macOS. Only one of them will get it.`;
    case 'common':
      return `${keys} is ${conflict.name} in most apps. Eavesy would take it over everywhere.`;
  }
}

/** The note kept under a saved shortcut that something else also uses. */
export function savedConflictText(conflict: HotkeyConflict, accelerator: string): string {
  const keys = keysText(accelerator);
  switch (conflict.kind) {
    case 'system':
      return `${keys} is also ${conflict.name} in macOS, so it may not reach Eavesy.`;
    case 'app':
      return `${keys} is also ${conflict.name}’s shortcut, so it may not reach Eavesy. Pick another here or in ${conflict.name}.`;
    case 'globe':
      return `${keys} is also ${conflict.name} in macOS, so it may not reach Eavesy.`;
    case 'common':
      return `${keys} is ${conflict.name} in most apps.`;
  }
}
