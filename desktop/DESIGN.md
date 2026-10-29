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
2. **Your AI's inside guy.** Eavesy isn't a dashboard. It's a small snoop
   that sits on your Mac and writes things down for you. Every surface
   should feel like its case file: cream paper, charcoal ink, manila folders,
   one coral light. Screens shouldn't feel like empty containers.
3. **You can always see when it's listening.** The mascot tips its hat up
   only while the mic is live, and its coral lens shows only while recording. In every other state its eyes
   are calm, closed or looking elsewhere. The character *is* the privacy
   indicator, so an animation must never suggest listening when the mic is
   off. Coral (`--ev-rec`) is used **only** for "the mic or screen is recording
   right now".
4. **Capture never interrupts you.** Starting or stopping a capture never
   moves, resizes or replaces what you were looking at. Dictation lives in
   the HUD. The panel shows at most one row that changes in place (see §6).
5. **Local first, and it says so.** Recordings live in `~/Eavesy` on this Mac
   and the copy says that plainly. Signing in adds transcripts, summaries and
   sync. Skipping sign-in is never framed as a lesser option.
6. **Protect the strange.** The fedora, the eyes peeking under the brim, the
   magnifying glass that comes out to record: keep these. If a review says
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
| Ask bar placeholder | Paste, drop a file, or jot a note… | Ask Eavesy, or jot a note… |
| Meeting tooltip | Also record computer audio, for calls and meetings | Records both sides of a call |
| Empty search | (none) | No captures match "invoice". |
| Mic permission hint | Needed for voice notes and dictation. | Lets Eavesy hear you while you hold `fn`. It only listens while its ears are up. |
| Mic permission, onboarding bubble | (none) | "I'll need to borrow your ears. Only while you hold `fn`, promise." |
| Accessibility (paste) | (none) | Lets Eavesy type the transcript where your cursor is. |
| Screen Recording | (none) | For screenshots, screen videos and meeting audio. You can turn it on later. |
| No speech detected | No speech detected. | Didn't hear any words in this one. The audio is still saved. |
| Transcribe failed | Couldn't transcribe this one. The audio is saved. | Transcription failed. The audio is saved. **[Try again]** |
| Not signed in row | Saved on this Mac. Sign in to get the transcript. | Saved on this Mac. **[Sign in]** to get a transcript. |
| Fn button | Use Fn / Globe tap | Use `fn` (tap to talk) |
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

## 3. The mascot: Eavesy, the Little Snoop

**Form.** A small charcoal bean in a fedora, the shape of a trench-coated spy
seen from the hat up. Two plain cream oval eyes peek out under the brim. The
hat has a slightly lighter band and a pinched crown. While a capture is
recording it raises a magnifying glass whose lens is the coral recording
light. There are no limbs, antennae, mechanical parts or screens for a face,
and no mouth: it says everything with its eyes and its hat. It's a creature,
not a robot.

Geometry (viewBox `0 0 64 64`, see `icons/mascot.svg` / `ui/mascot.tsx`):
- Head: ellipse (32, 41) rx 21 ry 17.
- Hat: brim ellipse (32, 27) rx 30 ry 5; crown `M13.5 27C13.8 16.5 19.5 8.5 26.5 8.5Q32 11.5 37.5 8.5C44.5 8.5 50.2 16.5 50.5 27Z`; band rect 10,20 44×4.6 clipped to the crown. The hat moves as one piece.
- Eyes: ellipses at (25, 42) / (39, 42), rx 3.8 ry 5.4.
- Lens (recording only): handle (53, 56)→(59, 63), rim r 7.6 and coral glass r 5 at (49.5, 51.5).

**Detail levels** (the `size` prop picks one automatically):
- ≥ 40px: everything (ground shadow, hat band, "z"/"?" marks).
- 20–39px: no ground shadow or marks.
- ≤ 19px (tray, inline badges): hat + head + eyes; in mono, hat + eyes only. Recording shows a coral dot instead of the lens.

**States**

| state | pose | motion |
|---|---|---|
| `idle` | hat level, eyes open | blinks about every 6–9s (two out-of-step cycles, so it never feels looped). No breathing at sizes under 40px. |
| `listening` | hat tipped up off the brow, eyes wide | hat lifts `2u + level × 4u` and tilts −3°, body bobs `−2.5u × level`, 80ms linear transition (follows the mic level live, no keyframes) |
| `thinking` | eyes drift up | eyes glance slowly side to side (3s) |
| `happy` | `^ ^` eyes | eyes close into arcs and the body lifts 1.5u once (360ms). No hop, no sparkle under 40px. Back to idle after 1.4s. |
| `confused` | head tilted −6°, hat cocked, one eye larger, "?" (≥40px only) | tilt eases in over 260ms, then holds still |
| `sleeping` | closed eyes, hat pulled down | slow 5s breathing, "z" floats out every 3s |

Mapping: mic live → `listening` (the only state with the hat up). Recording
→ `recording` prop on (the only time the coral lens shows). Transcribing
→ `thinking`. Paste or copy succeeded → `happy` (one shot). Error or no speech
→ `confused`. Signed out with nothing to do → `idle`. 10 minutes without
input, or the mic disabled → `sleeping`.

**Presence budget:** In everyday chrome (HUD, title bar, tray, rows), the
mascot is ≤ 20px, monochrome-calm and changes pose without fanfare. Only
empty states (72px) and onboarding (96px) get the full figure plus bubbles. It
never animates to ask for attention.

**Where it appears**
- **HUD:** 22px in cream, left side of the pill, live state. It wears the
  coral lens while recording.
- **Title bar:** 18px, low detail, idle/sleeping. It doesn't react to clicks.
- **Empty states:** 72px with a speech bubble.
- **Onboarding guide:** 96px. It walks you through each step and changes
  state with it (see §6).
- **Tray (template image, 18pt):** fedora + two eyes under the brim.
  Recording uses a non-template variant: the same glyph in a mid-tone plus
  one coral dot. Paused/mic off uses closed-eye dashes. It is never a
  microphone.
- **App icon:** cream `#FBF7F0` squircle with the Little Snoop at 78% scale,
  lens raised. Coat `#2B2523`, band `#4A403C`, lens `#FF5A3C`. The static
  brand mark (app icon, favicon `web/public/icon.svg`, OG image) is the one
  place the coral shows without a recording. Anything live, the `Mascot`
  component included, shows it only while recording.
- **Wordmark:** "eavesy" in charcoal with a coral full stop.
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
  /* surfaces: case-file cream, not white */
  --ev-paper:      #FBF7F0;  /* panel background */
  --ev-well:       #F2EBDF;  /* sunken: search, toolbar shelf, kbd */
  --ev-raised:     #FFFDF8;  /* menus, popovers, thumbnails frame */
  --ev-line:       #E6DDCF;  /* hairlines */
  --ev-line-strong:#D3C7B6;
  /* ink: trench-coat charcoal, never #000 */
  --ev-ink:        #211C1A;
  --ev-ink-2:      #5F5751;  /* secondary text */
  --ev-ink-3:      #968D85;  /* placeholders, timestamps */
  /* brand */
  --ev-coat:       #2B2523;  /* primary actions, focus, selection */
  --ev-coat-hover: #1A1614;
  --ev-coat-soft:  #ECE6DF;
  --ev-on-coat:    #FBF7F0;
  --ev-manila:      #E2B866;  /* folder tan: highlights. Never text */
  --ev-manila-shade:#C99A45;
  --ev-manila-soft: #F6E8CC;  /* highlight wash, search hits */
  --ev-manila-ink:  #6E4A12;  /* text on manila-soft */
  --ev-mascot-body:#2B2523; --ev-mascot-band:#4A403C; --ev-mascot-eye:#FBF7F0;
  /* meaning */
  --ev-rec:        #FF5A3C;  /* the coral light: RECORDING ONLY. Same as web --signal */
  --ev-rec-soft:   #FFE3DA;
  --ev-leaf:       #2F8A5B;  /* granted / done */
  --ev-leaf-soft:  #DDF1E5;
  --ev-warn-ink:   #9A5B00;  /* errors use warn, not coral: coral means recording */
  --ev-warn-soft:  #FFF0D6;
  /* HUD pill (same in both modes: it sits over any app) */
  --ev-hud:        rgb(22 19 18 / 0.97);  /* solid pill, no vibrancy */
  --ev-hud-line:   rgb(255 240 220 / 0.14);
  --ev-hud-ink:    #F6EFE4;
  --ev-hud-ink-2:  rgb(246 239 228 / 0.62);

  --ev-focus: 0 0 0 2px var(--ev-paper), 0 0 0 4px var(--ev-coat);
  --ev-focus-field: 0 0 0 1px var(--ev-ink-3), 0 0 0 4px color-mix(in srgb, var(--ev-ink-3) 18%, transparent);
}
@media (prefers-color-scheme: dark) { .launcher-scope, .ev { /* after hours */
  --ev-paper:      #1F1A18;  /* warm paper after hours, never a black slab */
  --ev-well:       #29231F;  /* lighter than paper: raised, not sunken */
  --ev-raised:     #2E2724;
  --ev-line:       #3A322D;
  --ev-line-strong:#4D433D;
  --ev-ink:        #F2EBDF;
  --ev-ink-2:      #B5ABA0;
  --ev-ink-3:      #82786F;
  --ev-coat:       #F2EBDF;  /* in the dark the coat turns to cream paper */
  --ev-coat-hover: #FFFFFF;
  --ev-coat-soft:  #352D29;
  --ev-on-coat:    #1F1A18;
  --ev-manila:      #F0C879;
  --ev-manila-shade:#D9AB55;
  --ev-manila-soft: #3A2F1C;
  --ev-manila-ink:  #F5D9A0;
  --ev-mascot-body:#3D3431; --ev-mascot-band:#5A4F4A; --ev-mascot-eye:#F2EBDF;
  --ev-rec:        #FF6A4D;
  --ev-rec-soft:   #3A1D16;
  --ev-leaf:       #6FCF97;
  --ev-leaf-soft:  #1F3328;
  --ev-warn-ink:   #FFC870;
  --ev-warn-soft:  #3A2C17;
}}
/* migration aliases: delete once no class references them */
.launcher-scope {
  --lr-brand: var(--ev-rec);            /* only where it meant "recording" */
  --lr-hover: color-mix(in srgb, var(--ev-ink) 6%, transparent);
  --lr-selected: var(--ev-coat-soft);
  --lr-brand-soft: var(--ev-rec-soft);
  --lr-surface: var(--ev-paper);
}
```
The panel keeps the macOS vibrancy blur (`backdrop-filter: blur(28px)
saturate(170%)`) with `--ev-paper` at 88% on top. It reads as native glass,
just warm. Warmth must not depend on the wallpaper. The native material is
`Popover`, which follows the system appearance; the always-dark `HudWindow`
material is for the pill only (under paper it turned the panel into a black
slab).

**One surface, one mascot, one live signal.** (From
[assistant.md](../docs/plans/assistant.md), Visual rules.)
- The panel has one mascot, in the title bar. While a capture runs it
  carries the capture's state (hat up while the mic is live); nothing below
  repeats it.
- A live capture shows in the panel as the **live card**: the pill carried
  in, in `--ev-hud` charcoal with the coral light, the label, the time,
  Stop, and the same number of lines the pill shows (newest in full ink,
  older in `--ev-hud-ink-2`). Nothing shrinks to one line.
- Opening the panel fades it in over the pill (the native animator, about
  240 ms) while the pill stays underneath and is ordered out once the panel
  covers it, so nothing cuts.
- Keycaps don't decorate idle controls: shortcuts live in tooltips, and a
  keycap shows only where it teaches something (onboarding, the empty state,
  a row's Return-to-paste).
- Search is an icon until used: no well, no keycap, "Search" placeholder; it
  becomes a field in the well once opened or typed into.
- Each kind of control has one look, so nothing reads as something else:
  raised tiles start something, borderless pills narrow the list, and the
  ask bar at the bottom is where you write. There are no peer tabs: the
  captures are home, and the conversation with Eavesy opens in their place
  with a "‹ Captures" way back.

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
`--ev-r-pop: 12px`, `--ev-r-panel: 16px`, `--ev-r-hud: 999px` (bars); the HUD
pill itself is r20, r22 when wide.

**Elevation** (always charcoal-tinted, never neutral grey):
`--ev-e-1: 0 1px 0 rgb(33 28 26 / .05)` (pressed-in well, inset),
`--ev-e-2: 0 1px 2px rgb(33 28 26 / .08), 0 4px 14px -6px rgb(33 28 26 / .18)` (menus, thumbnails),
`--ev-e-3: 0 0 0 .5px rgb(33 28 26 / .14), 0 24px 60px -22px rgb(33 28 26 / .45)` (panel, HUD).
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
with no blink, bob or hop. Listening still shows the hat lifted at a
fixed 3u, so the privacy signal doesn't depend on motion. Morphs become
120ms cross-fades and nothing slides.

**Iconography:** lucide, 16px, `stroke-width 1.75`, round caps, `--ev-ink-2`.
Use filled glyphs only for live states (stop square, play). Kind icons are
fixed: voice `AudioLines`, meeting `Users`, screenshot `Camera`, video
`Clapperboard`, note `StickyNote`, image `Image`. Never use a microphone or
robot glyph to stand for Eavesy itself.

## 5. Layouts (panel 420 × 620, gutter 14)

```
┌──────────────────────────────────────────────┐
│ ×              [m] Eavesy                 ⚙  │ 44  title bar, drag region
├──────────────────────────────────────────────┤
│ New capture            Saves to (▭ eavesy ▾) │ 26  section label, project chip
│ ┌──────┐ ┌───────┐ ┌──────────┐ ┌───────┐    │
│ │ Talk │ │Meeting│ │Screenshot│ │ Video │    │ 58  four raised capture tiles
│ └──────┘ └───────┘ └──────────┘ └───────┘    │
│ ──────────────────────────────────────────── │
│ (All) Voice  Meetings  Screens  Notes     ⌕  │ 34  list bar: type pills, search
│ Today                                         │
│ ▏🎙 Voice note · 0:42          9:41  [⧉][⋯]  │ hover actions appear
│ ▏  "Remind Sam the deck goes out…"           │ clamp 4 lines + fade + "More"
│ ▏📷 Screenshot                  9:12          │
│ ▏  [ thumbnail 16:10, r8, e-2 ]              │
│ Yesterday …                                   │
│ ┌ask bar (well, r12)────────────────────────┐│
│ │ Eavesy  Two servers outlived… [1 waiting]›││ 24  peek: opens the conversation
│ │ +  Ask Eavesy, or jot a note…          🎙 ││ 40  ask bar, pinned (replaces footer)
│ └───────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

The conversation opens in place of everything between the title bar and the
ask bar (the tiles, list bar and history stay mounted underneath, so search,
filter and scroll are kept):

```
│ ×              [m] Eavesy                 ⚙  │ 44  title bar
├──────────────────────────────────────────────┤
│ ‹ Captures          (Ask) ◌ Off the record  Clear │ 34  head: way back, mode, record, clear
│                       What did I promise Priya? │ your turn, right
│                         📎 Voice note · 9:41 AM │ captures that went with it
│ Eavesy                                        │
│ Checked your agent sessions · 3 sessions     │ tool steps, ink-3
│ You said you'd send Priya the deck by…       │ its answer
│ ┌card────────────────────────────────────────┐│ cards wait here for a click
│ │ +  Reply to Eavesy…                    🎙 ││ 40  the same ask bar
```

**Title bar (44):** three columns. Left: close (18px circle, `--ev-ink-3`,
hover `--ev-well`, not red). Centre: the 22px mascot and "Eavesy" in round
13.5/700, centred on the panel. Right: the Update pill when one is ready,
"Sign in" when signed out, and the gear, a `Menu` holding the account
(name/email and a leaf "Syncing to eavesy.com" dot), Settings ⌘,, Open
eavesy.com, **Open ~/Eavesy folder** and Sign out. The side columns share
the slack, so the name stays centred until the right side outgrows its half.
While recording, the mascot carries the capture's state; nothing else changes.

**One surface, not two tabs.** Captures are the panel's home. Eavesy is
reached from the ask bar at the bottom, which is always there: type and press
Return, press the mic, click the peek line, or press `⌘J`. The conversation
then takes the space between the title bar and the ask bar. Its head row (34,
hairline below) has a ghost "‹ Captures" button on the left (Esc does the
same), then the permission mode chip, Off the record and Clear on the right.
Leaving it never clears it: the peek line in the ask bar shows what Eavesy
said last and, in a manila pill, how many cards wait for a click, so a card
that arrives while you're on the captures is never missed. Opening the panel
keeps whichever you were on; the tray's Recordings item and `/` go back to
the captures.

**Asking about captures.** Each capture with words has an "Ask Eavesy about
this" action (`MessageCircleQuestion`) in its hover strip. It attaches the
capture to the next question: the row turns manila-soft and a manila chip
("Voice note · 9:41 AM ×") sits in the ask bar above the field. Up to three
go with one question. Only what you attach is sent, never the list you're
looking at, and the words are the whole transcript, cut to fit one message
(the chip says "trimmed" when they will be). Your turn in the thread shows
the question with a 📎 line naming what went with it. The mic is off while
captures are attached (a spoken turn can't carry them). Esc with an empty
field takes the attachments off first.

**Capture toolbar:** a "New capture" section label (the day-group style)
with "Saves to" and the project chip (next recording's project, `auto` when
it follows the app in front) on its right, then **four equal raised tiles**:
`grid-template-columns: repeat(4, 1fr)`, 6px apart, 58px high, r12, raised
surface with a 1px line. Each is an 18px icon (ink-2, coat on hover) over its
label (round 12/600, ink). Talk's `fn` keycap sits in its top-right corner;
add one only where a shortcut exists. Tiles are named by purpose, never by
audio routing:

| segment | what it does | hint / tooltip |
|---|---|---|
| **Talk** `fn` | Dictation. Mic only, types at your cursor. Runs in the HUD. | "Tap fn and talk. Tap it again to paste where your cursor is." |
| **Meeting** | Records you and the other side of a call (mic + computer audio). Runs in the HUD until stopped, and saves a Meeting row with a summary. | "Records both sides of a call" |
| **Screenshot** | Area capture, saved to history. | (user's shortcut if set) |
| **Video** | Screen recording with mic. | (user's shortcut if set) |

Every tile is visually equal: no lead button and no colour fill. Hover
darkens the surface a touch and strengthens the line. While a capture runs,
the label row goes and the tiles become the live bar in place: a 28px head
row (status, elapsed time, cancel and Stop) over up to four lines of the
newest words, on the HUD's charcoal. The title bar's mascot is the only
mascot while it runs. Starting and writing use the same bar without Stop.
There is no second listening card or expandable text box above search. The
bar's height follows its lines, not the 90px of label and tiles it replaces,
so the list bar and history shift when a capture starts, as its words come
in, and when it ends.
Meeting means mic + computer audio, and Talk means mic only.

**History:**
- List bar: one row of chrome between the toolbar and the list, under a
  hairline. On the left, the type pills (All, Voice, Meetings, Screens, Notes):
  24px, borderless, ink-2; the chosen one on coat-soft in ink, with its count
  while searching or filtering. Clicking the chosen pill again goes back to
  All. On the right, search as a 28px icon. Clicking it or pressing `/` opens a
  well field (r9) that takes the row; only the chosen pill stays beside it
  (none for All). Opening the panel focuses search quietly, so typing searches
  at once, but the field stays an icon until something is typed, and it closes
  on blur when it holds no query. Matches are highlighted with
  `--ev-manila-soft` and `--ev-manila-ink`.
- Day groups: "Today", "Yesterday", weekday, then "Mar 4". A sticky header
  over 92% paper.
- Rows: no cards, no thread, no discs. The words are the row: they start at
  the row's left edge, full width. Above them a quiet 20px meta line in
  ink-3: 13px kind icon, kind label (round 11.5/600, ink-2), duration
  (tabular), time on the right.
- Long text: clamp at 3 lines with a fade to paper. "More" toggles, in
  round 11.5 coat.
- Thumbnails: take the image's own width (no letterbox), max-height 148, r8,
  e-2, and a 1px `--ev-line` inner frame so white screenshots don't bleed
  into paper. Video shows a duration badge bottom-left in HUD glass.
- Hover/focus actions: Paste at cursor (only while another version is
  shown), Copy, **Rewrite**, ⋯ (Edit transcript, Play audio, Show in Finder,
  Move to Trash). 26px IconButtons and a small ghost text button on a
  raised r9 strip with e-2, fading in over 160ms. They're always visible on
  the keyboard-focused row and while a row's tray is open.
- **Rewrite tray** (pulled, never shown unasked): Rewrite opens a row of
  26px chips under the words: Original, Professional, Friendly, Concise, a
  1px rule, **For AI** (a toggle that works with any tone; text only, no
  robot), then Translate. Unlike the HUD drawer's tone row, these are
  versions of one capture, not the setting. Each version is
  made from the saved words, never from another rewrite, is kept for the
  session, and is never saved over the transcript. Copy and Paste use the
  version on screen. While one is being made the words dim and "Rewriting…"
  shows at the tray's end; a failure says why in warn ink and leaves the
  words as they were. Past 20,000 characters tones say "Too long to rewrite
  here"; For AI falls back to the cloud's agent transcript when there is
  one. Clicking Rewrite again closes the tray and goes back to the original.
- Empty: 72px idle mascot plus a speech bubble (raised, r12) whose **tail
  points down to the composer**: "It's quiet up here. Hold `fn` and talk, or
  drop something in below." Search and chips are hidden while history is
  empty.

**Transcript corrections:** "Edit transcript" lives in a capture's More menu,
not below every transcript. It opens a focused dialog with the full transcript,
a scrollable text area, Cancel, and Save changes (⌘Enter). Escape closes an
unchanged draft; unsaved changes require an explicit Discard. Failed saves keep
the draft open. Saved text updates in history immediately. Audio is unchanged.

**Ask bar (the Composer with `onAsk`; pinned bottom, replaces the footer).**
This is the one obvious place to put things in, and to ask Eavesy.
- Shape: a well field, r12, 40px fixed resting height, 10px from the panel
  edges. Contents: a leading 28px IconButton `+` (Paperclip on hover, opens a
  file picker), placeholder "Ask Eavesy, or jot a note…" (round 13, ink-3;
  "Reply to Eavesy…" in the conversation, "Ask about this capture…" with one
  attached), and a trailing mic (Talk to Eavesy, its shortcut in the tooltip).
  Once there's text the mic gives way to two buttons that name where the words
  go: the one Return presses in coat (primary), the other quiet (⌘Return). In a
  panel under 340px the quiet one keeps only its icon.
- Above the field, one optional row spans the bar: the attached capture chips,
  or (on the captures) the peek line from the conversation.
- **Where Return sends it** (`enterGoes`): typed words ask Eavesy, and
  ⌘Return saves them as a **Note** row instead. Words that came from the
  clipboard (⌘V routed in, or pasted into the field) save as a note on
  Return, and ⌘Return asks: the clipboard can hold anything, so it never goes
  to the model on Return alone. In the conversation Return always asks, since
  you're replying. Shift+Return adds a line. Esc clears the draft; on an empty
  field it takes attached captures off, then leaves the conversation, then
  closes the panel. After a note saves, the field empties, the new row
  changes in at the top of Today, and a quiet "Saved" appears in the
  placeholder for 1.2s. Asking empties the field at once and opens the
  conversation; if Eavesy can't take it (still answering), the words and the
  attached captures come back.
- **Routing:** ⌘V anywhere in the panel (outside search or another text
  field) goes to the ask bar. Files and images save immediately. Text lands
  in the field as a draft so you can edit it first. Typing a printable key
  with nothing focused doesn't steal into the bar (that would surprise
  people). `/` goes to the captures and opens search, `N` focuses the bar, and
  `⌘J` opens or leaves the conversation (from the bar too).
- **Height stability:** the list's scroll area has `padding-bottom: 64px`
  (40 + gaps) so the last row is never hidden, and the composer floats over a
  12px paper fade. When a draft grows past one line, the composer **grows
  upward over the list** to a maximum of 4 lines (≈ 104px), gains `--ev-e-2`
  and scrolls internally after that. The list never moves or reflows. Its
  bottom padding updates only when nothing is animating, so there's no jump.
- **Drop target:** dragging a file anywhere over the panel doesn't cover the
  list. The composer expands upward to 96px (240ms, `--ev-ease-out`) into a
  dashed 2px coat outline on coat-soft at 60%, with a 28px listening mascot
  (no red dot) and "Drop to save". The list stays visible behind it and
  dims to 85%. Leaving the panel collapses it back. Dropping plays a one-shot
  `happy` in the composer, and the new row changes in at the top.
- Focus: `--ev-focus-field` on the raised well. The placeholder dims and the `+`
  icon turns coat.
- Accessibility: `role="textbox" aria-multiline="true"`,
  `aria-label="Ask Eavesy or write a note; paste or drop a file to save it"`, and the drop state is
  announced via `aria-live="polite"` ("Drop to save").

**Shortcut row (Settings + onboarding):** label (13 ui) and hint (11.5 ink-2)
on the left, `Kbd` group on the right (each key 22px high, well fill, 1px
line-strong bottom border so it looks like a key cap, round 12). Clicking the
row enters recording mode: the keys become a dashed coat outline reading
"Press keys…", the mascot (16px) is listening, and Esc cancels.

**Settings:** a separate, resizable native window (840 × 680, minimum 640 ×
480), independent of the capture panel and HUD. It uses the same tokens as the
rest of the app: a well-tinted sidebar (the open section is a raised paper tab
with a manila notch), cream index cards on paper (one level, never nested),
and charcoal coat actions and switches. Dark mode uses the plain dark tokens;
there is no extra manila mixing. Manila stays a highlight (the notch, step
numbers, tags). All of it lives in `preferences.css`; coral stays for
recording only.

The sidebar switches between Capture, Dictation, Transcription, Dictionary,
Shortcuts, Projects, Permissions and Account. Every change saves as it is made
(the sidebar says so), so the header has a primary **Done** (`esc`) that
closes the window; there is no Save button.
- **Dictation:** your default tone and "Write it as a prompt for AI agents",
  with a worked example (one sentence said aloud, and what is typed). Below,
  the projects that set their own style, each linking to its page.
- **Transcription:** the languages you speak.
- **Dictionary:** Words (vocabulary chips: type, paste a list, × to remove) and
  Replacements ("heard as → type instead": add one, **Add many** to paste a
  list, click a row to edit, × to remove with Undo). Fixes made to a
  transcript are added to Replacements.
- **Projects:** a three-step "how projects work", then the list. A project page
  has About, "Picked automatically when you're in…" (the app or window title
  words, defaulting to its name), Words, and Dictation style, whose options read
  "Your default (…)" and show the same example.
- **Permissions:** a one-line summary, then every macOS permission with its
  state and Allow/Open Settings, then Connected (the Eavesy account), then Run
  setup again. Nothing is hidden behind "everything is on".

Preserve drafts when switching sections. Show errors beside the affected
controls. Use reduced-motion behavior. The capture panel and pill retain their
geometry when Settings opens or closes.

**HUD (floating pill, one fixed size per phase).** A solid charcoal pill
(`--ev-hud`), not vibrancy glass: it has to read the same over any app, and
CSS draws its corners so the shadow and the shape always match. Rust picks the
window size from the phase (`hud::size_for`) and animates the native frame
once per phase change, or when a receipt's drawer opens (`peek_hud`). Content never measures itself or resizes the window, so
the pill can't jitter or flip while words arrive.

| Size | Px | Used for |
|---|---|---|
| pill | 216 × 36 | idle, saved, video recording, a plain "Saved" |
| bar | 264 × 40 | recording and writing with live words off (the default) |
| wide | 400 × 62 + 20 per line | recording and writing with 1, 2 or 4 lines of live words, failed, a save that wasn't typed (**Not typed** and why) |
| receipt | 248 × 36 | a finished dictation with "Show the words when it's done" off, or **Not pasted** |
| result | 400 × 176 | a finished dictation's drawer: the words that went out, editable, and the tone row (the dictation setting: a Tone pop-up and a For AI switch, then Translate). Opens by itself unless that switch is off; then hovering the receipt opens it |
| shot | 360 × 172 | a screenshot, with its thumbnail |

**How it looks while recording** is the user's call (Settings → General → Recording
control, `set_hud_look`): live words Off (the bar, the default), 1, 2 or 4
lines, **Show the words when it's done**, on by default, and
**See-through**, on by default, which drops the charcoal to 78% and softens
the coral ring so the control sits back over whatever is underneath. Still
no native glass, for the corner reason above. A change applies at once, even
mid-recording: Rust refits the window and the HUD hears `hud:look`.
**Faster live words**, on by default, shows words about a second sooner from
a fast preview recognizer until the accurate one catches up; it applies from
the next recording.

```
 ╭──────────────────────────────────────────────────╮
 │ [snoop] ● 1:18  ▁▃▅▂▁                   [■ Stop] │ 40, r20
 │         …Thursday and ask Sam for the deck before│ ticker, newest at the right
 ╰──────────────────────────────────────────────────╯
```
The snoop is cream on the charcoal (`.ctl-mark`) and wears the coral lens
only while recording; its hat and the five voice bars follow the mic level.
The coral dot, the coral ring and the coral Stop are the only red, and only
while the mic is live. Live words, when on, are in a quieter ink (62%) on a lighter charcoal (66%
when see-through) so they don't pull the eye while you talk; clicking in to
fix one brings it to full ink. The ticker is one line of 12.5/18 text, clipped from
the start with a soft left fade so the newest words stay in view. Before the
first word it shows the hint ("Go ahead, I'm listening", plus the paste shortcut).

After stop the top row reads "Writing it down…" and the ticker shimmers. The
control stays charcoal the whole way: stopping never turns it into another
object. A dictation ends as a **receipt**, the pill with a stamp that lands
with a short spring: **Pasted · 16 words** (leaf), **Copied** with "⌘V to
paste" (manila) or **Not pasted** (warn, with an Allow button for
Accessibility). With **Show the words when it's done** on (the default),
Pasted and Copied open straight into the **drawer**, so the words can be
fixed or rewritten without hunting for them; Not pasted stays a pill with
its Allow. With it off, the pill alone carries the stamp, and resting the
pointer on it for 250ms (not on a button) opens the drawer.

The drawer holds the words that went out, editable in place, beside Copy,
**–** (collapse to the pill) and **×** (hide the control until it is
reopened from the menu bar). Under the words, the **tone row** is the
dictation setting itself (Settings → Dictation), not a one-off: a **Tone**
pop-up (As spoken · Professional · Friendly · Concise, a native `<select>`
whose list opens over the control, so the window never has to hold it), a
1px rule, a **For AI** switch (written as a prompt for an AI agent; the
track lights cream when on) and, at the row's end, **Translate**. The row shows the tone in force for the words (the server tells
the app with them; a project's own tone counts, and the saved choice stands
in when the server didn't say). Changing it keeps the choice first, for
every dictation to come, on the account or on the project when the tone was
the project's own, then rewrites this dictation to match; a choice that
can't be kept isn't made at all, and the row goes back. Each rewrite starts
from the words as pasted, so tones never compound, and picking the tone
they went out in goes back to them without asking the server. When the
model didn't apply the tone (a short dictation, a failed rewrite, words
corrected live, offline) the row still shows the setting, but the words
count as plain, so any change rewrites them from there. The rewrite
replaces the pasted words in the app only while they are still there
exactly as pasted and that field still has the keyboard; otherwise it is
copied, and the stamp says **Updated** or **Copied**. A rewrite is saved as
the transcript but never taught to the dictionary, and typing over it makes
the typed words the new starting point while the row keeps its choice. When
the server can't rewrite it (the model fails, or the rewrite strays from
what was said) the stamp area says "Kept for next time, but this one
couldn't be rewritten" and the words stay. It never claims **Updated** for
the plain cleanup.

**Translate** opens a language finder in place of the words: a search box
that has the keyboard, then the languages as chips, the ones last used
first (kept on this Mac), so someone who goes back and forth between two
languages finds theirs in one click. Typing narrows them (names that start
with it first, a code like "pt" exactly); arrows move, Enter picks the
first, Esc closes it and leaves the drawer. Picking one translates the words
and they go where the words went, like a tone: replaced in the app while
they're still there as pasted, otherwise copied; saved as the transcript,
never taught to the dictionary. Each language starts from the words before
any translation, so they never compound, and **Original** (first while
there is one to go back to) puts them back without asking the server. The
button and the stamp name the language the words are in. Typing over them
or changing the tone makes those the new starting point. A translation that
fails says why in the stamp area and leaves the words as they were. The drawer reads
a long dictation from its start, fades its last line while more is below,
and its stamp counts the words; past 20,000 characters the tone row gives
way to "Too long to change the tone here" and **Open in Eavesy**, which the
⤢ button in the top row also does for any dictation. Screenshots stamp **Snapped** above the
thumbnail; saves stamp **Saved**. A dictation that was saved but not typed
(signed out, or the words came too late) never stamps a plain Saved: it
stamps **Not typed** in warn, with the reason on the line below. Failures
read "Didn't catch that" in warn, never coral. When one of the control's own
actions fails (Stop, a tone, Copy), it says so in plain words where the phase
shows its status (the voice bars, "Writing it down", the stamp) and every
control stays; the next tone click clears a tone's error. A receipt goes
back to the pill after 1.6s (Pasted) or 6s (Copied), whatever the pointer
does; Not pasted stays until Accessibility is allowed or it's collapsed.
Otherwise the HUD collapses to the pill 3.5s (pill), 6s (a failure, or Not
typed) or 30s (drawer) after the result, 2.5s after the pointer leaves it
(10s for the drawer, which is often left to read or click something
else), or on Esc.
It stays while the pointer is over it
(up to 30s after it last moves, and 2 min at most from when it came over),
while you edit, while the language finder is open, while a tone or
translation is being written, and while a correction is saving. Stopping a recording hands the keyboard back to the app you were in
before anything is pasted, even if you were editing the live words, so the
paste (or your own ⌘V after Copied) never lands in Eavesy's own box. Leaving
the drawer's editor (Esc, a click elsewhere in the control, a tone, Copy)
hands it back too, so the next keystroke goes to that app again. A HUD
low on the screen keeps its bottom edge when it grows, so it never moves away
from where it was.

When a correction reaches the dictionary (typed in the result, or fixed in
the app the words were pasted into), the control says which word for 4s with
a leaf stamp, **✓ Added "Kubernetes"** (+N for more): in place of Pasted on
the result, or as the whole pill when idle. A correction that could not be
saved stamps **Not saved to dictionary** in warn.

## 6. Capture lifecycle: height-stable and without view switches

Starting or stopping a capture **must not** swap the panel to a full
recording view, resize the panel or move existing rows. The current tall
"Starting capture…" view with a big "Stop & save" button is removed from
the default flow.

1. **Start** (hotkey, Talk, Meeting, or HUD): the HUD owns the session and
   turns red once the mic is live, with a quiet start sound (Settings →
   Sounds). With live words on, its ticker echoes the words as they are
   heard, in the quieter ink (the listening hint until the first one), and
   stays through "Writing it down…"; by default it is just the bar. The panel
   is untouched if it's closed. If it's open, the **capture toolbar becomes
   the live bar**: the one place the panel says it is recording. Nothing is
   added to the list, so nothing below it moves.
2. **Live bar:** an 18px listening mascot with the recording indicator,
   "Listening · 0:07" (or "Meeting · 12:40"), the newest words clipped from
   the start, and the panel's only red control, Stop. It replaces the shelf
   at the same height and never expands.
3. **Stop:** the stop sound plays and the HUD reads "Writing it down…" the
   moment the key is pressed, before the paste target is looked up. The live
   bar shows the same, without Stop.
4. **Done:** the finished capture grows into the top of "Today" and the
   toolbar comes back. The HUD stamps "Pasted" (or "Copied", "Saved") over
   the words that went out, at the same size it had while recording.
5. **Failure / no speech:** the warn-coloured line with its fix button. The
   HUD shows `confused` and "Didn't catch that".
6. **The full recording view** is reachable only on purpose: "Open live
   view" in the HUD menu. It isn't used for
   dictation.

Implementation notes: animate height with a measured
`grid-template-rows: 0fr → 1fr` wrapper, never `display` toggles.
Keep scroll anchored (`overflow-anchor: auto`). If the user has scrolled
down, insert above without moving their view and show a "1 new" coat pill
at the top.

## 7. Onboarding (in the panel, mascot-guided)

There are four steps, and they really are a sequence, so they're numbered.
The layout is a 96px mascot on the left with a bubble on the right. Below
that are the step body and a dot progress indicator (4 dots, current in
coat). The footer has the primary action on the right and "Stay local for
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
   under the hat icon." [Start using Eavesy].

## 8. Primitives (`web/src/components/launcher/ui/`)

| component | props |
|---|---|
| `Button` | `variant: 'primary' \| 'ghost' \| 'quiet' \| 'danger-rec'`, `size: 'sm' (26) \| 'md' (32)`, `icon?: LucideIcon`, `kbd?: string`, `loading?: boolean`, plus native button props. Press = scale .97 over 90ms. |
| `IconButton` | `label: string` (required, used as aria-label and tooltip), `icon`, `size: 24 \| 28`, `tone?: 'default' \| 'rec'`, `pressed?: boolean` |
| `Switch` | `checked`, `onCheckedChange`, `label`, `hint?`. 30×18 track; off is line-strong, on is coat; thumb is raised. Thumb travel 160ms with a spring ease. |
| `Composer` | `onSaveNote(text)`, `onFiles(files)`, `placeholder?`, `maxLines?: number` (4), `dragActive: boolean` (set by a panel-level drag listener); for the ask bar also `onAsk(text)`, `askAlways?`, `askBlocked?: string`, `top?` (a row above the field) and `tools?` (the mic). Fixed 40px resting height, grows upward and overlays. |
| `ToolbarSegment` | `icon`, `label`, `hint?: string` (tooltip), `kbd?: string`, `active?: boolean` (renders Stop + elapsed), `dimmed?: boolean` |
| `Select<T>` (settings rows) | `value: T`, `onChange`, `options: {value: T, label: string}[]`, `label`. A 26px native pop-up with an up-down chevron. |
| `Segmented<T>` | `value: T`, `onChange`, `options: {value: T, label: string, icon?}[]`, `size: 'sm' \| 'md'`. Well track, raised thumb that slides (240ms). |
| `Menu` | `trigger: ReactNode`, `items: ({label, icon?, kbd?, onSelect, tone?: 'default' \| 'warn'} \| 'separator')[]`, `align: 'start' \| 'end'`. Raised, r12, e-2, 4px padding, 28px items, full keyboard nav. |
| `Card` | `title?`, `children`, `inset?: boolean`. Settings groups only. |
| `Kbd` | `keys: string \| string[]` (e.g. `['⌘','⇧','Space']`), `size: 'sm' \| 'md'`, `tone?: 'well' \| 'hud'` |
| `Chip` | `selected`, `onClick`, `count?`, `icon?` |
| `Mascot` | `state: 'idle' \| 'listening' \| 'thinking' \| 'happy' \| 'confused' \| 'sleeping'`, `level?: number` (0–1), `size?: number` (default 64), `recording?: boolean` (red peak dot), `detail?: 'auto' \| 'full' \| 'mini'`, `title?: string` (when present: role img, otherwise aria-hidden). Implementation: `ui/mascot.tsx`. |
| `Bubble` | `children`, `tail: 'left' \| 'top'`. Raised, r12, e-2, round font 13/18. |
| `StatusDisc` | `status: 'granted' \| 'pending' \| 'denied' \| 'checking'` |

Every interactive primitive uses `box-shadow: var(--ev-focus)` on
`:focus-visible` and has a minimum 24px hit target. Text fields (search, the
composers) use the quieter `--ev-focus-field`, a 1px ink-3 hairline with a
soft glow: the caret already shows where you are, and a 2px cream ring there
read as a box drawn round the field.
