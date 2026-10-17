# Architecture: one local hub for every AI agent

Status: proposal (2026-10-17). It builds on
[agent-connector.md](agent-connector.md), the research and feature plan. This
doc covers how the features fit together so they don't turn into a pile of
unrelated parts.

## The goal

Eavesy is an **open, local hub you control.** It makes every AI tool easier to
use from one place, wherever that tool runs:

- Claude Code or Codex in a terminal
- the Claude, ChatGPT or Cursor desktop apps
- claude.ai, chatgpt.com, grok.com or Gemini in a browser

Vendors will each ship their own version of parts of this, and each will only
work with its own agent. Eavesy's job is the layer that sits across all of
them, so it must never depend on any single vendor.

## Design rules (every feature must pass these)

1. **One model.** Every feature is described with the same five nouns and six
   verbs below. If a feature needs a new noun, stop and redesign.
2. **One core, thin adapters.** All state and logic live in one Rust core.
   Hotkeys, menubar, CLI, MCP, hooks, browser extension and the cloud are
   *adapters*: they translate, they don't decide.
3. **One event log.** Features talk to each other by emitting and reading
   events, never by calling each other directly. The UI, the audit trail and
   agent feeds all read the same log.
4. **One way to interrupt the human.** Every "look at this" (an agent waiting
   on you, a question, a secret request, memory pressure) goes through one
   attention queue and shows up in the HUD. Nothing else is allowed to pop up.
5. **Local first, cloud optional.** Everything works offline on the Mac. The
   cloud is only for sync and for reaching web-only clients.
6. **The human approves, the agent never holds secrets.** Secrets, file access
   and process kills need a click in Eavesy's own UI. No API, tool or agent can
   approve them.
7. **Fast or it doesn't ship.** Every step has a speed budget (see
   [Performance budgets](#performance-budgets)), and a slow adapter fails open
   rather than blocking an agent.
8. **Open by default.** Plain files, a documented local API, adapters that
   are mostly data files, self-hostable cloud, and no agent data sent anywhere
   you didn't ask for.

## The model: five nouns, six verbs

| Noun | What it is | Where it lives |
|---|---|---|
| **Item** | Anything captured or produced: dictation, clipboard, screenshot, file, meeting, note, an agent's saved output | Files in `~/Eavesy/…` plus the SQLite index (already exists) |
| **Session** | One agent conversation anywhere: a Claude Code session, a Codex thread, a ChatGPT tab, a Cursor chat | Session registry (SQLite) |
| **Process** | An OS process, linked to the session that started it | In-memory process table, plus events |
| **Grant** | Permission for a session to use a secret, a file or a capability, with a scope and an expiry | Grants table plus the Keychain |
| **Event** | Something that happened, recorded with a time and usually a session | Append-only `events` table |

| Verb | Direction | Example |
|---|---|---|
| **capture** | world → Item | Hotkey dictation, screenshot, clipboard, meeting |
| **send** | Item → Session | "Send this voice note to the Claude Code session in eavesy-public" |
| **ask** | Session → human → Session | An agent asks a question; you answer by voice in the HUD |
| **grant** | human → Session | Approve `DATABASE_URL` for `npm run dev` in this session |
| **run** | Session → Process | An agent starts a dev server through `start_service` / `eavesy run` |
| **watch / stop** | human ↔ Process | See what each session is running and stop it |

Every feature from the plan maps onto this model. That mapping is the check
against building one-off parts:

| Feature | Noun + verb |
|---|---|
| Dictation and paste (exists) | capture Item → send to the frontmost Session |
| "Send to agent" picker | send Item → chosen Session |
| Agent waiting / reply by voice | Event (session.waiting) → attention queue → capture → send |
| `ask_human` tool | ask |
| Agent Watch | watch Processes grouped by Session |
| Orphan cleanup and pressure guard | Events (process.orphaned, machine.pressure) → attention queue → stop |
| `start_service` | run |
| Secrets via `eavesy run` | grant → run |
| `request_file` | grant (file) → Item |
| ChatGPT "send to my Mac" | capture (remote) → Item → send |
| Meetings MCP (exists) | read Items |

## Shape of the system

```
                     ┌─────────────────────── Eavesy.app (one process) ───────────────────────┐
                     │                                                                         │
  Human surfaces     │   UI: launcher · Agents · Inbox · HUD (single attention queue)          │
  hotkeys, menubar ──┼──▶                         ▲                                            │
                     │                            │ subscribes                                 │
                     │   ┌────────────────────── eavesy-core (Rust crate) ──────────────────┐   │
                     │   │  store (items)  registry (sessions)  monitor (processes)        │   │
                     │   │  grants (+Keychain)  router (delivery)  policy  ── events log ──│   │
                     │   └───────────────▲──────────────────▲─────────────────▲────────────┘   │
                     │                   │ local API         │ native messaging │ Mac link    │
                     └───────────────────┼──────────────────┼─────────────────┼──────────────┘
                                         │ unix socket      │                  │ outbound WebSocket
             ┌───────────────────────────┴───┐     ┌────────┴────────┐   ┌─────┴──────────────────┐
             │ `eavesy` CLI (thin client)     │     │ Browser         │   │ workers/mcp (cloud)    │
             │  mcp   → Claude Code, Codex,   │     │ extension       │   │  MacLink Durable Object│
             │          Cursor, Claude Desktop│     │ claude.ai,      │   │  remote MCP (same tool │
             │  hook  → all agents' hooks     │     │ chatgpt.com,    │   │  spec, filtered)       │
             │  run   → tagged + secrets      │     │ grok.com, …     │   │  ← ChatGPT, claude.ai, │
             │  ps / stop                     │     └─────────────────┘   │    Grok, phone         │
             └────────────────────────────────┘                           └────────────────────────┘
```

### The core (`eavesy-core`)

A Rust library crate that holds **all** state and rules. Today's `desktop/src-tauri`
code (store, sqlite, sync, fs_writer, fs_watcher) moves into it over time. New
modules:

- **events**: an append-only table plus an in-process broadcast channel.
  Every module writes here. The UI, the local API stream and the Mac link
  subscribe to it.
- **registry**: tracks Sessions. It gets them from hooks (CLI agents), the
  extension (web tabs) and window detection (desktop apps). Each session is
  keyed by `(client, native_id)`, has a status
  (`working | waiting | idle | ended`), and keeps whatever helps deliver
  messages to it: cwd, pids, tty, window or tab.
- **monitor**: watches processes. See [agent-connector.md](agent-connector.md),
  Architecture → process monitor. It only emits events
  (`process.started/orphaned/exited`, `machine.pressure`) and never acts by
  itself.
- **router**: delivers an Item to a Session through whichever delivery method
  that session supports (see the table below).
- **grants**: approvals, scopes and expiry; secret values stay in the Keychain.
- **policy**: the user's rules (auto-stop orphans? limit on heavy jobs?
  allowlist). It reads events and makes decisions, and every decision is an
  event too.
- **attention**: a priority queue of things the human should see, with
  de-duplication and rate limiting. The HUD shows only what comes out of this
  queue.

**It stays in the app's process for now. That's a deliberate choice.** A separate
background daemon would survive UI crashes. It would also double the
signing, notarization, update and IPC work. Because the core is a crate behind
a socket API, it can move into a `launchd` agent later without changing any
adapter. Revisit if the app's uptime turns out to be a problem.

### The local API

- **Transport:** a Unix socket at
  `~/Library/Application Support/com.eavesy.desktop/eavesy.sock` with 0600
  permissions, so only the user can reach it. No TCP port by default. A
  loopback port only gets added if a client can't use sockets, for example
  Claude Code HTTP hooks; the CLI wrapper covers that case anyway.
- **Shape:** JSON requests mirroring the verbs (`items.search`, `send`, `ask`,
  `grant.request`, `services.start`, `processes.list`, …) plus an
  `events.subscribe` stream.
- **Documented and versioned.** It's a public, open contract that other tools
  can build on.

### One tool spec, two MCP servers

The local MCP (`eavesy mcp`, stdio) and the remote MCP (`workers/mcp`) expose
**the same tool names and schemas**, defined once in `spec/agent-tools.json`.
Each server shows only the tools its trust tier allows. A contract test fails
CI if either server drifts from the spec.

| Tool (canonical) | Local | Remote | Notes |
|---|---|---|---|
| `search`, `get`, `recent` | ✓ | ✓ | Replaces `search_meetings`, `get_meeting`, `recent_meetings` and `search_dictations`. The old names stay as aliases for one release |
| `action_items` | ✓ | ✓ | Today's `get_action_items` |
| `save` (agent output → Item) | ✓ | ✓ (write scope) | Fills the `write` scope that exists but has no tools yet |
| `send_to_human` | ✓ | ✓ | Puts a message or Item in your Inbox |
| `ask_human` | ✓ | ✓ via the Mac link | Waits up to N minutes for an answer; uses MCP elicitation where the client supports it |
| `inbox` | ✓ | — | Items you sent to *this* session |
| `machine_status` | ✓ | opt-in summary | Running services, memory pressure, other agents |
| `start_service` / `list_services` / `service_logs` / `stop_service` | ✓ | — | |
| `request_grant` | ✓ | — | Returns only granted or denied, **never a value** |

### Trust tiers

| Tier | Who | Can |
|---|---|---|
| Human | Eavesy UI, hotkeys | Everything; the only tier that can approve grants and kills |
| Local agent | CLI and stdio MCP (same user) | Read Items, send/ask, run services, *request* grants, stop its *own* processes |
| Browser extension | Your browser, authenticated by native messaging | Register tabs as Sessions, receive delivered Items, capture page content |
| Remote | Cloud MCP via the Mac link | Read synced Items, `save`, `send_to_human`, `ask_human`. Local-only Items need a per-request approval in the HUD. **No processes, no grants, ever** |

## Making it work with every client

Every client gets the same five abilities. The adapter is the only thing
that changes between clients.

| Client | How Eavesy finds its sessions | How Eavesy sends to it | How it reaches Eavesy | Process watch |
|---|---|---|---|---|
| Claude Code, Codex, Cursor CLI (terminal) | Hooks: SessionStart/End, Stop. Also detected by executable name with no setup | Focus the terminal tab by tty (Terminal and iTerm2 via AppleScript; others by spike) and paste. Fallback: inbox plus a context note on the next prompt | `eavesy mcp` (stdio) | Full, tagged by `EAVESY_SESSION` |
| Claude Desktop, ChatGPT app, Cursor app | Accessibility window list (title = session) | Focus the window and paste into the composer. This is today's dictation path | Claude Desktop and Cursor: `eavesy mcp`. ChatGPT app: remote MCP | Desktop apps run their own helpers; watched by ancestry, not tagged |
| claude.ai, chatgpt.com, grok.com, Gemini (web) | The extension reports open chat tabs | The extension inserts text and attaches files in that tab's composer | Remote MCP through the Mac link | n/a |
| Anything else | — | Clipboard plus focus | Any MCP client: local or remote | Ancestry heuristics |

Adapters are **data where possible**: `adapters/<client>.toml` holds the
process-name patterns, the hook install template, the delivery method, and
CSS selectors for web composers. When a vendor changes its UI, the fix is a
data change, not new code. Support for a new tool can be contributed as a
small file.

**The browser extension is required** for the "even if it's in the browser"
goal. Without it, web chats only get clipboard support. It talks to the app
through **native messaging**: no open port, and the browser identifies the
extension to the app. Chrome and other Chromium browsers come first; Safari
later as a Safari Web Extension bundled in the app.

## The four main flows, end to end

**1. Talk to an agent.** Hold the dictation hotkey and the HUD opens with a
**target already chosen**: the session that's waiting on you, otherwise the
one you used last, otherwise the frontmost window. Speak, then release.
On-device captions finish the text and the router delivers it. Tab or arrow
keys pick a different target while you're still talking. In the common case
you never click anything. The same picker works for a screenshot or clipboard
item ("send this to…").

**2. An agent needs you.** A Claude Code Stop hook, an `ask_human` call, or a
ChatGPT tool call through the Mac link becomes an event
(`session.waiting` / `ask`). The attention queue then shows it in the HUD
with the session's name. You answer by voice or text, and the answer goes
back to the waiting tool call. For a plain "waiting" session it's sent as
flow 1.

**3. An agent needs a secret or a file.** The agent calls
`request_grant("DATABASE_URL", reason)` or runs `eavesy run -- npm run dev`.
The attention queue shows an approval sheet naming the session, the command
and the value names. You approve, and the value is injected into that child
process only. The agent sees `granted` and the command's output, never the
secret. Every step is logged as an event.

**4. The Mac gets heavy.** The monitor emits `machine.pressure` and
`process.orphaned`. Policy decides between showing a notice and stopping
automatically (only if you turned that on). The attention queue shows one
grouped notice: "3 leftover dev servers from ended sessions, 4.2 GB. Clean
up?" In parallel, the SessionStart context and `machine_status` keep agents
informed, so they cause fewer of these in the first place.

## Performance budgets

| Step | Budget |
|---|---|
| Hotkey → HUD visible with target chosen | < 50 ms |
| End of dictation → text delivered (on-device captions) | < 300 ms |
| Hook round trip (`eavesy hook` → core → back) | p50 < 10 ms, p99 < 50 ms; fails open at 250 ms |
| CLI cold start | < 10 ms (small Rust binary, no async runtime for one-shot commands) |
| Monitor overhead | < 1% of one core. Lists pids every 2 s; reads details and env only for **new** pids |
| Local MCP `search` | < 50 ms (local SQLite FTS; no network) |
| Remote → Mac link → reply | < 500 ms when the Mac is online; queued in `drops` when it's offline |

Every budget gets a benchmark in CI or a timing in the diagnostics bundle.
We measure them rather than assume them.

## Where things live in the repo

```
spec/agent-tools.json          tool schemas (single source; TS + Rust types generated or contract-tested)
adapters/*.toml                per-client data: detection, hooks, delivery, web selectors
desktop/crates/eavesy-core/    state + rules (store, events, registry, monitor, grants, router, policy, attention, api)
desktop/crates/eavesy-cli/     thin client: mcp | hook | run | ps | stop  (talks to the socket only)
desktop/src-tauri/             app shell: windows, tray, HUD, hotkeys, Swift sidecar → calls core
extension/                     Chromium MV3 extension + native-messaging host manifest
workers/mcp/                   remote MCP + MacLink Durable Object, implementing spec/agent-tools.json
plugins/eavesy/                Claude Code plugin: local + remote MCP config, hooks, skill
```

The existing modules move into `eavesy-core` *only when they're next
touched*. There's no big-bang refactor.

## Deliberate choices and pushback

- **No chat UI of our own.** Eavesy sends to the tools you already use and
  doesn't try to replace them. Once Eavesy has a chat box, it's competing
  with Claude and ChatGPT instead of making them better.
- **No orchestrator and no required launcher.** `eavesy run` is optional. Watch
  works without it, and tagging just makes it more precise. Making agents
  run "through Eavesy" would make Eavesy a dependency people resent.
- **No private vendor APIs and no reading chat contents.** The extension
  inserts into composers and reads only what you ask it to capture. Reading
  everyone's chats would get the extension rejected from stores and would
  break trust.
- **Some web delivery will break.** Composer selectors change. Keeping
  adapters as data, plus a "fell back to clipboard" notice, keeps that
  annoying rather than fatal.
- **A running CLI session can't be fully driven from outside.** There's no
  vendor API to inject a prompt into a live Claude Code or Codex session.
  Focus-and-paste plus the inbox is the honest way to do it. If vendors add
  an API, it becomes one more delivery method in the router.
- **The Mac link is a new Durable Object binding.** Under AGENTS.md, a wrangler
  binding change means "stop and ask" before merge. Grants also touch
  security, so the same applies.

## Build order (each step ships on its own)

Ordered by dependency. Later steps reuse earlier ones and never route around
them.

1. **Core skeleton:** the `eavesy-core` crate with events, the attention
   queue, the session registry and the local socket API. Move the HUD
   notices that already exist onto the attention queue.
2. **Agent Watch:** the monitor plus the Agents view, with zero-setup
   detection. *This is the first thing users see.*
3. **CLI and hooks:** `eavesy hook`, `eavesy ps/stop`, `eavesy hooks
   install`, and the plugin's hooks. Sessions get names and statuses;
   leftover processes get cleaned up when a session ends; the Stop hook asks
   agents to clean up.
4. **Local MCP plus the tool spec:** `spec/agent-tools.json`, `eavesy mcp`,
   the remote MCP moved onto canonical names, `machine_status` and the
   `start_service` tools.
5. **Send and ask:** the target picker in the HUD, the router (desktop apps
   and terminals), `ask_human`, and reply by voice.
6. **Browser extension:** web tabs become sessions and delivery targets.
7. **Mac link:** the MacLink Durable Object; web clients get `ask_human`,
   `send_to_human` and approved local Items. **Stop and ask before merging.**
8. **Grants:** `request_grant`, `eavesy run` secrets, Keychain, audit.
   **Stop and ask before merging.**

## Decisions needed from William

1. Is the browser extension in scope? It's the only way to meet the "even in
   the browser" goal properly. It adds a store listing and a support load.
2. Should Eavesy stay in the app's process (recommended) or become a
   separate background daemon now?
3. Is renaming the remote MCP tools (with aliases kept for one release) OK?
   Existing connections keep working throughout.
4. Is Mac link off by default (more private) or on by default (more
   seamless)? I recommend off, turned on in onboarding with one switch.
