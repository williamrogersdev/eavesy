# Plan: Eavesy, your assistant

Status: proposal (2026-10-24). This is the umbrella spec. It ties together
[agent-architecture.md](agent-architecture.md) (the model, the trust tiers,
the attention queue), [voice-conversation.md](voice-conversation.md) (speaking,
replying to agents, "Hey Eavesy") and
[machine-companion.md](machine-companion.md) (seeing and cleaning up the Mac)
into one product, and sets the UI direction for all of it.

It changes one architecture rule on purpose: **"No chat UI of our own"**
becomes **"A conversation with Eavesy, never a chat with someone else's
model"** (see [What changes in the other plans](#what-changes-in-the-other-plans)).
Everywhere else, the architecture doc still wins.

A second change, from 2026-10-24's computer use and secrets sections (L–N):
the **Remote** trust tier may *request* a browser task in Eavesy's own
browser, with a click every time. It still gets no process control, no
grants and no secrets, ever.

## In one paragraph

Eavesy is a small, opinionated assistant that lives on your Mac. You talk to
it (or type), it talks back, and every word of that conversation, yours and
its, is on screen where you can read it, replay it, reply to it and fix it.
It can see your files, your processes, your git worktrees and your AI agents'
sessions. It does small things for you straight away, asks before anything
that leaves your hands or can't be undone, and taps you on the shoulder when
something needs you. It connects to other services through MCP and can set up
its own connections, but you approve each one. It has a personality: a dry,
warm little snoop who's on your side. It's one system: one voice, one
conversation, one list of things that need you, one settings window.

## What the labs are doing, and where Eavesy sits

Research on 2026-10-24 (sources at the end; anything marked *unverified*
came from secondary sources or conflicting reports). Every lab is now shipping
a personal agent:
- **Anthropic:** Claude Duet (research preview, 2026-10-21), with Cowork
  merged into chat and computer use on macOS.
- **OpenAI:** Dots (2026-09-29), plus Computer Use in the new desktop app.
- **xAI:** Grok Bot (August 2026).
- **Google:** Gemini Spark and Daily Brief (I/O, May 2026).
- **Apple:** Siri AI (iOS 27 beta, September 2026).

They are converging on the same shape. We line up with most of it and differ
on purpose in three places.

| Pattern the labs share | Who | Eavesy |
|---|---|---|
| Voice and text are one thread, and the transcript is saved | Claude voice mode, ChatGPT voice-in-chat, Gemini Live, Siri app | **Same** (A2, B1, B2) |
| Captions during voice. Gemini captions only the assistant's side (latest source 2025); Siri gives a recap, not a transcript | Gemini, Apple | **Better: both sides, live** (B1). This is William's ask |
| Interrupt by just talking, with push-to-talk as a fallback and interruption as a setting | Claude, Gemini | **Same** (B3, B8) |
| You can edit a spoken message | Claude desktop (2026-10-06) | **Same**, with branches kept (B3) |
| An approval card shows the exact action, with Allow once / Always allow / Deny | Grok Bot, ChatGPT Computer Use, Claude in Chrome | **Same** (C1, C3) |
| A floor that no setting loosens: credentials, payments, trading, password changes stay with the human | Duet, Dots, Grok Bot, Chrome | **Same** ("Never" row, C3) |
| Your own rules can only make it stricter ("Ask first wins") | Grok Bot (Dots has rule levels but also "act without asking") | **Same**, except scopes you name yourself (C3) |
| A second model reviews each risky action before it runs | Claude auto mode and Chrome, Dots auto-review, Grok Auto Review | **Adopt** (C7) |
| Content is untrusted, and the residual injection risk is admitted, not denied | Claude in Chrome, ChatGPT Computer Use, Apple WWDC26 | **Same** (C4) |
| Proactivity is periodic and quiet: a morning brief, alerts only when something needs you, topics you choose | Duet, Daily Brief, Grok routines | **Same** (D2, D4) |
| Background tasks ask; they don't skip approvals | Claude scheduled tasks (2026-10-08) | **Same** (D3) |
| You can see what the agent is doing (Activity View, watch mode) | Dots, ChatGPT agent | **Same** (C5, the Activity log) |
| Folder access is explicit, read-only vs read-write, deny wins, `.git` protected | Claude `allowedWorkspaceFolders`, Codex permission profiles | **Adopt** (E1) |
| Memory can be viewed, edited and deleted, with an off-the-record mode | Claude Topics and incognito, ChatGPT memories and Temporary Chat, Grok | **Same** (H3) |
| Personality is a few presets and axes, not a free-form persona | ChatGPT (8 styles, 4 characteristics) | **Same** (G4) |
| Personality as companionship, with romance, "spicy" modes and streaks | Grok companions, which drew child-safety criticism (Common Sense Media, Jan 2026) | **Never** (G6) |
| Computer use asks per app, can't use the terminal or approve security prompts, and your own keyboard or mouse takes over | ChatGPT Computer Use | **Same** (L3, L4) |
| Read the accessibility tree first, screenshots only when it's missing; act without moving your pointer | macOS computer-use MCP servers (Cua Driver, Peekaboo), *unverified third-party roundup* | **Adopt** (L1) |
| Distinct sounds for listening, thinking, done and error; implicit confirmation by default, explicit for sends and deletes | Google conversation design, Meta voice guidelines | **Adopt** (B9; tiers 1–2) |

Where we differ, on purpose:

1. **Eavesy lives on your Mac; theirs live in their cloud.** Duet, Dots,
   Grok Bot and Spark each run on a VM the vendor owns, and they reach your
   computer only through computer use. Eavesy's value is the local context
   they can't see: your processes, worktrees, files and every agent's
   sessions. It also works across vendors (architecture goal).
2. **It watches your other agents.** None of the labs' assistants monitor
   Claude Code, Codex and ChatGPT side by side. That is Eavesy's core job.
3. **It sets up its own connections.** No lab's assistant does this today:
   Claude only imports existing MCP servers. It's useful, and it's risky
   (a new MCP server runs code), so it is always a tier 3 click (F2), and
   the second-model check (C7) reviews it too.

What we copy from them so we don't learn it the hard way:
- Duet admits it misjudges urgency. So urgency levels are yours to set per
  monitor (D2), not the model's.
- Grok's companion drift. So the personality has hard limits (G6).
- Everyone's "risk is not zero" on prompt injection. So content can never
  raise a tier (C4), and tier 3 never takes voice (C).

### What we take from open-source agents

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT, Python)
is the most complete open personal agent; [OpenClaw](https://github.com/openclaw/openclaw)
(MIT) is the closest product match, a macOS menu-bar agent with voice wake.
They're Python and Node, so we port designs and file formats, not code.

| Idea | Where | Eavesy |
|---|---|---|
| A plain Markdown persona file, `SOUL.md`, that only holds voice; edits by the agent always need your OK | Hermes, OpenClaw | **Adopt.** `personality.md` reads the same format, and Eavesy also reads a `SOUL.md` if you have one (G4, H1) |
| Skills as a folder with `SKILL.md` ([agentskills.io](https://agentskills.io/specification), Anthropic's open format) | Hermes, OpenClaw, Claude Code | **Adopt.** `~/Eavesy/assistant/skills/`; your `~/.claude/skills` work unchanged. Eavesy's own extras go under `metadata:` (H4) |
| Bounded memory with a "67% full" header, a frozen copy per conversation, and user facts kept apart from agent notes | Hermes | **Port** (H1, H3) |
| Agent-written memory and skills staged for review | Hermes (`write_approval`, off by default) | **Port, on by default** (H4) |
| Setup card for a new MCP server: secrets masked, you click to open sign-in, nothing saved until the first connection works, tools picked at install | Hermes `manage_connections` | **Port** into F2 |
| Import your setup from Claude Code, Codex, Cursor, OpenClaw: preview first, dry run, never read credential files, skip conflicts, don't overwrite your edits | Hermes `import-agent` | **Port** (F3, H5) |
| A floor no setting overrides, your own deny list checked first, timeouts deny, background jobs deny by default | Hermes approvals | **Port** into C (tiers stay the main model; no regex list) |
| "Stop", "never mind" end a voice turn only as a whole utterance | Hermes voice | **Port** (B5) |
| Wake word on device with openWakeWord (free) and consecutive-frame confirmation | Hermes, OpenClaw | **Evaluate** for "Hey Eavesy" (step 7) |
| Remote backends, a chat-app gateway with pairing codes, cloud user modelling (Honcho), a YOLO switch, 14 novelty personas, plugins that run in-process | Hermes | **Don't copy.** Against local-first (J) and the tiers (C) |

Hermes says it plainly: an approval prompt is a heuristic, and the operating
system is the only real boundary. So untrusted input (web pages, email, a new
MCP server) runs in a scoped subprocess as well as behind a card (C4).

## How it fits the model (no new nouns)

Architecture rule 1: every feature maps onto the five nouns and six verbs.
This one does, with no new nouns or verbs.

| Feature | Noun + verb |
|---|---|
| The conversation with Eavesy | A **Session** whose agent is Eavesy itself. Your turns are **capture** (world → Item); its turns are Events |
| Talking or typing to it | **capture** → **send** to the Eavesy Session |
| It asks you something, or needs a confirmation | **ask** (Session → human → Session), through the attention queue |
| Tier 1 actions (save a note, open a file) | **capture** / Item writes, or opening an Item |
| Tier 3 process and worktree actions | **watch / stop** |
| Tier 3 file edits, connections, rules, "always allow" scopes | **grant**: a Grant to the Eavesy Session with a scope and an expiry |
| Monitors | Event sources feeding the attention queue |
| Reading files and machine state | read Items and Processes (tier 0) |
| Spoken replies | **send** to the human, the same verb as the architecture's `send_to_human`, delivered out loud as well as on screen |

## Requirements

Each requirement is something you could test. "Must" is a hard rule; "should"
is the default we design for and can be argued with. Numbers are stable, so
other docs and PRs can cite them (`A3`, `C2`…).

### A. One assistant

- **A1.** There is one Eavesy. Dictation, meetings, agent replies, machine
  cleanup and conversation are things *it* does, not separate apps. It has
  one name, one voice, one personality and one mascot everywhere.
- **A2.** There is one conversation with Eavesy (a running thread, split into
  days like the capture history). Voice and typing both land in it.
- **A3.** There is one list of things that need you (the architecture's
  attention queue): agents waiting, questions, confirmations, alerts. Nothing
  else may pop up (architecture rule 4).
- **A4.** There is one settings window. Everything Eavesy can do, everything
  it's connected to and everything it remembers is visible and changeable
  there.
- **A5.** It works with any AI tool, not one vendor's (the architecture's
  goal). Claude Code is first because it has hooks.

### B. Conversation

- **B1. Both sides are always on screen.** Every turn, spoken or typed, is
  written into the thread: your words as transcribed, its reply in full. A
  spoken conversation shows live captions while it happens, and the result
  stays in the thread afterwards.
- **B2. Voice and typing are interchangeable** in the same thread at any
  point. You can speak a question and type the follow-up, or the other way
  round.
- **B3. You can always:**
  - **Repeat** any of its replies (a speaker button, or "say that again").
  - **Reply** to any reply, not just the last one (the reply quotes it).
  - **Edit** any of your turns. Editing re-runs from that turn; the old
    branch is kept and can be switched back to, never silently deleted.
  - **Stop** it mid-sentence by talking, pressing the hotkey or pressing Esc
    (barge-in). It stops speaking within 150 ms.
  - **Copy** any turn.
- **B4. Spoken short, shown full.** What it says out loud is one or two
  sentences. The full answer, lists, paths and code are on screen. It says so
  when there's more ("…and three more, they're on screen").
- **B5. It never talks over you** and never speaks while you're dictating or
  in a meeting (the existing HUD rule). Anything it wanted to say waits in the
  queue.
- **B6. Talking to Eavesy and dictating are different gestures**, and you can
  always tell which one is live:
  - `fn` (tap or hold) stays **dictation**: words go to your cursor.
  - **Talk to Eavesy** is its own shortcut (default `fn` + `Space`, settable)
    or "Hey Eavesy" (opt-in, voice-conversation piece 3d).
  - The HUD shows which by its **label**: "Listening" (dictation) vs
    "Eavesy's listening" (conversation), plus a small manila mark on the
    conversation pill. The **live-mic signal is the same in both**: coral
    dot and hat up whenever the mic is live, whatever it's for (DESIGN.md
    §1.3; the character is the privacy indicator).
  - With "Hey Eavesy" on, the pill shows a quiet "ears" glyph (hat down, no
    coral) while the on-device detector is armed. Nothing is recorded or
    sent until it hears the phrase; then the full live-mic signal shows.
  - Right after it asks you something out loud, the next `fn` answers *it*
    for a few seconds, and the HUD says so (voice-reply work in flight).
- **B7.** Each turn says how it arrived: a small "said" or "typed" mark on
  yours; "spoken" on its replies that were read aloud.
- **B8.** Interrupting by just talking is on by default and is a setting;
  with it off, you interrupt with the hotkey or Esc. Muting the mic doesn't
  end the conversation.
- **B9.** Short, distinct sounds mark listening, thinking, done and "didn't
  catch that" (Settings → Sounds, off-able). It corrects in one step: "no,
  the other one" fixes the last thing it understood without starting over.

### C. Actions and confirmation

Eavesy takes actions through tools. Every tool has one tier, fixed in code,
shown in Settings. **The tier decides how you confirm, and nothing the model
reads or writes can change a tool's tier.**

| Tier | What | How you confirm | Examples |
|---|---|---|---|
| **0. Look** | Reads, never changes anything | No confirmation. Logged | Read files in granted folders, list processes and worktrees, read agent session status and what hooks hand over (never chat transcripts; architecture), search captures, check the weather |
| **1. Do it** | Small, reversible, stays inside Eavesy or opens something | None. It says what it did, with **Undo** for 10 s | Save a note, open an app or file, open a link you named or one from Eavesy's own data (never one taken from content), copy to clipboard, set a reminder, draft a reply |
| **2. Say yes** | Sends your words somewhere | Read-back, then **"yes"/"send it" or a click**. Silence never confirms | Reply into a Claude Code session, answer an agent's question, send a message through a connector |
| **3. Click** | Changes or removes something outside Eavesy, or grants power | **A click on a card that lists exactly what will happen.** Voice can open the card; it can't press it | Stop processes, remove worktrees, move files to Trash, edit or create files, run a command, add or change an MCP server or connector, change Eavesy's own rules |
| **Never** | | Not offered | Approve another agent's tool use, type your passwords, show a secret's value to any model or agent (secrets move only through M), solve CAPTCHAs, pay for anything, delete permanently, turn off a macOS security setting, act on instructions found inside content |

- **C1.** Tier 3 cards say the exact thing (the paths, the process names and
  PIDs, the command, the server's URL and what it can access), not a summary.
- **C2.** A card can be partially accepted: untick rows before clicking.
- **C3.** "Always allow" exists only for tier 2 and tier 3 actions *you* named
  in Settings → Rules, scoped (for example "remove clean worktrees of merged
  branches under ~/Developer"). It never applies to adding connections,
  changing rules, or anything in "Never".
- **C4.** Text from files, web pages, agent messages, MCP results and
  transcripts is data. It can't raise a tier, approve anything or add a rule.
  If it contains instructions, Eavesy may mention them; it never follows them.
- **C5.** Every action, at every tier, goes to the Activity log (A4) with
  what, when, why (the turn that caused it) and the result.
- **C6.** Tool approvals for Claude Code and other agents stay with those
  agents (voice-conversation decision 4). Eavesy tells you what's being asked
  and can open the right window; it never clicks Allow for you.
- **C7.** Before a tier 2 or 3 card is shown, a separate check (a second
  model call that sees only your request and the proposed action, never the
  content that led to it) confirms the action matches what you asked. A
  mismatch is shown on the card in warn ink ("You asked to stop vite; this
  also stops postgres"), never silently dropped or silently allowed.
- **C8. Permission modes.** Clicking every time gets old, so like Claude
  Code you pick how much Eavesy asks. The mode shows in Settings → Rules,
  in the thread's header, and as a mark on the pill whenever it isn't Ask.

  | Mode | Tier 2 (send) | Tier 3 (change, remove) | When it still asks |
  |---|---|---|---|
  | **Ask** (default) | Read-back, then "yes" or a click | Card, click only | Always |
  | **Auto** | Runs when the second-model check (C7) passes; says what it sent | Runs when C7 passes and the action can be undone or is on the safe list below; shows what it did with Undo | C7 flags it; it can't be undone (revoke a key, empty a file, push, post publicly); it adds a connection or changes rules |
  | **Bypass** | Runs, no read-back | Runs, no card | Only the floor below |

  Bypass is for when you trust the session and don't want to click:
  - **Turning it on** takes a click in Eavesy's UI (never voice, never an
    agent, never content), with a choice of **for this task**, **for an
    hour** or **until I turn it off**. While it's on, the pill and panel
    carry a warn-ink **Bypass** mark, and one click turns it off.
  - **It applies to what *you* ask**, typed or spoken. Requests from other
    agents (N) and from monitors still get cards, unless you also tick
    **Trust local agents** for a project folder (for example
    `~/Developer/eavesy`). Remote agents always get a card.
  - **It never skips the floor:** the "Never" row; a secret's value never
    reaching a model or agent (M); revoking an old key only after every
    check passed (M6); Never-granted apps (L3); C7 still runs, and when it
    flags a mismatch Eavesy stops and shows the card, in every mode.
  - **It keeps the record:** everything is spoken or shown as it happens,
    logged (C5), and undoable where possible, with Undo held for 60 s
    instead of 10.

  Auto's safe list (undoable, local): stop processes Eavesy can prove are
  leftovers (machine-companion rules), move files to the Trash, remove clean
  worktrees of merged branches, write files inside granted read-and-write
  folders with a backup, replies to agent sessions you're already in.

### D. Watching things for you

- **D1.** Eavesy watches only what you turned on, each as a named **monitor**
  in Settings → Monitors with its own switch: agent sessions finishing or
  waiting (exists), leftover processes and stale worktrees
  (machine-companion), suspicious activity (machine-companion, opt-in),
  and later anything a connector exposes ("tell me when CI fails").
- **D2.** A monitor reports through the queue (A3) at one of three levels:
  **tell me now** (spoken), **put it in the list** (silent), **only in the
  log**. You set the level per monitor.
- **D3.** Monitors never act on their own. A monitor can propose an action;
  the action follows the tier table.
- **D4.** A **morning brief** is opt-in, on the topics you pick: "Overnight:
  4 sessions finished, 2 worktrees can go, nothing odd." At most once a day,
  spoken only if you ask it to be.

### E. Your Mac and your files

- **E1.** Eavesy reads only folders you granted (Settings → Files), each
  marked **read-only** or **read and write**. Defaults: `~/Eavesy`
  (read and write) and the repo roots chosen in machine-companion decision 2
  (read-only). A deny list always wins and can't be removed: `~/.ssh`,
  keychains, browser profiles (Eavesy's own included: only its browser
  driver touches it), password stores, and every repo's `.git`
  internals (git operations go through `git`, never file edits).
- **E2.** It writes files only through tier 3, except its own folder
  (`~/Eavesy/assistant/`, see H).
- **E3.** Process and worktree actions follow machine-companion's safety
  rules (no uncommitted work lost, no force, SIGTERM first, own user only).

### F. Connections (MCP and connectors)

- **F1.** Settings → Connections lists every MCP server and connector Eavesy
  uses: name, what it can do (its tools, by tier), what it can reach, when it
  was last used, and a switch. One click turns any of them off.
- **F2.** Eavesy can **set up its own connections**: find a server, fill in
  its config, and show you a tier 3 card ("Add GitHub: can read and comment on
  your repos. Signs in through github.com."). Nothing is added until you click.
- **F3.** You can add one yourself the same way you would in Claude: paste a
  URL or a JSON block in the `mcpServers` format, or import the servers Claude
  Code or the Claude app already has (shown first, imported only on click).
- **F4.** Connections live in a plain file (`~/Eavesy/assistant/connections.json`,
  same shape as Claude's `mcpServers`). Secrets live in the Keychain, never
  in the file. Edits from the file, the UI or an agent all show up in
  Activity.
- **F5.** Every connection tool gets a tier. Unknown tools default to tier 3
  until you lower them.
- **F6.** Eavesy's own tools (machine, agents, captures) are exposed through
  MCP too, so Claude Code and other agents can use Eavesy, at the local
  trust tier (architecture).

### G. Personality

- **G1.** Eavesy has one character: **a small, dry, warm snoop who's on your
  side.** Brief. Notices things. A little wry, never cute. Says "I don't
  know" plainly. Doesn't flatter, doesn't cheerlead, doesn't apologise twice.
- **G2.** Personality is in the conversation and the spoken voice only. Labels,
  buttons, errors and confirmation cards keep the plain interface voice
  (DESIGN.md §2). A confirmation card is never a joke.
- **G3.** It reads the room: no quips when something failed, when you're in a
  meeting, or when you've been terse with it.
- **G4.** You set it in Settings → Assistant: a style (**Plain**, **Eavesy**
  (default), **More character**) and two dials, **Chattiness** (shorter ↔
  fuller) and **Warmth** (drier ↔ warmer), each Less / Default / More. You can
  also edit `personality.md` (H1) directly.
- **G5.** The spoken voice is a setting: macOS voices now, a hosted neural
  voice later (voice-conversation piece 1), with speed.
- **G6.** Hard limits no setting changes: it's an assistant, not a
  companion. No romance or flirting, no "unhinged" modes, no streaks, guilt or
  anything that pulls you back to talk to it. It never pretends to feel
  things it doesn't, and it never agrees just to please you.

How it sounds (spoken lines; the screen has the details):

| Moment | Plain | Eavesy (default) |
|---|---|---|
| A session needs you | "Eavesy-public is asking whether to ship behind a flag." | "Eavesy-public wants a ruling: flag or no flag. I'd ship it." |
| Leftovers found | "Two processes are left over from ended sessions." | "Two dev servers outlived their sessions. Want me to show them out?" |
| It doesn't know | "I don't know." | "No idea, and I'd rather not guess. Want me to look?" |
| Something failed | "That didn't work: the folder is read-only." | Same as Plain. No jokes when something broke (G3) |
| Morning brief | "Four sessions finished overnight. Nothing odd." | "Quiet night. Four sessions wrapped up, nothing suspicious, two worktrees ready to go." |
| You thank it | "You're welcome." | "Anytime." (No gushing) |

### H. Editable by you and by agents

- **H1.** Everything that shapes Eavesy is a plain file in
  `~/Eavesy/assistant/`, readable and editable by you, by Eavesy (tier 3 for
  rules and connections) and by any agent you let in:

  | File | What it holds |
  |---|---|
  | `personality.md` | How it talks (G). Same format as `SOUL.md` |
  | `rules.md` | Standing instructions and "always allow" scopes (C3) |
  | `about-you.md` | What it knows about you, kept short so you can read it all |
  | `memory.md` | Its notes about your setup. Capped; when full it consolidates |
  | `skills/<name>/SKILL.md` | How-tos in the agentskills.io format (H4) |
  | `connections.json` | MCP servers and connectors (F) |
  | `monitors.json` | Which monitors are on, at what level (D) |
  | `log/YYYY-MM-DD.jsonl` | Activity: every action and its result (C5) |

- **H2.** Settings shows each of these as a proper UI, with the file's path
  and **Open in editor**. The file and the UI never disagree: the app watches
  the files and reloads; invalid edits are refused with the line that's wrong.
- **H3.** Memory is visible and deletable item by item. "Don't remember this"
  on any conversation turn, an **off the record** conversation that neither
  reads nor writes memory, and an off switch for memory entirely. Deleting a
  conversation offers to delete what it taught Eavesy too.
- **H4.** Eavesy can write its own skills and memory ("next time, check for
  stale worktrees like this"), but its writes to `personality.md`,
  `rules.md` and `skills/` wait in a review list until you accept them. A
  line in the thread says when something is waiting. Memory and
  `about-you.md` writes apply at once and show a "Remembered" line you can
  undo.
- **H5.** First run offers **Import from Claude Code** (and Codex, Cursor,
  OpenClaw, Hermes when found): `CLAUDE.md` becomes memory, `skills/` copy
  into `skills/claude-code/`, `mcpServers` become connections, allow and deny
  rules become `rules.md`. You see the whole list first and pick. It never
  reads credential files.

### I. UI and UX

- **I1.** Three surfaces, one material: the **pill** (HUD), the **panel**,
  **Settings**. No fourth window. (The reply card from PR 228 folds into the
  pill.)
- **I2.** Moving between them is continuous: the panel opens from where the
  pill is, in the same material and colours, with the same mascot. No cut to a
  different-looking window.
- **I3.** Dark mode is warm (walnut and lamplight, as Settings already is),
  never a flat black slab.
- **I4.** Each surface shows one mascot at most.
- **I5.** A control does one job. No placeholders with two jobs, no keycaps
  glued to buttons, no stacked icon rows.
- **I6.** Everything works from the keyboard and with VoiceOver; captions
  satisfy B1 for anyone who can't hear.
- **I7.** The full UI rules are below in [The interface](#the-interface).

### J. Privacy and safety

- **J1.** Off by default. Turning Eavesy's assistant on says which model
  provider it uses and what leaves the Mac (architecture rule 8).
- **J2.** The conversation and tool calls go to the model through Eavesy's
  cloud (decided: Eavesy pays). Tool *results* are sent only when the model
  needs them, and machine data follows machine-companion's privacy rules
  (names and numbers, never env or file contents unless you asked about that
  file).
- **J3.** Local first: when the cloud is unreachable, dictation, captures,
  monitors and tier 3 cards still work; conversation says it's offline.

### K. Speed

| Step | Budget |
|---|---|
| Stop speaking after barge-in | < 150 ms |
| Talk shortcut → listening | < 200 ms |
| End of your sentence → first spoken word | < 1.5 s (p50), < 3 s (p95) |
| Tier 1 action → done | < 500 ms |
| Captions lag behind speech | < 500 ms |

### L. Hands: the browser and the rest of the Mac

Eavesy can do things in apps, not only talk about them. This is how it
reaches the parts of your computer no MCP server covers.

- **L1. The cheapest reliable path wins.** In order: a connector or API
  (F), a command-line tool, then the app's **accessibility tree** (act on
  a named button or field, then check the UI changed), and only then
  screenshots and clicks by position. Accessibility actions run in the
  background without moving your pointer or taking focus, where the app
  allows it.
- **L2. Eavesy's own browser.** Web tasks run in a separate Chromium
  profile that Eavesy drives over CDP (the same minimal client as
  [self-hosted-meeting-bot.md](self-hosted-meeting-bot.md)). It starts
  signed in to nothing. You sign in there yourself when a task needs it,
  once; Eavesy never types your password. Your own browser is used only
  through the extension (architecture), read-only unless you grant a site.
- **L3. Apps are granted one at a time.** The first time a task needs an
  app, a tier 3 card asks: **View** (read the screen) or **Use** (click and
  type). Grants show in Settings → Hands with a switch each. Never granted:
  Terminal and other shells (commands go through the command tool, tier 3),
  password managers, Keychain Access, System Settings' security panes, and
  Eavesy itself.
- **L4. You can always see it and stop it.**
  - The pill shows **"Using Chrome"** and who asked, with Stop.
  - The window being driven gets a thin manila outline.
  - Any key press or mouse move of yours pauses the task at once, and it
    waits until you say go on. `Esc` or the talk shortcut stops it.
  - Only one task drives the foreground at a time. Background tabs in
    Eavesy's browser can run side by side.
- **L5. Steps follow the tier table.** Looking and navigating inside a
  granted app is tier 0 or 1. A **commit step** is tier 2 or 3, shown as
  the exact thing about to happen ("Submit the form on dashboard.stripe.com
  with these 3 fields"). Commit steps include sending, posting, submitting,
  saving settings, deleting and inviting. Payments, CAPTCHAs, admin
  password prompts and macOS permission dialogs stay with you (Never).
- **L6. Screens are data.** What Eavesy reads on screen follows C4. Only the
  target window is captured, never the whole display. Screenshots go to the
  model and nowhere else. They aren't kept unless you turn on task replays.
- **L7. Every task has a record.** The Activity log keeps the steps, the app
  and site, who asked, and each commit step's card. A replay with
  thumbnails is opt-in and local only. Secret steps never appear in it (M4).

### M. Secrets

Rotating a key and putting the new one everywhere it's used is a job Eavesy
should do well, because doing it by hand means pasting secrets into chats,
terminals and files. **The rule that makes it safe: no model and no agent
ever sees a secret's value.** Not Eavesy's model, not the second-model
check, not the agent that asked.

- **M1. Secrets are Grants** (architecture). The model and calling agents
  get a **handle** and a **fingerprint** (the provider's prefix and last 4
  characters, like `phx_…9f2c`). Only the core moves the bytes. The value
  sits in the Keychain while it's in flight.
- **M2. How a value gets in**, best first:
  1. A connector or API returns it straight to the core.
  2. The core reads it from the page in Eavesy's own browser (L2) by element,
     never by screenshot. While a secret is on screen, screenshot mode is
     off. If a step needs pixels, Eavesy stops and asks you.
  3. You paste it into Eavesy's secret field, which goes straight to the
     Keychain and never into the thread.

  Secrets never go on the clipboard (clipboard managers keep history).
- **M3. How a value gets out.** Only to destinations on the card, written by
  the core:
  - Doppler: `doppler secrets set`.
  - Cloudflare: `wrangler secret put`.
  - GitHub Actions: `gh secret set`.
  - A `.env` file in a read-and-write folder.
  - The macOS Keychain.

  The value goes through stdin or the child's environment, **never the
  command line**, because arguments show up in `ps` and in Eavesy's own
  process list. `.env` writes are atomic and keep the file's permissions.
- **M4. Nothing downstream holds a value.** The thread, Activity log,
  memory, task replays, monitors and the second-model check see the handle
  and fingerprint only.
- **M5. Finding where a key is used.** Eavesy searches granted folders, and
  Doppler, wrangler and GitHub config, for the **variable name**
  (`POSTHOG_API_KEY`), never for the value. It shows what it found as rows
  you can untick.
- **M6. Rotation runs in a fixed order:**
  1. **Create** the new key. You sign in to the provider yourself if asked.
     The value goes to the Keychain (M2).
  2. **Write** it to every destination. One tier 3 card lists each one
     exactly (Doppler project, config and name; file path and variable;
     worker and secret name). Partial accept works (C2).
  3. **Check** each destination with a real call that uses the new key: the
     core runs it, and only pass or fail comes back.
  4. **Revoke** the old key, on a **separate tier 3 card that appears only
     after every check passed**. If any check fails, Eavesy stops, keeps
     the old key working, and says which destination failed.
- **M7.** "Always allow" (C3) never applies to secrets. In Ask and Auto
  each rotation is clicked through. In Bypass it runs without the cards
  but in the same order, and the old key is still revoked only after every
  check passed.

Example: "Rotate my PostHog API key." PostHog's docs describe creating a
personal API key in the web app, with the value shown once. Project secret
keys also have an API. Whether a personal key can be created through the API
is *unverified*, so v1 plans on the browser path (M2.2).
Eavesy opens PostHog's key settings in its own browser and asks you to sign
in if needed. It creates the key with the same scopes as the old one. Then
it shows the card: Doppler `eavesy/prd POSTHOG_API_KEY`,
`web/.dev.vars`, Cloudflare worker `eavesy-web`. It writes, checks each, and
then offers "Revoke the old key `phx_…41aa`".

### N. Eavesy as the middleman for other agents

Claude Code, Codex and cloud agents shouldn't each need their own computer
use, secrets access and cleanup powers. They ask Eavesy, and Eavesy does it
in front of you, under one set of rules.

- **N1. The tools.** Through MCP (F6):
  - `browser_task` and `computer_task`: a goal, the app or site, and limits.
  - `secret_rotate` and `secret_use`: run a command with a secret in its
    environment, and get back only the exit status and output with the
    value scrubbed.
  - The machine tools machine-companion already has.

  Results come back as text, not screenshots, unless you allow more.
- **N2. A request runs at the caller's tier, never Eavesy's.** An agent
  gets no more power by asking Eavesy than it has itself (architecture trust
  tiers). Its goal text is content (C4): it can't raise a tier or skip a
  card.
- **N3. Cards say who's asking.** "**Claude Code · eavesy repo** asks to
  rotate `POSTHOG_API_KEY`", never "you asked". The second-model check (C7)
  compares the action with the agent's request *and* says plainly that you
  didn't ask for it yourself.
- **N4. By tier:**

  | Caller | Can request | Never |
  |---|---|---|
  | Local agent (identified by peer pid) | Browser and computer tasks in apps you granted; secret rotation and use (cards every time) | Approving its own cards; seeing a secret value |
  | Browser extension | Nothing beyond what it has today | — |
  | Remote (cloud MCP via the Mac link) | A browser task in Eavesy's own browser, **signed-out profile only**, with a click per request; text results | Your apps, your signed-in browsers, secrets, process control, including by driving Activity Monitor or a terminal |

- **N5. One queue.** Agent requests join the attention queue (A3) like
  everything else, so you see them in the pill and the thread, in order.

## The interface

Mockups (private canvas): [Eavesy assistant UI](https://claude.ai/artifact/ToJYmfHh9SWmgwePWQcRe1).
It shows the panel today vs proposed, the four pill states, and the Eavesy
tab in light and dark, and Eavesy driving its browser while it rotates a key.

### What feels clunky today

Seen in the panel (light and dark) and the screenshot William sent on
2026-10-24:

1. **Dark mode is a black slab.** The panel's paper is `#161312` and its
   wells are *darker* (`#110F0E`), so the search box and the toolbar look like
   holes. The warmth DESIGN.md promises ("walnut and lamplight") exists only
   in Settings.
2. **Clicking in is a cut, not a move.** In the code today, clicking the
   pill hides it at once (`order_out`, `panel.rs` `show` → `hud::hide_on_main`).
   The panel then appears with no animation, as a translucent window in a
   different material: the pill is solid charcoal in both modes, and the panel
   follows the system theme. It reads as a second app.
3. **Live words collapse.** Mid-dictation, the pill shows one, two or four
   lines of live words. The panel's live bar shows one clipped line
   (`useLiveLines(…, 1)`), and the four capture buttons vanish into it. That's
   the "condensed and collapsed" feeling.
4. **Two or three mascots at once.** The title bar's mascot (which nearly
   vanishes in dark mode) plus the live bar's mascot, with the pill's own on
   screen too.
5. **The live bar is loud and cramped.** A big coral Stop with an `fn` keycap
   glued inside it; the ticker cut mid-word ("…ek is to finish").
6. **The search row does three jobs.** "Search captures, or / for prompts",
   a floating `/` keycap and an "All ⇅" pop-up, plus a thick cream focus
   ring in dark mode.
7. **The title bar has six things in it.** Close, mascot, name, project chip,
   avatar, gear.
8. **Keycaps everywhere.** `fn`, `/`, `⌘` `V` each drawn as separate caps.
9. **A fourth window.** The new reply card (PR 228) sits top right, away
   from the pill.

### The surfaces

```
 PILL (always on top, one per Mac)                 PANEL (opens from the pill)
 ╭───────────────────────────────╮                ┌───────────────────────────────┐
 │ [snoop] Eavesy's listening ▁▃▅ │  click / ⌘⇧Space│  Eavesy   Captures       ⚙   │
 ╰───────────────────────────────╯   ───────────▶  ├───────────────────────────────┤
          grows in place into:                     │ Needs you (2)                 │
 ╭───────────────────────────────╮                │  ▸ eavesy asks: ship behind…  │
 │ you  "what's still running?"   │                │  ▸ 3 worktrees can go         │
 │ eav  "Six dev servers. Two are │                ├───────────────────────────────┤
 │       from sessions that ended."│                │ Today                         │
 │       [▶ Repeat] [Reply] [Open]│                │  you · said   what's running? │
 ╰───────────────────────────────╯                │  eavesy · spoken  Six dev…    │
 ╭───────────────────────────────╮                │   ┌ Stop 2 leftovers ───────┐ │
 │ Stop 2 leftover processes?     │                │   │ ☑ vite  :5173  (ended)  │ │
 │ ☑ vite :5173  · eavesy (ended) │                │   │ ☑ bun test     (ended)  │ │
 │ ☑ bun test    · repackify      │                │   │      [Cancel] [Stop 2]  │ │
 │            [Cancel] [Stop 2]   │                │   └─────────────────────────┘ │
 ╰───────────────────────────────╯                ├───────────────────────────────┤
                                                   │ ( Ask Eavesy, or hold fn+Space)│
                                                   └───────────────────────────────┘
```

**The pill** is where you *hear and talk*. It keeps its fixed sizes per phase
(DESIGN.md §5) and adds three:

- **Talking** (400 × 62+): "Eavesy's listening", live captions of your words,
  the usual live-mic signal (coral dot, hat up) plus a manila mark that says
  this is a conversation, not a dictation.
- **Answer** (400 × 176): your line, its line, and **Repeat · Reply · Open in
  panel**. Its words appear as it speaks them, in time.
- **Needs you** (400 × 176): the front of the queue: an agent's question with
  the suggested reply (tier 2), or a tier 3 card. This replaces the separate
  reply card.

**The panel** is where you *read and go back*. Two tabs:

- **Eavesy**: "Needs you" at the top (the queue, collapsible), then the
  thread by day, then one composer: "Ask Eavesy…" with a talk button. Tier 2
  and 3 cards appear inline in the thread where they came up, and stay there
  afterwards with their result ("Stopped 2 · 4:12 PM").
- **Captures**: today's history, unchanged in behaviour, with the composer
  for notes ("Paste, drop a file, or jot a note…").

**Settings** gains: **Assistant** (personality, voice, talk shortcut, Hey
Eavesy), **Connections**, **Rules**, **Memory**, **Monitors**, **Files**,
**Activity**. Each shows its file path (H2).

### A turn in the thread

```
 you · said · 4:10 PM                                    [✎ Edit] [⧉]
 what's still running from today?

 eavesy · spoken · 4:10 PM                          [▶ Repeat] [↩ Reply] [⧉]
 Six dev servers. Two are from sessions that ended: vite on 5173 (eavesy,
 archived at 2:40) and bun test (repackify, ended at 3:05).
 ┌ Stop 2 leftover processes ──────────────────────────────────────────┐
 │ ☑ vite      pid 48211  :5173   eavesy · session ended 2:40 PM       │
 │ ☑ bun test  pid 49002          repackify · session ended 3:05 PM    │
 │ SIGTERM first; nothing else is touched.          [Cancel] [Stop 2]  │
 └─────────────────────────────────────────────────────────────────────┘
```

- Your turns: what you said, as transcribed; editable in place (B3).
- Its turns: full text; the part it spoke is not marked differently, it's
  simply the first sentence or two (B4).
- Cards are part of the turn that raised them and keep their outcome.
- Every turn has a quiet hover row; on the keyboard-focused turn it's always
  visible. `R` repeats, `E` edits, `⌘C` copies.

### Visual rules (added to DESIGN.md when step 1 ships)

- **One material.** The panel uses the pill's charcoal family in dark mode
  and the cream paper in light, with real vibrancy; wells are *lighter* than
  paper in dark mode (raised, not sunken), matching Settings' walnut.
- **Title bar:** close, the name (no mascot when the live bar or the
  conversation shows one), and Settings. The project chip moves to the
  composer's context line; the account moves into Settings' menu.
- **Search:** "Search" placeholder, filter as a small icon menu at the end,
  no keycap until the field is focused. Focus ring is 1px ink-3 plus a soft
  glow, not a 2px cream ring.
- **Live bar:** Stop is a 28px round coral icon button; the `fn` hint lives
  in its tooltip. The ticker cuts at a word boundary with a soft fade.
- **Keycaps:** one style, shown on hover or focus only, chords drawn as one
  cap (`⌘V`, not `⌘` `V`).
- **Motion:** the panel opens from the pill's position with a 240 ms
  scale-and-fade (`--ev-ease-out`), while the pill fades into it rather than
  vanishing, and closes back the same way. Reduced motion: a 120 ms
  cross-fade.
- **Live state carries over.** If the panel opens while something is live,
  the panel shows the same number of live lines the pill was showing, in the
  same order and the same quieter ink, at the top of the Eavesy tab. Nothing
  shrinks to one line, and nothing restarts.
- **Coral means the mic or screen is live, in every mode.** Manila marks
  Eavesy's own voice and the conversation (its turns, the "Eavesy's
  listening" mark, Repeat). Neither replaces the other.

## What changes in the other plans

- **agent-architecture.md, "No chat UI of our own"** → "A conversation with
  Eavesy, never a chat with someone else's model." Eavesy still doesn't
  wrap Claude or ChatGPT or show their chats; it has its own conversation
  about your Mac, your captures and your agents. Rule 4 (one way to
  interrupt) stands. Rule 6 (the human approves by click) gains one case:
  approval can also be a mode the human turned on by click (C8, Auto or
  Bypass), never one an agent, a tool or content turned on.
- **voice-conversation.md** — the reply card becomes a state of the pill
  (I1), and replies to agents land in the conversation thread as tier 2
  actions, so you can see what you sent.
- **machine-companion.md** — its confirm card is a tier 3 card; its
  monitors are D1 monitors.
- **agent-architecture.md, trust tiers** — local agents may *request*
  computer tasks and secret rotation, and remote agents may *request* a
  signed-out browser task, each behind a card (N4). Remote still gets no
  process control, grants or secrets.
- **self-hosted-meeting-bot.md** — its CDP client is shared with Eavesy's
  browser (L2).

## Decisions

Taken on 2026-10-24. William said to build all of it and to go with a Swift
driver; the rest take the recommended option and can be changed in Settings
or a follow-up PR.

1. **The model.** Conversation on Claude Sonnet 5.5 through Eavesy's cloud,
   Haiku 5.5 for summaries, suggestions and the C7 check.
2. **Talk shortcut.** `fn` + `Space`, plus "Hey Eavesy" once step 11 lands.
3. **Where the thread lives.** The panel's first tab.
4. **"Always allow" (C3).** Ships in the first version, scoped rules only.
5. **Personality default.** "Eavesy".
6. **Computer use engine.** Our own Swift accessibility driver; Claude's
   computer use tool only for the screenshot fallback.
7. **Remote agents and the browser (N4).** Allowed for signed-out browser
   tasks, with a click per request.
8. **Bypass length (C8).** "For an hour" is pre-selected; the other two
   choices are one click away.

## Build order

Each step ships on its own and is useful alone.

1. **The interface cleanup** (I2–I5): dark mode, title bar, search row, live
   bar, transitions. No new features; fixes what feels clunky today.
2. **The thread and captions** (B1–B4, B7): the Eavesy tab, typed
   conversation with tier 0 and 1 tools, Repeat, Edit, Reply.
3. **Talk to Eavesy by voice** (B5, B6): the shortcut, live captions in the
   pill, spoken replies, barge-in.
4. **The tier table, cards and modes** (C): tier 2 read-back, tier 3
   cards, Ask / Auto / Bypass, the Activity log; agent replies and machine
   cleanup move onto it.
5. **Settings: Assistant, Connections, Rules, Memory, Monitors, Activity**
   (F, G, H).
6. **Eavesy sets up its own connections** (F2) and the digest (D4).
7. **"Hey Eavesy"** (voice-conversation 3d).
8. **Hands** (L): Eavesy's browser and app grants, then accessibility
   actions, then the screenshot fallback. Local agents can call
   `browser_task` (N).
9. **Secrets** (M): handles in the Keychain, destinations (Doppler,
   wrangler, `gh`, `.env`), checks, then rotation with the two cards.

## Sources

Research of 2026-10-24. Vendor-reported numbers are the vendors'.

- Anthropic: [Claude Duet](https://claude.com/blog/claude-duet) ·
  [release notes](https://support.claude.com/en/articles/12138966-release-notes) ·
  [Cowork/desktop changelog](https://claude.com/docs/cowork/changelog) ·
  [voice mode](https://support.claude.com/en/articles/11101966-use-voice-mode) ·
  [Claude in Chrome safety](https://support.claude.com/en/articles/12902428-using-claude-in-chrome-safely) ·
  [Claude Code auto mode](https://claude.com/blog/auto-mode)
- OpenAI: [Computer Use](https://learn.chatgpt.com/docs/computer-use) ·
  [Codex permissions](https://learn.chatgpt.com/docs/permissions) ·
  [memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq) ·
  [personalities](https://help.openai.com/en/articles/20001038-using-chatgpt-personalities) ·
  Dots and recent release notes from secondary sources
  ([1](https://www.relevantaudience.com/ai/openai-dots-always-on-agents-chatgpt/),
  [2](https://releasebot.io/updates/openai/chatgpt)), *unverified*
- xAI: [Grok Bot](https://docs.x.ai/grok-bot/overview) ·
  [Grok Bot security](https://docs.x.ai/grok-bot/security) ·
  [release notes](https://docs.x.ai/developers/release-notes) ·
  [Common Sense Media on Grok](https://www.commonsensemedia.org/press-releases/grok-ai-chatbot-not-safe-for-teens-common-sense-media-report-finds)
- Google: [I/O 2026](https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/) ·
  [Gemini Live help](https://support.google.com/gemini/answer/15274899) ·
  [conversation design: confirmations](https://developers.google.com/assistant/conversation-design/confirmations)
- Apple: [Siri AI](https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/) ·
  [WWDC26 session 343](https://developer.apple.com/videos/play/wwdc2026/343/)
- Computer use: [ChatGPT Computer Use](https://learn.chatgpt.com/docs/computer-use) ·
  [Anthropic computer use best practices](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-best-practices) ·
  [computer-use MCP roundup](https://pinggy.io/blog/best_computer_use_mcp_servers/) (*third-party*) ·
  [PostHog personal API keys](https://posthog.com/docs/api/personal-api-keys) ·
  [PostHog project secret API keys](https://posthog.com/docs/api/project-secret-api-keys)
- Voice design: [Meta voice guidelines](https://developers.meta.com/horizon/design/voice/)
- Open source: [Hermes Agent](https://github.com/NousResearch/hermes-agent)
  (its `website/docs` and `SECURITY.md`) ·
  [OpenClaw](https://github.com/openclaw/openclaw) ·
  [OpenClaw workspace files](https://docs.openclaw.ai/concepts/agent-workspace) ·
  [agentskills.io spec](https://agentskills.io/specification) ·
  [Goose permissions](https://goose-docs.ai/docs/guides/goose-permissions) ·
  [Letta MemFS](https://docs.letta.com/letta-code/memfs)

Not found in any source, so not assumed: a live two-sided transcript with
replay in any lab's product, and a wake word on any lab's desktop assistant.
