# Eavesy: brand and launcher design system

Audience: anyone (human or agent) changing `web/src/components/launcher/*`,
`desktop/launcher-ui/src/hud.tsx` or the tray/app icons. This is the encoded
standard: follow it without a designer present.

Where it lives in code:
- Tokens: `web/src/components/launcher/ui/tokens.css` (imported by
  `desktop/launcher-ui/src/styles.css` and `web/src/styles/globals.css`).
- Primitives: `web/src/components/launcher/ui/` (one file per component,
  styles in `ui.css`, barrel `index.ts`).
- Mascot: `web/src/components/launcher/ui/mascot.tsx`; static art
  `desktop/src-tauri/icons/mascot.svg`.
- Icons: `desktop/src-tauri/icons/gen_icon.py` (app icon) and `gen_tray.py`
  (tray template + recording variant).
 If something isn't covered, choose what a small,
warm, slightly odd companion would do. Don't fall back to a generic dev tool.

---

## 1. Point of view

1. **Ambient first.** Most people drive Eavesy by shortcut and rarely click
   it. It should blend into macOS: translucent, quiet, native. It sticks out
   just enough to be found when it's needed. Warmth comes from the palette,
   microcopy and small details, not from loud visuals. During normal use
   nothing bounces, pulses for attention or pops up. The mascot gets more
   room to be expressive only in empty states and onboarding.
2. **A little one lives under your eaves.** Eavesy isn't a dashboard. It's a
   small creature that sits on your Mac and writes things down for you.
   Every surface should feel like its home: warm plaster walls, a slate roof,
   a porch light. Screens shouldn't feel like empty containers.
3. **You can always see when it's listening.** The mascot's ears (the eaves of
   its roof) go up only while the mic is live. In every other state its eyes
   are calm, closed or looking elsewhere. The character *is* the privacy
   indicator, so an animation must never suggest listening when the mic is
   off. Red is used **only** for "the mic or screen is recording right now".
4. **Capture never interrupts you.** Starting or stopping a capture never
   moves, resizes or replaces what you were looking at. Dictation lives in
   the HUD. The panel shows at most one row that changes in place (see §6).
5. **Local first, and it says so.** Recordings live in `~/Eavesy` on this Mac
   and the copy says that plainly. Signing in adds transcripts, summaries and
   sync. Skipping sign-in is never framed as a lesser option.
6. **Protect the strange.** The roof hat, the chimney that puffs while
   transcribing, the eave shadow on its forehead: keep these. If a review says
   "simplify the mascot into a circle", the answer is no.

## 2. Voice and microcopy

Two voices, and they never mix:

- **Interface voice** (labels, buttons, errors, settings): plain, direct,
  sentence case. It doesn't apologize, use exclamation marks or say "we".
- **Eavesy's voice** (only inside a mascot speech bubble: onboarding, empty
  states, the first-run tip): first person, short, warm and a bit wry. One
  bubble holds at most two sentences. Never use it in errors.

Rules:
- Name things the way people do: "voice note", "screenshot", "meeting",
  "clipboard". Never "capture source", "session", "pipeline".
- Status verbs: **Listening** (mic live), **Writing it down** (transcribing),
  **Pasted** / **Copied** / **Saved** (done). An action keeps its name
  through the flow: the button "Paste at cursor" produces the toast "Pasted".
- Each error says what happened, why, and offers one button that fixes it.
- Write keys as glyphs in `<Kbd>`: `fn`, `⌘V`, `⌘⇧Space`. Never "Fn / Globe
  tap".
- Use the ellipsis "…" only for something actually in progress.

| Where | Before | After |
|---|---|---|
| Empty history (bubble) | Record a voice note, take a screenshot, or press ⌘V to keep text or an image here. | **"It's quiet up here. Hold `fn` and talk, or drop something in below."** The bubble tail points at the composer. |
| Composer placeholder | (none) | Paste, drop a file, or jot a note… |
| Meeting tooltip | Also record computer audio, for calls and meetings | Records both sides of a call |
| Empty search | (none) | No captures match "invoice". |
| Mic permission hint | Needed for voice notes and dictation. | Lets Eavesy hear you while you hold `fn`. It only listens while its ears are up. |
| Mic permission, onboarding bubble | (none) | "I'll need to borrow your ears. Only while you hold `fn`, promise." |
| Accessibility (paste) | (none) | Lets Eavesy type the transcript where your cursor is. |
| Screen Recording | (none) | For screenshots, screen videos and meeting audio. You can turn it on later. |
| No speech detected | No speech detected. | Didn't hear any words in this one. The audio is still saved. |
| Transcribe failed | Couldn't transcribe this one. The audio is saved. | Transcription failed. The audio is saved. **[Try again]** |
| Not signed in row | Saved on this Mac. Sign in to get the transcript. | Saved on this Mac. **[Sign in]** to get a transcript. |
| Fn button | Use Fn / Globe tap | Use `fn` (hold to talk) |
| Fn conflict | (none) | Your Mac uses `fn` for emoji right now. In Keyboard settings, set "Press 🌐 key to" → "Do Nothing". **[Open Keyboard settings]** |
| Start failure | Could not start recording | Couldn't start recording: microphone access is off. **[Open Microphone settings]** |
| Screenshot failure | Could not take the screenshot | Screenshot didn't work: Screen Recording access is off. **[Open settings]** |
| Hotkey error | Include ⌘ or ⌃ in the shortcut. | Add ⌘ or ⌃ so it won't clash with typing. |
| Sign-in button | Sign in with browser | Sign in at eavesy.com |
| Sign-in waiting | Finish in your browser… | Waiting for you in the browser… |
| Skip sign-in | Skip for now | Stay local for now |
| HUD transcribing | Transcribing… | Writing it down… |
| Copy toast | Transcript copied | Copied |
| Panel title | Capture history | (no title: the date groups are the structure) |

## 3. The mascot: Eavesy

**Form.** A honey-coloured pebble wearing its own slate gable roof as a hat,
with a small chimney on the right slope. The roof overhangs the body on both
sides. Those overhangs are the **eaves**, and they work as its ears. Two oval
eyes with one highlight each, pink cheeks, a small smile. A thin honey-shade
band under the roof is the eave's shadow on its forehead. There are no limbs,
antennae, mechanical parts or screens for a face. It's a creature, not a
robot.

Geometry (viewBox `0 0 64 64`, see `icons/mascot.svg` / `ui/mascot.tsx`):
- Body: `M32 15 C46.5 15 54 27 54 40 C54 51.5 45 58.5 32 58.5 C19 58.5 10 51.5 10 40 C10 27 17.5 15 32 15Z`
- Roof: two 8u round-capped strokes from the peak (32, 9) to (5, 31) and (59, 31). Each half rotates around the peak. Positive rotation lifts the left eave and negative lifts the right.
- Chimney: rect 43,9 5×10 r1.5, attached to the right roof half.
- Eyes: ellipses at (24, 37.5) / (40, 37.5), rx 3.2 ry 4.2.

**Detail levels** (the `size` prop picks one automatically):
- ≥ 40px: everything (shadow, cheeks, highlights, chimney).
- 20–39px: no ground shadow or chimney smoke.
- ≤ 19px (tray, inline badges): roof chevron + two eye dots only, one colour.

**States**

| state | pose | motion |
|---|---|---|
| `idle` | eaves level, smile | blinks about every 6–9s (two out-of-step cycles, so it never feels looped). No breathing at sizes under 40px. |
| `listening` | eaves perked 6°, eyes wide, small "o" mouth | eaves lift `6° + level × 14°`, body bobs `−2.5u × level`, 80ms linear transition (follows the mic level live, no keyframes) |
| `thinking` | eyes up, flat mouth | pupils drift slowly (3s), small smoke puffs rise from the chimney. Puffs only show at 20px and up, and they're faint. |
| `happy` | `^ ^` eyes, smile | eyes close into arcs and the body lifts 1.5u once (360ms). No hop, no sparkle under 40px. Back to idle after 1.4s. |
| `confused` | head tilted −6°, one eye larger, wavy mouth, "?" (≥40px only) | tilt eases in over 260ms, then holds still |
| `sleeping` | closed eyes, eaves drooped −5° | slow 5s breathing, "z" floats out every 3s |

Mapping: mic live → `listening` (the only state with eaves up). Transcribing
→ `thinking`. Paste or copy succeeded → `happy` (one shot). Error or no speech
→ `confused`. Signed out with nothing to do → `idle`. 10 minutes without
input, or the mic disabled → `sleeping`.

**Presence budget:** In everyday chrome (HUD, title bar, tray, rows), the
mascot is ≤ 20px, monochrome-calm and changes pose without fanfare. Only
empty states (72px) and onboarding (96px) get full colour plus bubbles. It
never animates to ask for attention.

**Where it appears**
- **HUD:** 18px, left side of the bar, live state. It replaces the red dot.
  The red record light becomes a 6px dot on the roof peak while recording.
- **Title bar:** 18px, low detail, idle/sleeping. It doesn't react to clicks.
- **Empty states:** 72px with a speech bubble.
- **Onboarding guide:** 96px. It walks you through each step and changes
  state with it (see §6).
- **Tray (template image, 18pt):** roof chevron + two eye dots. Recording uses
  a non-template variant: chevron + one red dot (the porch light is on).
  Paused/mic off uses closed-eye dashes. It is never a microphone.
- **App icon:** plaster `#F3ECE3` squircle with the mascot at 78% scale,
  sitting low so the body is cropped by the bottom edge, peeking up. Roof
  `#4B3A78`, body `#F6B93B`.
- **Toasts:** 16px happy/confused glyph before the text.

**Not allowed:** a mascot that talks during errors, that pops up uninvited
mid-task (Clippy's mistake), any state that suggests listening with the mic
off, or blinking faster than every 3s.

## 4. Tokens

These live in `web/src/components/launcher/ui/tokens.css`, shared by the
desktop launcher UI and the web launcher scope. `--ev-*` replaces `--lr-*`. During migration, keep the
alias block so old classes still work.

```css
.launcher-scope, .ev {
  /* surfaces: whitewashed plaster, not cream, not white */
  --ev-paper:      #FBF7F2;  /* panel background */
  --ev-well:       #F3ECE3;  /* sunken: search, toolbar shelf, kbd */
  --ev-raised:     #FFFDF9;  /* menus, popovers, thumbnails frame */
  --ev-line:       #E8DFD4;  /* hairlines */
  --ev-line-strong:#D6CABC;
  /* ink: plum dusk, never #000 */
  --ev-ink:        #2A2233;
  --ev-ink-2:      #675D70;  /* secondary text (7.0:1 on paper) */
  --ev-ink-3:      #978C9C;  /* placeholders, timestamps (3.1:1) */
  /* brand */
  --ev-slate:      #4B3A78;  /* roof: primary actions, focus, selection */
  --ev-slate-hover:#3D2F66;
  --ev-slate-soft: #ECE6F6;
  --ev-on-slate:   #FFF8EE;
  --ev-honey:      #F6B93B;  /* body: mascot, highlights. Never text */
  --ev-honey-shade:#E39E1E;
  --ev-honey-soft: #FCEBC4;  /* highlight wash, search hits */
  --ev-honey-ink:  #7A4E00;  /* text on honey-soft */
  --ev-cheek:      #F59BA0;
  --ev-mascot-body:#F6B93B; --ev-mascot-shade:#E39E1E; --ev-mascot-roof:#4B3A78;
  /* meaning */
  --ev-rec:        #FF3B30;  /* RECORDING ONLY. Same as web --signal */
  --ev-rec-soft:   #FFE4E1;
  --ev-leaf:       #2F8A5B;  /* granted / done */
  --ev-leaf-soft:  #DDF1E5;
  --ev-warn-ink:   #9A5B00;  /* errors use warn, not red: red means recording */
  --ev-warn-soft:  #FFF0D6;
  /* HUD glass (same in both modes: it sits over any app) */
  --ev-hud:        rgb(44 36 52 / 0.62);  /* over backdrop-filter: blur(30px) saturate(160%) */
  --ev-hud-line:   rgb(255 240 220 / 0.14);
  --ev-hud-ink:    #F7EFE6;
  --ev-hud-ink-2:  rgb(247 239 230 / 0.62);

  --ev-focus: 0 0 0 2px var(--ev-paper), 0 0 0 4px var(--ev-slate);
}
@media (prefers-color-scheme: dark) { .launcher-scope, .ev { /* attic at night */
  --ev-paper:      #241E2C;
  --ev-well:       #1C1723;
  --ev-raised:     #2E2738;
  --ev-line:       #3A3245;
  --ev-line-strong:#4B4257;
  --ev-ink:        #F5EDE3;
  --ev-ink-2:      #BDB2C2;
  --ev-ink-3:      #887D90;
  --ev-slate:      #B4A4F0;  /* the roof catches moonlight */
  --ev-slate-hover:#C8BBF7;
  --ev-slate-soft: #352C4C;
  --ev-on-slate:   #1F1830;
  --ev-honey:      #FFC65A;
  --ev-honey-shade:#E8A63A;
  --ev-honey-soft: #3D3020;
  --ev-honey-ink:  #FFD98F;
  --ev-cheek:      #F08A93;
  --ev-mascot-body:#F6B93B; --ev-mascot-shade:#D9921C; --ev-mascot-roof:#7C69C6;
  --ev-rec:        #FF5A4F;
  --ev-rec-soft:   #3A1D1F;
  --ev-leaf:       #6FCF97;
  --ev-leaf-soft:  #1F3328;
  --ev-warn-ink:   #FFC870;
  --ev-warn-soft:  #3A2C17;
}}
/* migration aliases: delete once no class references them */
.launcher-scope {
  --lr-brand: var(--ev-rec);            /* only where it meant "recording" */
  --lr-hover: color-mix(in srgb, var(--ev-ink) 6%, transparent);
  --lr-selected: var(--ev-slate-soft);
  --lr-brand-soft: var(--ev-rec-soft);
  --lr-surface: var(--ev-paper);
}
```
The panel keeps the macOS vibrancy blur (`backdrop-filter: blur(28px)
saturate(170%)`) with `--ev-paper` at 88% on top. It reads as native glass,
just warm. Warmth must not depend on the wallpaper.

**Type.** `--ev-font-round: ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif`
for the voice of the product: headings, date groups, buttons, chips, mascot
bubbles, kbd. `--ev-font-text: -apple-system, BlinkMacSystemFont, system-ui, sans-serif`
for transcripts and long text (SF Pro reads better at length). Numbers use
`font-variant-numeric: tabular-nums`. Don't use monospace anywhere in the UI.

| token | size/line | weight | use |
|---|---|---|---|
| `--ev-t-title` | 19/24 round | 700 | onboarding step title |
| `--ev-t-head` | 15/20 round | 650 | section/view title |
| `--ev-t-body` | 13.5/20 text | 400 | transcripts, notes |
| `--ev-t-ui` | 13/18 round | 550 | buttons, rows, chips |
| `--ev-t-small` | 11.5/16 round | 500 | meta, timestamps, hints |
| `--ev-t-group` | 12/16 round | 700 | day group headers ("Today"), ink-2, sentence case |

**Radii:** radius grows with the container. `--ev-r-kbd: 5px`,
`--ev-r-ctl: 9px` (buttons, inputs, chips use pill `999px`), `--ev-r-media: 8px`,
`--ev-r-pop: 12px`, `--ev-r-panel: 16px`, `--ev-r-hud: 999px` (bar) /
`16px` (transcript sheet).

**Elevation** (always plum-tinted, never neutral grey):
`--ev-e-1: 0 1px 0 rgb(42 34 51 / .05)` (pressed-in well, inset),
`--ev-e-2: 0 1px 2px rgb(42 34 51 / .08), 0 4px 14px -6px rgb(42 34 51 / .18)` (menus, thumbnails),
`--ev-e-3: 0 0 0 .5px rgb(42 34 51 / .14), 0 24px 60px -22px rgb(42 34 51 / .45)` (panel, HUD).
In dark mode, multiply the alpha by 2 and add `inset 0 1px 0 rgb(255 240 220 / .06)`.

**Spacing:** 4-pt grid. `--ev-s-1: 4px`, `-2: 8px`, `-3: 12px`, `-4: 16px`,
`-5: 20px`, `-6: 28px`. Panel gutter is 14px, list rows use 10px vertical
padding, and the HUD has 8px internal padding.

**Motion:**
```css
--ev-ease-out: cubic-bezier(.2,.8,.2,1);    /* default */
--ev-ease-spring: cubic-bezier(.34,1.56,.64,1); /* mascot + confirmations only */
--ev-d-press: 90ms; --ev-d-state: 160ms; --ev-d-enter: 240ms; --ev-d-morph: 320ms;
```
Under `prefers-reduced-motion: reduce`: the mascot holds each state's pose
with no blink, bob, smoke or hop. Listening still shows perked eaves at a
fixed 10°, so the privacy signal doesn't depend on motion. Morphs become
120ms cross-fades and nothing slides.

**Iconography:** lucide, 16px, `stroke-width 1.75`, round caps, `--ev-ink-2`.
Use filled glyphs only for live states (stop square, play). Kind icons are
fixed: voice `AudioLines`, meeting `Users`, screenshot `Camera`, video
`Clapperboard`, note `StickyNote`, image `Image`. Never use a microphone or
robot glyph to stand for Eavesy itself.

## 5. Layouts (panel 420 × 620, gutter 14)

```
┌──────────────────────────────────────────────┐
│ ×  [m] Eavesy                 (W ▾)   ⚙      │ 44  title bar, drag region
├──────────────────────────────────────────────┤
│ ┌shelf (well, r12)──────────────────────────┐│
│ │[Talk fn][Meeting][Screenshot][Video]      ││ 42  capture toolbar, 4 equal segments
│ └───────────────────────────────────────────┘│
│ ⌕ Search captures            /               │ 32
│ (All) (Voice) (Meetings) (Screens) (Notes)   │ 26  chips, horizontal scroll
│ Today                                         │
│ ▏🎙 Voice note · 0:42          9:41  [⧉][⋯]  │ hover actions appear
│ ▏  "Remind Sam the deck goes out…"           │ clamp 4 lines + fade + "More"
│ ▏📷 Screenshot                  9:12          │
│ ▏  [ thumbnail 16:10, r8, e-2 ]              │
│ Yesterday …                                   │
│ ┌composer (well, r12)───────────────────────┐│
│ │ +  Paste, drop a file, or jot a note…  ⌘V ││ 40  composer, pinned (replaces footer)
│ └───────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

**Title bar (44):** close (18px circle, `--ev-ink-3`, hover `--ev-well`, not
red), 22px mascot, "Eavesy" in round 13.5/650. Right side: the account chip
(24px circle, honey-soft fill, honey-ink initial) opens a `Menu`: name/email,
"Synced 2 min ago" with a leaf dot, Open eavesy.com, Settings ⌘,, Sign out.
It also holds **Open ~/Eavesy folder** (moved here from the old footer), above
Settings. Signed out, the chip is a ghost pill reading "Sign in" and the gear
menu holds the folder link. The gear opens
Settings. While recording, the title bar shows nothing new (the HUD carries
recording state).

**Capture toolbar:** one row, no sub-row and no source toggle. It sits on a
well-coloured shelf (r12, 4px padding) split into **four equal, quiet
segments**: `grid-template-columns: repeat(4, 1fr)`, 34px high, r9. Each
segment is a 14px icon with its label inline (round 12/600, ink-2, no wrap). Add a
shortcut hint only where a shortcut exists. Segments are named by purpose,
never by audio routing:

| segment | what it does | hint / tooltip |
|---|---|---|
| **Talk** `fn` | Dictation. Mic only, types at your cursor. Runs in the HUD. | "Hold fn to talk. Let go to paste." |
| **Meeting** | Records you and the other side of a call (mic + computer audio). Runs in the HUD until stopped, and saves a Meeting row with a summary. | "Records both sides of a call" |
| **Screenshot** | Area capture, saved to history. | (user's shortcut if set) |
| **Video** | Screen recording with mic. | (user's shortcut if set) |

Every segment is visually equal: no raised lead button and no colour fill.
Hover uses ink 5% and the focus ring. While a capture runs, its own segment
turns into **Stop** (filled square in `--ev-rec`, label "Stop", plus the
elapsed time as the hint), and the other three dim to 40%. That's the panel's
only red control. The "computer audio" choice is gone from the UI. Meeting
means mic + computer audio, and Talk means mic only. Settings drops "default
source".

**History:**
- Search: well field, r9, 32px, leading search icon, trailing `Kbd /`.
  Matches are highlighted with `--ev-honey-soft` and `--ev-honey-ink`.
- Chips: pill, 26px. Unselected is `--ev-line` outline with ink-2 text.
  Selected is slate-soft fill with slate text. Show counts only when the
  filter is active.
- Day groups: "Today", "Yesterday", weekday, then "Mar 4". A sticky header
  over 92% paper.
- Rows: no cards. A 1px dotted `--ev-line-strong` thread runs down the left
  gutter (x = 22) connecting the kind icons, which sit on 20px paper discs so
  the thread looks threaded through them. Header: icon, kind label (ink),
  duration (ink-3, tabular), time on the right.
- Long text: clamp at 4 lines with a 24px fade to paper. "More" toggles, in
  round 11.5 slate.
- Thumbnails: max-height 148, r8, e-2, and a 1px `--ev-line` inner frame so
  white screenshots don't bleed into paper. Video shows a duration badge
  bottom-left in HUD glass.
- Hover/focus actions: Copy, Paste at cursor, ⋯ (Open file, Show in Finder,
  Delete). 28px IconButtons on a raised r9 strip with e-2, fading in over
  160ms. They're always visible on the keyboard-focused row.
- Empty: 72px idle mascot plus a speech bubble (raised, r12) whose **tail
  points down to the composer**: "It's quiet up here. Hold `fn` and talk, or
  drop something in below." Search and chips are hidden while history is
  empty.

**Composer (pinned bottom, replaces the footer).** This is the one obvious
place to put things in.
- Shape: a well field, r12, 40px fixed resting height, 10px from the panel
  edges. Contents: a leading 28px IconButton `+` (Paperclip on hover, opens a
  file picker), placeholder "Paste, drop a file, or jot a note…" (round 13,
  ink-3), and a trailing `Kbd ⌘V` that becomes a slate "Save" quiet button
  once there's text.
- Accepts typed notes, paste (text, images, files) and drag-drop. Enter saves
  a single-line note as a **Note** row. Shift+Enter adds a line, and ⌘Enter
  saves a multi-line note. Esc clears the draft (a second Esc closes the
  panel). After saving, the field empties, the new row changes in at the top
  of Today, and a quiet "Saved" appears in the placeholder for 1.2s.
- **Routing:** ⌘V anywhere in the panel (outside search or another text
  field) goes to the composer. Files and images save immediately. Text lands
  in the field as a draft so you can edit it before Enter. Typing a printable
  key with nothing focused doesn't steal into the composer (that would
  surprise people). `/` focuses search and `N` focuses the composer.
- **Height stability:** the list's scroll area has `padding-bottom: 64px`
  (40 + gaps) so the last row is never hidden, and the composer floats over a
  12px paper fade. When a draft grows past one line, the composer **grows
  upward over the list** to a maximum of 4 lines (≈ 104px), gains `--ev-e-2`
  and scrolls internally after that. The list never moves or reflows. Its
  bottom padding updates only when nothing is animating, so there's no jump.
- **Drop target:** dragging a file anywhere over the panel doesn't cover the
  list. The composer expands upward to 96px (240ms, `--ev-ease-out`) into a
  dashed 2px slate outline on slate-soft at 60%, with a 28px listening mascot
  (no red dot) and "Drop to save". The list stays visible behind it and
  dims to 85%. Leaving the panel collapses it back. Dropping plays a one-shot
  `happy` in the composer, and the new row changes in at the top.
- Focus: `--ev-focus` ring on the well. The placeholder dims and the `+`
  icon turns slate.
- Accessibility: `role="textbox" aria-multiline="true"`,
  `aria-label="New note, or paste or drop a file"`, and the drop state is
  announced via `aria-live="polite"` ("Drop to save").

**Shortcut row (Settings + onboarding):** label (13 ui) and hint (11.5 ink-2)
on the left, `Kbd` group on the right (each key 22px high, well fill, 1px
line-strong bottom border so it looks like a key cap, round 12). Clicking the
row enters recording mode: the keys become a dashed slate outline reading
"Press keys…", the mascot (16px) is listening, and Esc cancels.

**Settings:** one scroll column, groups titled in `--ev-t-group`: Account,
Shortcuts (Talk, Meeting, Screenshot, Video, Open Eavesy), Capture (live
captions switch, HUD position),
Storage (folder path with Change button), Permissions (status rows with leaf
check or warn "Turn on" button). Group bodies sit on `--ev-raised`, r12,
hairline-separated rows. These are the only card-like containers in the app.

**HUD (floating, compact 300 × 34 bar plus an optional transcript sheet).**
It's translucent vibrancy glass like Control Center, not a solid pill. It
shows no labels until hovered, except the timer.
```
 ╭────────────────────────────────────────────╮
 │ [m] Listening 0:07  ▁▃▅▂     ⏹   ✕         │ 34, r999, --ev-hud glass
 ╰────────────────────────────────────────────╯
   ╭────────────────────────────────────────╮   gap 6
   │ …so the plan is we ship the redesign   │   transcript sheet, r16
   │ on Thursday and ┃ask Sam for the deck  │   max 3 lines, newest bottom
   ╰────────────────────────────────────────╯
```
The mascot follows mic level with a 6px red dot on its roof peak. The timer
is tabular. The sheet slides down 6px and fades in over 240ms when the first
words arrive and never before, so no empty box flashes. Final words are
`--ev-hud-ink` and provisional words are `--ev-hud-ink-2`, with a caret
blinking at the end. The text is 13.5/19 text font. When the mascot is
`thinking`, the bar reads "Writing it down…". When it's `happy`, the bar
reads "Pasted" and the HUD fades out after 1.2s. That's the only thing that
happens.

## 6. Capture lifecycle: height-stable and without view switches

Starting or stopping a capture **must not** swap the panel to a full
recording view, resize the panel or move existing rows. The current tall
"Starting capture…" view with a big "Stop & save" button is removed from
the default flow.

1. **Start** (hotkey, Talk, Meeting, or HUD): the HUD owns the session and
   turns red at once, with a quiet start sound (Settings → Sounds). The panel
   is untouched if it's closed. If it's open, the **capture toolbar becomes
   the live bar**: the one place the panel says it is recording. Nothing is
   added to the list, so nothing below it moves.
2. **Live bar:** a 16px listening mascot with the red peak dot in a
   rec-tinted ring, "Listening · 0:07" (or "Meeting · 12:40"), the newest
   words clipped from the start, and the panel's only red control, Stop.
   Clicking the bar opens it downward to show the last few lines heard.
3. **Stop:** the stop sound plays and the HUD reads "Writing it down…" the
   moment the key is pressed, before the paste target is looked up. The live
   bar shows the same, without Stop.
4. **Done:** the finished capture grows into the top of "Today" and the
   toolbar comes back. The HUD shows "✓ Pasted" (or "Saved") over the words,
   older lines fading under the bar instead of being cut. A control in the
   lower half of the screen opens its transcript above the bar, so the bar
   never moves.
5. **Failure / no speech:** the warn-coloured line with its fix button. The
   HUD shows `confused` for 1.6s.
6. **The full recording view** is reachable only on purpose: "Open live
   view" in the HUD menu. It isn't used for
   dictation.

Implementation notes: animate height with a measured
`grid-template-rows: 0fr → 1fr` wrapper, never `display` toggles.
Keep scroll anchored (`overflow-anchor: auto`). If the user has scrolled
down, insert above without moving their view and show a "1 new" slate pill
at the top.

## 7. Onboarding (in the panel, mascot-guided)

There are four steps, and they really are a sequence, so they're numbered.
The layout is a 96px mascot on the left with a bubble on the right. Below
that are the step body and a dot progress indicator (4 dots, current in
slate). The footer has the primary action on the right and "Stay local for
now" as a ghost button on the left.

1. **Sign in** (`idle`): "Hi, I'm Eavesy. I live up here and write things
   down for you." [Sign in at eavesy.com] or "Stay local for now".
   Waiting state: `thinking`, "Waiting for you in the browser…", Cancel.
2. **Permissions checklist** (`listening` *only after the mic is granted*,
   `idle` before): rows for Microphone (required), Accessibility (paste at
   cursor), and Screen Recording (optional, "Later" allowed). Each row shows
   a status disc (granted: leaf check; not yet: an outline ring), title,
   hint and an "Allow" button that becomes "Open Settings" after a denial.
   Rows update live. Each grant plays a one-shot `happy`.
3. **Shortcuts** (`listening` while practising): "Hold `fn` and say anything.
   I'll show you what I heard." A practice field shows the live transcript.
   Shortcut rows: Talk (`fn` hold), Open Eavesy (`⌘⇧Space`), each editable.
   If fn opens the emoji picker, show the inline fix from §2.
4. **Done** (`happy`, then `idle`): "That's it. I'll be in the menu bar,
   under the roof icon." [Start using Eavesy].

## 8. Primitives (`web/src/components/launcher/ui/`)

| component | props |
|---|---|
| `Button` | `variant: 'primary' \| 'ghost' \| 'quiet' \| 'danger-rec'`, `size: 'sm' (26) \| 'md' (32)`, `icon?: LucideIcon`, `kbd?: string`, `loading?: boolean`, plus native button props. Press = scale .97 over 90ms. |
| `IconButton` | `label: string` (required, used as aria-label and tooltip), `icon`, `size: 24 \| 28`, `tone?: 'default' \| 'rec'`, `pressed?: boolean` |
| `Switch` | `checked`, `onCheckedChange`, `label`, `hint?`. 30×18 track; off is line-strong, on is slate; thumb is raised. Thumb travel 160ms with a spring ease. |
| `Composer` | `onSaveNote(text)`, `onFiles(files)`, `placeholder?`, `maxLines?: number` (4), `dragActive: boolean` (set by a panel-level drag listener). Fixed 40px resting height, grows upward and overlays. |
| `ToolbarSegment` | `icon`, `label`, `hint?: string` (tooltip), `kbd?: string`, `active?: boolean` (renders Stop + elapsed), `dimmed?: boolean` |
| `Segmented<T>` (Settings only, e.g. HUD position) | `value: T`, `onChange`, `options: {value: T, label: string, icon?}[]`, `size: 'sm' \| 'md'`. Well track, raised thumb that slides (240ms). |
| `Menu` | `trigger: ReactNode`, `items: ({label, icon?, kbd?, onSelect, tone?: 'default' \| 'warn'} \| 'separator')[]`, `align: 'start' \| 'end'`. Raised, r12, e-2, 4px padding, 28px items, full keyboard nav. |
| `Card` | `title?`, `children`, `inset?: boolean`. Settings groups only. |
| `Kbd` | `keys: string \| string[]` (e.g. `['⌘','⇧','Space']`), `size: 'sm' \| 'md'`, `tone?: 'well' \| 'hud'` |
| `Chip` | `selected`, `onClick`, `count?`, `icon?` |
| `Mascot` | `state: 'idle' \| 'listening' \| 'thinking' \| 'happy' \| 'confused' \| 'sleeping'`, `level?: number` (0–1), `size?: number` (default 64), `recording?: boolean` (red peak dot), `detail?: 'auto' \| 'full' \| 'mini'`, `title?: string` (when present: role img, otherwise aria-hidden). Implementation: `ui/mascot.tsx`. |
| `Bubble` | `children`, `tail: 'left' \| 'top'`. Raised, r12, e-2, round font 13/18. |
| `StatusDisc` | `status: 'granted' \| 'pending' \| 'denied' \| 'checking'` |

Every interactive primitive uses `box-shadow: var(--ev-focus)` on
`:focus-visible` and has a minimum 24px hit target.
