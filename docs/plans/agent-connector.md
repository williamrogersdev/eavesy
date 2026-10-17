# Plan: Eavesy as the connector between you, your agents, and your Mac

Status: proposal (2026-10-17). Research notes and sources are at the end.

> **How the pieces fit together is defined in
> [agent-architecture.md](agent-architecture.md).** That doc is the source
> of truth for the core model, the trust tiers and the build order; its
> numbered build order replaces the phases below where they differ. It also
> adds two things this plan lacked:
> - a browser extension, so web chats are first-class;
> - the Mac link, which lets web clients reach the Mac.
>
> This doc keeps the research and the detail behind each feature.

## The problem, in two parts

1. **Bridging.** Getting things *to* agents is slow and awkward. That covers a
   voice note, a screenshot, an env var, a local file, or an answer to the
   question an agent just asked. It means copy-paste between Claude Code,
   claude.ai, ChatGPT, Cursor and Codex, odd permissions, and secrets pasted
   into chat.
2. **Supervision.** Agents start dev servers, watchers, test runners and
   browsers and don't clean them up. The Mac slows down or crashes, and you
   can't see what's running or which agent started it.

## The one-line position

> **Eavesy is the human's control panel for the AI agents on their Mac:**
> **talk to them, hand them things safely, and see and stop what they run.**

Meetings, dictation and captures stay, but as *inputs* to this. This goes past
what ROADMAP.md already promises ("drop anything in, get context out for any
agent") and adds the reverse direction plus supervision.

## Why Eavesy is well placed (what already exists)

| Need | Already in the repo |
|---|---|
| Voice → text, fast | Dictation hotkey, on-device captions, and paste the moment recording stops (`dictation.rs`, `captions.rs`) |
| Deliver text to a specific window | Focused-target tracking by pid/AX, with fallback to the clipboard (`dictation.rs`, `commands.rs`) |
| Capture screen and clipboard | `visual.rs`, the Swift sidecar |
| Agent-readable store | `~/Eavesy/Recordings`, synced both ways (`fs_writer.rs`, `fs_watcher.rs`) |
| Remote MCP with OAuth and scopes | `workers/mcp`. A `write` scope exists but has no tools yet |
| Claude Code plugin | `plugins/eavesy`. The README already reserves `eavesy mcp` (local stdio) |
| Menubar, HUD, notifications, Keychain | `tray.rs`, `hud.rs`, notification plugin, `settings.rs` |

What's missing is a **local agent endpoint** (no local server, socket or CLI
exists today) and any **process awareness**.

## What the research says (short version)

- **The orphan-process problem is real, and the vendors aren't fixing it.**
  claude-code #43944 (an orphaned `next dev` grew to 8+ GB) was closed as "not
  planned". #26658 reports about 96 orphaned MCP processes a day. #16198 found
  `wrangler dev` holding 2.5 GB for two days. On Codex, #25388 and #25744 report
  zombie processes and CPU-pinning orphans. At least eight indie tools appeared
  in 2025–26 for this (LeftOpen, Portreaper, devreap, devglow, and others).
  They work from **ports and orphaned parent processes only**. None knows
  *which agent session* started a process.
- **All three major agents now have hooks.** Claude Code, Codex and Cursor each
  fire session start/end and before/after shell-command hooks, and each passes
  a `session_id`. Claude Code also supports HTTP hooks and OpenTelemetry
  export. Cursor's `sessionStart` can inject env vars. That's enough to tag
  every process an agent starts.
- **No root or Endpoint Security is needed.** Same-user process listing, the
  parent/child tree, memory and CPU use, listening ports, and each process's
  args and env (`KERN_PROCARGS2`) are all readable with `libproc`/`sysctl`.
  Endpoint Security needs an Apple entitlement and a system extension, which
  is far too heavy for v1.
- **Secrets are under-served across clients.** 1Password `op run` and
  `doppler run` inject secrets into a child process. No tool asks the human at
  the moment an agent needs a secret, across every client, with an audit
  record per session. MCP's **URL-mode elicitation** spec says secrets must
  never pass through the LLM, which is exactly the shape we want.
- **Voice-to-agent is starting.** Superwhisper shipped a CLI and MCP in July
  2026. Nobody routes a voice note to a *chosen running agent session*.
- **ChatGPT only reaches remote HTTPS MCP servers.** Local stdio isn't an
  option there. Claude Code, Codex, Cursor and Claude Desktop can use local
  servers.
- **Agent orchestrators churn fast.** Crystal was deprecated, Vibe Kanban's
  company shut down, and Conductor and Claude Squad are worktree managers. **Don't
  build another orchestrator.** Supervise whatever agents the user already
  runs.

## Architecture

```
 Claude Code ─┐  hooks (HTTP / `eavesy hook`)      ┌───────────────────────────┐
 Codex CLI  ──┼──────────────────────────────────▶ │  Eavesy.app (Rust core)   │
 Cursor     ──┘  local MCP (`eavesy mcp`, stdio)   │                           │
                                                   │  agents::server           │  127.0.0.1 + per-install token
 `eavesy run -- npm run dev`  (tag + secrets) ───▶ │  agents::registry         │  sessions, status, cwd, title
                                                   │  agents::monitor          │  libproc poll + kqueue exits
                                                   │  agents::grants           │  secrets/file approvals + audit
                                                   └──────┬──────────┬─────────┘
                                                          │          │
                                         menubar "Agents" + HUD     workers/mcp (remote)
                                         notifications, voice reply  ChatGPT / claude.ai → drops inbox
```

New pieces:

1. **`eavesy` CLI**: one small Rust binary, bundled in the app and linked by
   the Homebrew cask. It does no work itself; it talks to the running app.
   - `eavesy mcp` runs the local stdio MCP server (the one the plugin README
     already promises).
   - `eavesy hook <agent> <event>` reads the hook JSON on stdin and forwards
     it to the app. The app must never block the agent: time out quickly and
     fail open.
   - `eavesy run [--session ID] -- <cmd>` launches a command with a session
     tag and approved secrets.
   - `eavesy ps` / `eavesy reap` give you the monitor from the terminal.
2. **Local endpoint in the app** (`desktop/src-tauri/src/agents/`). It listens
   on 127.0.0.1 only and needs a random bearer token stored with 0600
   permissions in Application Support. A Unix socket would be better if HTTP
   hooks don't need TCP.
3. **Session registry**, a SQLite table in the existing desktop DB. It holds
   agent, session_id, cwd, title, started/ended, status (working, waiting on
   you, idle, ended) and its root pids.
4. **Process monitor.** It polls `proc_listallpids` and `proc_pidinfo` every
   ~2 s and watches known pids for exit with `kqueue`. It assigns each process
   to a session in this order:
   1. `EAVESY_SESSION=<id>` in the process env (set by hooks or `eavesy run`).
      The env survives `setsid`/re-parenting.
   2. Being a descendant of a known agent process. It snapshots the tree while
      the agent is alive, because a process re-parented to launchd loses that
      link.
   3. Heuristics. A process whose parent is now pid 1, that matches a
      dev-server, watcher, test-runner or browser pattern, and that holds a
      listening port or high RSS counts as a likely orphan.

   **Privacy rule:** env is read only to find the `EAVESY_SESSION` key. The
   rest is never stored, logged or synced. Other processes' env often holds
   secrets.

## Phased plan

Each phase ships on its own and is useful without the next one.

### Phase 0: Spikes (about a week, throwaway code)

- Confirm `KERN_PROCARGS2` returns env for same-user processes on macOS 26/27
  from a signed app, including hardened-runtime children. Measure the cost of a
  2 s poll with about 1,500 processes.
- Get a test hook firing from Claude Code (HTTP and command), Codex and Cursor
  to a localhost listener. Record payloads and session-end reliability. Check
  whether Cursor's `cursor-agent` CLI still fires only shell hooks.
- Check whether Claude Code / Codex honor URL-mode elicitation and accept a
  non-HTTPS / custom-scheme URL. This decides how secret approval works.
- **Go/no-go:** if env reads fail, attribution falls back to process ancestry
  plus `eavesy run`, and the plan still holds.

### Phase 1: Agent Watch, zero setup (the acute pain, ship first)

No hooks or config needed. Detect `claude`, `codex`, `cursor-agent`, Cursor
and Claude Desktop helpers by executable path. Group their descendants, and
flag orphans by heuristic.

- **Menubar "Agents" section and a window**, with one row per agent
  session. Each row shows its processes, total RSS and CPU, listening ports,
  and age. An "Orphans" group holds dev servers and watchers whose agent is
  gone.
- **Actions:** Stop (SIGTERM to the process group, then SIGKILL after 5 s),
  Stop all from this session, Clean up orphans, Open port in browser, and
  Reveal cwd. Pause/Resume (SIGSTOP/SIGCONT) and "lower priority"
  (`taskpolicy -b`) come later.
- **Pressure guard:** watch memory pressure (the
  `kern.memorystatus_vm_pressure_level` setting or the Swift memory-pressure
  event) and thermal state. On *warning*, send one notification naming the
  biggest agent-owned processes with a Clean up button. Nothing is killed
  automatically unless you turn on a policy.
- **Safety:** never touch processes the user started outside an agent tree
  unless they're flagged *and* the user confirms. Keep an allowlist (for
  example "never kill postgres"). Every kill is logged locally.
- **Code:** `agents/monitor.rs` using the `libproc` crate plus `sysctl`;
  React views in `launcher-ui`. No new permissions are needed.

### Phase 2: Hooks and session awareness

- `eavesy hooks install` writes hook config for Claude Code (also shipped in
  `plugins/eavesy` so plugin users get it automatically), Codex
  (`~/.codex` hooks; the user trusts them via `/hooks`) and Cursor
  (`~/.cursor/hooks.json`). The command is idempotent and `--uninstall`
  reverses it.
- **SessionStart** registers the session and sets `EAVESY_SESSION` where the
  agent allows it (Cursor `env`; for Claude Code, the plugin's env or a
  PreToolUse rewrite that prefixes `eavesy run --session`). Phase 0 confirms
  which mechanism works.
- **Stop/Notification** marks a session as *waiting on you*. The HUD shows
  "Claude in eavesy-public is waiting" with a **reply by voice** button. That
  turns Eavesy's dictation into the way you answer agents.
- **SessionEnd** reaps that session's tagged processes after a grace period
  (default: ask; option: auto after 2 min). This is the fix for #43944 that
  the issue's reporter asked for.
- **OpenTelemetry (optional):** a local OTLP receiver for Claude Code gives
  per-session cost, tokens and active time in the same view.

### Phase 3: Hand-off (voice, captures and files to an agent)

- **`eavesy mcp` (local stdio) tools:**
  - `latest_capture` / `read_capture(id)`: clipboard notes, screenshots and
    dictations that never leave the Mac.
  - `search_local(query)`
  - `inbox()`: things you've sent to *this* session.
  - `ask_human(question)`: shows in the HUD; you answer by voice or text.
  - `request_file(purpose)`: you pick a file in a native sheet and the agent
    gets its path. That gives scoped access without granting the agent
    broad disk access.
- **"Send to agent" hotkey.** Dictate or grab the clipboard or a screenshot,
  pick a target from the live session list (most recent waiting session
  first), and Eavesy delivers it two ways:
  1. pasted into that session's terminal or window using the existing
     focused-target paste (reliable; works with every agent today);
  2. queued in the session's inbox. The agent's next UserPromptSubmit hook
     includes the inbox as extra context, or the agent reads `inbox()`.
- The remote MCP stays read-only for meetings. Update the README/ARCHITECTURE
  docs that still show Bearer tokens as the primary setup.

### Phase 4: Grants (secrets and env without pasting)

**This phase is security-sensitive. Under AGENTS.md it needs explicit review
before merge.**

- `.env.eavesy` (safe to commit) maps names to references:
  `DATABASE_URL=eavesy://keychain/myapp/DATABASE_URL`, or pass-through
  `op://…` / `doppler://…`.
- Running `eavesy run -- npm run dev` makes Eavesy show a **native approval
  sheet**: "Claude Code (session *eavesy-public*) wants DATABASE_URL,
  STRIPE_KEY for `npm run dev`." You choose Allow once / Allow for this
  session / Deny. The values are injected into that child's env only. The
  agent sees the command's output, never the values.
- MCP tool `request_secret(name, reason)` returns only `granted` or `denied`
  and a hint to use `eavesy run`. It **never returns the value**, which
  follows the spirit of MCP URL-mode elicitation.
- "Add secret" UI stores values in the Keychain under an Eavesy access
  group, and can import from a `.env` file you drop in.
- An **audit log** per session records what was requested, granted, and by
  which command.
- Out of scope: syncing secrets to the cloud, and exposing grants through the
  remote MCP.

### Phase 5: Reach the web clients (ChatGPT, claude.ai)

- Add `write`-scoped tools to `workers/mcp`:
  - `send_to_mac(text|file)` drops into the existing `drops` table. It shows
    on the Mac and can be forwarded to a local session.
  - `create_note`.
- Optional relay: a web client can ask "what's running on my Mac?" and get a
  read-only, **opt-in** summary that the app pushes. No process control and
  no secrets go through the cloud.

## Making agents behave better on the Mac (prevention, not just cleanup)

Phases 1–2 clean up after agents. The bigger win is agents making fewer messes
in the first place. Agents aren't careless. **They can't see the machine.** An
agent doesn't know a dev server is already on :3000, that memory is in the red,
or that another agent is building the same repo. Once they can see, they mostly
do the right thing. So the strategy is: **show them the machine, give them a
better way to run things, and give feedback at the moment it matters.**

1. **Tell them the state of the machine at session start.** The SessionStart
   hook adds a few lines of context, for example: "Running for this repo:
   `vite` on :5173 (started 2h ago by another Claude session). Memory pressure:
   warning. 2 other agents active." That alone stops most duplicate dev
   servers.
2. **Give agents a better way to run long-lived things.** MCP tools in
   `eavesy mcp`:
   - `start_service(name, cmd, cwd)` is idempotent: if a service with that
     name is already running for that cwd, it returns its URL instead of
     starting a second copy.
   - `list_services`, `service_logs(name, tail)`, `stop_service`.
   Services run under `eavesy run`, so they're tagged, show in Agent Watch,
   and die with the session unless pinned. The agent gets logs on demand
   instead of a tail command that blocks forever.
3. **Guardrails at the moment of action (PreToolUse hook).** Commands are
   never silently blocked. When a command is refused, the agent gets a reason
   it can act on:
   - Port already in use by an agent-owned process → "Reuse
     http://localhost:3000 (pid 4121, your earlier dev server), or call
     `stop_service`."
   - Memory pressure is critical and the command is heavy (full build,
     `docker compose up`, a browser) → "The Mac is low on memory; finish or
     stop X first."
   - Known foreground hangs (`npm run dev` without backgrounding, `tail -f`,
     watch modes) → suggest `start_service`.
4. **Make agents clean up their own mess (Stop hook).** When an agent tries to
   finish a turn while processes it started are still running, the Stop hook
   blocks once with: "You left `next dev` (:3000, 1.9 GB) and `vitest
   --watch` running. Stop them, or say why they should stay." Agents handle
   this well, and it means Eavesy rarely has to kill anything.
5. **Ship a short instruction snippet.** `eavesy hooks install` offers to
   append a short block to the user's global CLAUDE.md / AGENTS.md: "Use
   eavesy `start_service` for servers, check `list_services` first, stop what
   you start." It complements the hooks; it doesn't replace them.
6. **Limits on heavy work.** An optional "at most N heavy jobs at once" rule
   across all agents (builds, test suites, browsers). Extra jobs wait their
   turn with a message instead of all agents thrashing the Mac together.
   Default off. Turn it on if Phase 1 data shows overlapping builds are a
   common cause of crashes.

These slot in as **Phase 2b**, after hooks exist. Items 1 and 4 are the
cheapest and probably do the most. Build them first.

## Pushback (things I'd steer away from)

- **"A connector to everything" is too broad to build or sell.** Start with
  the narrow, painful, visible thing: *"See what your agents are running, and
  stop it before your Mac dies."* Nobody else does it well across vendors, it
  needs no setup, and it earns the install. Hand-off and secrets build on that
  trust. If Eavesy leads with "connector", people won't know what to do with
  it on day one.
- **Don't try to make the agents smarter.** You can't change the model. You
  can change what it sees and what happens when it acts, so put the effort into
  context, tools and feedback (above), not into prompting tricks.
- **Don't build an orchestrator or a sandbox (yet).** Running agents in
  VMs/containers is a different, crowded product, and it breaks the "works
  with the tools you already use" story.
- **Don't auto-kill early.** One wrongly killed database or a dev server
  killed mid-demo loses the user's trust for good. Start with visibility plus
  one-click actions plus the Stop-hook nudge. Add automation as an opt-in
  policy once the orphan heuristics have proven accurate.
- **Expect vendors to fix some of this.** Claude Code already has `/tasks`
  and will improve cleanup. Eavesy's lasting value is the *cross-agent,
  whole-machine* view plus voice, hand-off and grants. Don't build anything
  that only duplicates one vendor's feature.

## Explicit non-goals

- Running or orchestrating agents (worktrees, containers, kanban). Others do
  that and the category churns. We supervise whatever the user runs.
- Endpoint Security, a system extension, or root helpers in v1.
- Sandboxing agents. Revisit later if Phase 1 data shows it's needed.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| The product gets blurry ("is it a recorder or a process manager?") | One story: *talk to, hand off to, and watch your agents*. Recording feeds "talk to" |
| Killing the wrong process | Kills are manual by default, use process groups, keep an allowlist and a log, and give the reason for every orphan flag |
| Env reads expose secrets | Read only the tag key; zero logging; covered by tests |
| The local endpoint becomes an attack surface (any local process can call it) | Loopback only, token file at 0600, and grants always need a native UI click, never an API call |
| Vendors change hook formats | Hook adapters per agent behind `eavesy hook <agent>`, plus a hooks contract test against recorded payloads |
| Vendors fix orphan cleanup themselves | Cross-agent view, pressure guard and hand-off still stand. Supervising several vendors at once is the moat |

## How we'll know it works

- Phase 1: share of active users who open Agents weekly; orphans cleaned per
  user per week; GB freed; fewer "Mac slowed down" moments, measured as
  pressure-warning events followed by a cleanup.
- Phase 2–3: percentage of agent sessions with hooks installed; voice replies
  sent to agents; time from "agent waiting" to reply.
- Phase 4: secrets granted through Eavesy instead of being pasted.

## Open questions for William

1. Is Phase 1 (Agent Watch) part of the free app, or the first paid feature?
2. Is it acceptable for the CLI to be an install-time step (Homebrew cask
   symlink) rather than an in-app "Install command-line tool" button?
3. Phase 4 needs a security review before merge. Who reviews it?
4. Should the Agents view live in the existing launcher panel, or get its own
   menubar icon or window?

## Sources

- Orphan issues:
  - https://github.com/anthropics/claude-code/issues/43944, plus #42532,
    #41742, #32183, #16198, #26658 and #40550
  - https://github.com/openai/codex/issues/25388, plus #25744 and #19197
- Hooks:
  - https://code.claude.com/docs/en/hooks
  - https://code.claude.com/docs/en/monitoring-usage
  - https://learn.chatgpt.com/docs/hooks
  - https://cursor.com/docs/hooks
- MCP elicitation (URL mode):
  - https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
  - https://modelcontextprotocol.io/specification/2026-07-28/changelog
- ChatGPT MCP: https://developers.openai.com/docs/mcp
- Secrets:
  - https://1password.dev/get-started/secure-ai-access
  - https://doppler.com/agents
- Voice and MCP: https://superwhisper.com/blog/cli-mcp
- Indie process tools:
  - https://github.com/SonghaiFan/leftopen/wiki
  - https://www.raycast.com/fhf1121/portreaper
  - https://pkg.go.dev/github.com/tjp2021/devreap
- Endpoint Security requirements:
  https://github.com/redcanaryco/mac-monitor/wiki/5.-Endpoint-Security-Overview
- Some competitor and landscape claims rest on single or third-party sources
  and are marked as such in the research notes. Verify them before using them
  in public copy.
