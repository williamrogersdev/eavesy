import type { HotkeyAction, HotkeyConflict, HotkeyError } from '@/lib/desktop/bridge';

/** The accelerator for the fn / 🌐 key on its own. */
export const FN = 'Fn';

/** What people call each action (DESIGN.md §5 Settings). */
export const SHORTCUT_LABELS: Record<HotkeyAction, string> = { toggle: 'Open Eavesy', dictation: 'Talk' };

/** How the Talk shortcut behaves: fn is a tap (fn_key.rs); other keys tap or hold (dictate.rs). */
export function talkHint(accelerator: string): string {
  return accelerator === FN
    ? 'Tap fn and talk. Tap it again to paste where your cursor is.'
    : 'Hold to talk and let go to paste, or tap to start and stop.';
}

/** The one rule, shown wherever a shortcut is refused for lacking a modifier. */
export const MODIFIER_RULE = 'Use ⌘, ⌃ or ⌥ with a key, or fn on its own.';

const MODIFIER_GLYPHS: Record<string, string> = {
  cmd: '⌘', command: '⌘', super: '⌘', meta: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧',
};

/** Key caps for an accelerator, in the order it's written: "Cmd+Shift+D" → ["⌘", "⇧", "D"]. */
export function keyCaps(accelerator: string): string[] {
  if (!accelerator) return [];
  if (accelerator === FN) return ['fn'];
  return accelerator
    .split('+')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((part) => MODIFIER_GLYPHS[part.toLowerCase()] ?? (part === 'Enter' ? '↩' : part.length === 1 ? part.toUpperCase() : part));
}

/** "⌘⇧Space" style, for sentences. */
export function keysText(accelerator: string): string {
  return keyCaps(accelerator).join('');
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

/**
 * The accelerator for a key press, or null while only modifiers are down.
 * The Mac app decides whether it's allowed; this only spells it.
 */
export function acceleratorFromEvent(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = NAMED_CODES[e.code] ?? null;
  if (!key) return null;
  const mods = [e.metaKey && 'Cmd', e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, key].join('+');
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
    case 'invalid':
      return error.message;
  }
}

/** The sentence in a conflict card. */
export function conflictText(conflict: HotkeyConflict, accelerator: string): string {
  const keys = keysText(accelerator);
  return conflict.kind === 'system'
    ? `${keys} is used by ${conflict.name}. Turn it off in Keyboard Shortcuts, or Eavesy and macOS will both react.`
    : `${keys} is ${conflict.name} in most apps. Eavesy would take it over everywhere.`;
}
