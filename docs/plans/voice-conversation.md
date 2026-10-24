# Plan: talk with your agents, and have them talk back

Status: proposal (2026-10-23). It builds on
[agent-architecture.md](agent-architecture.md) (flows 1 and 2: **send** and
**ask**) and doesn't change its model, trust tiers or build order. Where the
two disagree, the architecture doc wins.

## The problem

Dictation today goes one way. You talk, Eavesy pastes text where the cursor
is, and that's it. The agent can't tell you it's done, can't ask you
anything out loud, and can't push back on a vague request before it starts
work. Most of William's agent use is dictating to Claude (desktop app, mostly
the Code tab) and ChatGPT, so that one-way gap is felt every day.

What we want:

1. **Talk to an agent** from anywhere, into the session you mean.
2. **Hear it back:** a short spoken summary when it finishes, a spoken
   question when it needs you.
3. **Clarify before sending:** a quick back-and-forth that turns a ramble into
   a complete request, so the agent does the right thing the first time.
4. **Work in both the Claude desktop app and the CLI.** ChatGPT second.

## Which surfaces, and how far each can go

The Claude desktop app's **Code tab** and the **CLI** run the same Claude Code
engine, so hooks, plugins and MCP config mostly carry over between them.
Desktop **chat** and ChatGPT have no hooks; they only reach Eavesy through MCP.

| Surface | Send (you → agent) | Know it's done or waiting | Get its reply | MCP |
|---|---|---|---|---|
| Claude Code CLI | A **channel** (pushes into the live session, two-way) or focus-and-paste | `Stop` hook; `Notification` hook (`permission_prompt`, `idle_prompt`) | `Stop` hook's `last_assistant_message` | `eavesy mcp` |
| Claude desktop, Code tab | Focus-and-paste into the composer (today's dictation path) | Same hooks, *if* the Code tab runs user hooks (spike) | Same, if hooks run (spike) | Same plugin, if it loads (spike) |
| Claude desktop, chat | Focus-and-paste | Only if the agent calls an Eavesy tool | Only what the agent sends to an Eavesy tool | `eavesy mcp` (local) |
| ChatGPT app | Focus-and-paste | Only if the agent calls an Eavesy tool | Only what the agent sends to an Eavesy tool | Remote MCP (needs the Mac link) |
| Web chats | The extension (architecture step 6) | Only if the agent calls an Eavesy tool | Same | Remote MCP |

**The design follows from that table: the agent tells Eavesy, Eavesy doesn't
scrape the agent.** One mechanism works on every surface: Eavesy's MCP tools,
plus a short instruction telling the agent to use them. Hooks are the zero-
cooperation fallback for Claude Code, and a channel is the better delivery
path for the CLI. Reading chat windows through Accessibility is out
(architecture: "no reading chat contents"), since it breaks with every UI
change anyway.

**If only one can go first: the Claude Code engine (Code tab + CLI).** It has
hooks, it's where the real work happens, and the same work covers both
places you use it. Desktop chat comes along almost free through the MCP tools.

## How it fits the model (no new nouns)

| Feature | Noun + verb |
|---|---|
| Talk to an agent | capture Item (dictation) → **send** to a Session (exists as flow 1) |
| Clarify mode | capture → a refine step that may **ask** you → **send** |
| Hear it back | Event (`session.waiting`, `session.finished`, `send_to_human`) → attention queue → **spoken** as well as shown |
| Agent asks out loud | **ask** (`ask_human`) → spoken question → your voice answer |

Speech is a second way the HUD presents what comes out of the attention
queue. It isn't a new channel for interrupting you: anything that can be
spoken must first be allowed onto the queue, with the queue's de-duplication
and rate limits (architecture rule 4).

## The pieces

### 1. Speak: a voice for the HUD

- The Swift sidecar gets a `speak(text, voice)` call. v1 uses
  `AVSpeechSynthesizer` with a Premium/Personal Voice: on-device, free and
  instant. A hosted neural voice can come later as a setting.
- Pressing the dictation hotkey, or just starting to talk, stops speech right
  away (barge-in). v1 is turn-based; true full-duplex is step 6.
- Per-session and global mutes. Default: speak only when the HUD would have
  shown a card *and* you haven't touched the target app in the last few
  seconds (you're looking away).
- What gets spoken is always **one or two sentences**. Details stay on screen
  in the HUD card.

### 2. Agent-pulled tools (works in every MCP client)

Both tools already exist in the architecture's tool spec. This plan only adds
a voice field and the instructions that get agents to use them:

- `send_to_human({ text, spoken? })`: `spoken` is a one-sentence version to
  read aloud. Without it, Eavesy summarizes `text` (piece 4).
- `ask_human({ question, spoken?, choices? })`: it's spoken, and the HUD
  listens for a voice answer. The return values don't change (`answered`,
  `dismissed`, `timeout`, `mac_offline`).
  - The microphone opens only after the spoken question ends, stays open for
    at most 30 s of silence, and the HUD shows it's listening the whole time.
  - The transcribed answer shows in the HUD before it's returned. A pick from
    `choices` is read back ("Sending: option 2, *staging*"), and you confirm
    with Return or a click. Otherwise it's sent after you stop talking, with
    a short Undo.
  - An answer is data for the agent, **never an approval**. Saying "yes" to
    a question doesn't approve a tool call, a grant or a stop.
- **The instruction:** the plugin skill, a Claude Desktop project
  instruction and a ChatGPT custom instruction all say the same thing: "When
  you finish a task or need a decision, call `send_to_human` / `ask_human`
  with a one-sentence spoken version." That makes desktop chat and ChatGPT
  work without hooks.

### 3. Claude Code hooks (no cooperation needed)

Shipped in `plugins/eavesy` and through `eavesy hooks install` (architecture
step 3):

- `Stop`: forward `session_id`, `cwd` and `last_assistant_message` to
  Eavesy. Use `last_assistant_message`, not the transcript file: the docs say
  the transcript is written asynchronously and can lag.
- `Notification` with `permission_prompt` / `idle_prompt`: mark the session
  as waiting on you, and speak "Claude in *eavesy* needs approval to run a
  command."
- The hook stays fail-open with the usual 250 ms budget. Summarizing happens
  in the app, after the hook has already returned.

### 4. Summarize and clarify (the small model)

One small, fast model call with one prompt each:

- **Summarize:** a turn's final message → "Done: changed three files, tests
  pass. Want a PR?" Skipped when the agent already sent `spoken`.
- **Clarify (opt-in, per send):** your dictation plus a little context →
  either "ready" or **at most two** questions. The questions are spoken.
  - **What leaves the Mac, exactly:** your dictation, the target session's
    name and cwd, and the front app's name and window title (the metadata
    `front_window.rs` already reads, never window contents). Eavesy library
    results go along only when you ask ("check my notes on…"), and the HUD
    lists the items it found before they're sent.
  - **Everything clarify reads is data.** Window titles and library results
    can carry injected text, so they only help the model ask better
    questions. The final request is built from your dictation and your
    answers, nothing else.
  - **Nothing is sent until you confirm.** The final request waits in the
    HUD ("Sending: …") for Return, a click or saying "send it", with Edit and
    Cancel. Silence never sends. An auto-send countdown may come later as a
    setting, off by default.
  - Hold a modifier to skip clarify for one send.
- **Model:** Claude Haiku-class by default. Where the call runs and who pays
  is decision 2 below. Whatever runs it, this sends text to a model provider,
  so it's off until you turn it on, and Settings names the provider (rule 8).

### 5. A channel for the CLI (better delivery)

`eavesy mcp` also declares the `claude/channel` capability. Then:

- Dictation sent to a CLI session arrives as a `<channel source="eavesy">`
  event in the live session. No focus-stealing, no paste, no wrong-window
  risk. Channels are the vendor API that the architecture doc's
  pushback section was waiting for; it now lists them as one more delivery
  method in the router.
- **Who can push into a session:** only the app's router. Claude Code starts
  `eavesy mcp` over stdio, and `eavesy mcp` gets what it delivers only from
  the app over the local socket (peer-checked, architecture "The local API").
  It opens no HTTP port, so no other local sender can reach the channel.
- The `reply` tool is `send_to_human`, so it's spoken like everything else.
- **Permission relay stays off in v1.** Every tool approval still needs a
  click in Claude Code or in Eavesy's own UI (architecture rule 6). Approval
  by voice is decision 4.
- Limits, as of 2026-10-23: channels are a research preview. Custom channels need
  `--dangerously-load-development-channels` until they're allowlisted, they
  don't load with `-p` or the Agent SDK, and they may not exist in the
  desktop Code tab at all (spike). So this is an upgrade for the CLI, not the
  base.

### 6. Full-duplex voice (later, optional engine)

A real back-and-forth where you can interrupt and it backchannels, instead of
taking turns. The "brain" still has to be a model that can read code and call
tools, so a full-duplex model can only be the **voice front end** that hands
real work to the agent session as a tool call.

| Option | Fit |
|---|---|
| OpenAI Realtime (`gpt-realtime`) | Full-duplex, supports tool calls, hosted. The practical choice if this ships soon. *Not checked against OpenAI's docs for this plan; verify before step 6* |
| Open full-duplex models (NVIDIA PersonaPlex, Moshi-family) | Local, but the large ones want datacenter GPUs. Watch |
| **Dessa** (Block) | Speech-only: trained on audio, no text, so it can't read code or call tools by itself. Its announcement says it runs locally on an M4 Max, but it isn't released ("launch links coming soon"). Re-evaluate once it ships *and* has a way to pass text or tool calls in and out |

Step 6 waits until steps 1 to 4 prove people want to talk with agents at all.

## Safety

- **No approvals by voice in v1.** Tool permissions, grants and stops still
  need a click (architecture rule 6). Voice can *read out* what's being
  asked.
- **Spoken and gathered text is untrusted.** Agent output, window titles and
  library results can all carry injected text from a web page or a file. TTS
  only speaks it, and clarify only reads it. Nothing is ever turned into a
  request or a command unless you said it.
- **Clarify never sends without your confirm.** The final request waits in
  the HUD until you confirm it. Silence never sends.
- **Voice answers are data, not approvals.** An `ask_human` answer goes back
  to the agent as text. Picks from a list are read back first.
- **Remote stays remote.** A `send_to_human` that arrives through the Mac link
  is spoken only if you turned that on, and the voice says where it came from
  ("ChatGPT says…").

## Performance budgets

| Step | Budget |
|---|---|
| Stop hook fires → speech starts | < 1.5 s with summarize, < 300 ms with `spoken` |
| You start talking → speech stops | < 100 ms |
| End of your answer → next clarify question starts (or "ready") | < 1 s |
| `speak()` call → first audio (on-device voice) | < 150 ms |

## Build order

The voice pieces sit on top of the architecture's build order and never route
around it: speaking needs the attention queue (architecture step 1), hooks
need step 3, and the tools need steps 4 and 5.

0. **Spikes (throwaway):**
   - Does the desktop Code tab run hooks from `~/.claude/settings.json` and
     load plugins? Does it support channels?
   - Do Claude Desktop chat and ChatGPT reliably call `send_to_human` when
     told to in a project or custom instruction? Run 20 tasks on each. Step 3
     goes ahead for a client that calls it in at least 17 of 20. Below that,
     the client gets hooks or paste only.
   - Measure `AVSpeechSynthesizer` latency and quality with Premium voices
     on macOS 26.
1. **Speak:** sidecar TTS, barge-in, mutes, the attention queue reading cards
   aloud. Depends on architecture step 1.
2. **Claude Code hooks to speech:** `Stop` and `Notification`, summarizing in
   the app. Covers the CLI, and the Code tab if the spike says yes.
3. **Voice on `send_to_human` / `ask_human`, plus the instruction snippets.**
   This is what brings in desktop chat and ChatGPT.
4. **Clarify mode.**
5. **CLI channel delivery.**
6. **Full-duplex engine**, if steps 1 to 4 get real use.

## Decisions needed from William

1. **Where to start:** the Claude Code engine (Code tab + CLI), with desktop
   chat through MCP tools (recommended), or desktop chat first?
2. **Who runs the summarize/clarify model:** your own Anthropic API key in
   Settings (simplest, private, you pay per use), or through Eavesy's cloud
   (works signed-in with no key, we pay, needs a usage cap)?
3. **Is a talking clarifier OK under "no chat UI of our own"?** It's narrow by
   design: at most two questions, then it hands off, and the real conversation
   stays in your agent. I think that keeps within the rule. If you disagree,
   drop step 4.
4. **Voice approvals, ever?** If yes, only for tools you mark low-risk, and
   only after Eavesy reads back exactly what will run and you confirm.
5. **Default for speaking replies:** on when you're away from the target app
   (recommended), always, or only on request?

## Sources

- Claude Code hooks (Stop's `last_assistant_message`, Notification types):
  https://code.claude.com/docs/en/hooks
- Claude Code channels (capability, reply tool, permission relay, research
  preview limits; read 2026-10-23):
  https://code.claude.com/docs/en/channels-reference
- Dessa announcement page (pasted by William, 2026-10-23). The claims about
  local M4 Max inference and the release are the lab's own and unverified.
- Full-duplex landscape (single and secondary sources; verify before public
  copy):
  - https://dev.to/breachprotocol/nvidias-open-full-duplex-voice-model-wants-an-80gb-gpu-4k58
  - https://seed.bytedance.com/en/blog/introducing-seed-full-duplex-speech-llm-attentive-listening-robust-interference-suppression-enabling-more-natural-interaction
