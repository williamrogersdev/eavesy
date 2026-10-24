# Plan: a companion for the whole Mac

Status: proposal (2026-10-24). It builds on
[agent-architecture.md](agent-architecture.md) (the **monitor**, the
**Process** noun and the **watch / stop** verb, flow 4 "The Mac gets heavy")
and reuses the queue and speech from
[voice-conversation.md](voice-conversation.md). It doesn't change the
architecture's model, trust tiers or build order. Where the two disagree, the
architecture doc wins.

## The problem

William runs about 20 Claude Code sessions at once, most of them in
`.claude/worktrees/*`. Each one leaves things behind:

- **Stale worktrees.** A session's branch is merged or deleted, the session is
  archived, and the worktree stays on disk with its `node_modules` and
  `target/`. In William's words, "a bunch of stale work trees".
- **Leftover processes.** Dev servers, watchers, `bun test` runs and `cargo`
  builds that an agent started and never stopped: "processes that are running
  that weren't supposed to be running or left over from like an AI agent
  session". They hold ports, memory and battery.
- **No one watching.** Agents run commands all day. Nothing tells you when
  one of them, or anything else, adds a login item, starts listening on a
  port or reads `~/.ssh`.

What we want:

1. **See it.** One place that answers "what's running, who started it, and
   what's left over?"
2. **Clean up safely.** Remove what is clearly left over, never anything with
   work in it, and only after you click.
3. **Notice the odd thing.** Tell you, quietly and rarely, when something on
   the Mac looks wrong.
4. **Talk to it.** "What's running?", "clean up stale worktrees", by voice or
   from an agent through MCP.

## How it fits the model (no new nouns)

| Feature | Noun + verb |
|---|---|
| Inventory of processes, ports, worktrees | **watch** Processes (plus worktrees as read-only facts the monitor reports) |
| Stale worktree / orphan found | Event (`process.orphaned`, `worktree.stale`) → attention queue |
| Click to clean | human **stop** (processes) and the same click removing worktrees |
| Suspicious activity | Event (`machine.suspicious`) → attention queue → shown and maybe spoken |
| "What's running?" | `machine_status` (already in the tool spec) |

A worktree isn't a new noun. It's a fact about a Session's working folder,
the same way a port is a fact about a Process. If it ever needs state of its
own (a trash entry, an undo), that state lives in Events.

## What Eavesy can see

All of this is readable as the user, without root, kernel extensions or
Endpoint Security entitlements.

| What | How | Cost |
|---|---|---|
| Processes: pid, ppid, user, start time, command, executable path | `ps -axo pid,ppid,uid,lstart,comm,args` today; `libproc` (`proc_listallpids`, `proc_pidinfo`, `proc_pidpath`) later, for speed | One listing every 2 s at most (architecture budget); details only for new pids |
| Parent chains | Walk ppid. A process whose parent is `launchd` (pid 1) and that isn't a launchd job was re-parented: its parent exited | Free, from the listing |
| Working folder of a process | `proc_pidinfo(PROC_PIDVNODEPATHINFO)` or `lsof -a -p <pid> -d cwd -Fn` | Per new pid |
| Which agent session started it | Ancestry first: a `claude` / `codex` process above it. Then its cwd under a worktree. Then env (`CLAUDE_CODE_*`, `EAVESY_SESSION`), read with `ps -E` / `KERN_PROCARGS2` for **own-user processes only** | Env is per new pid and only for candidates |
| Live Claude Code sessions | Hook events (`SessionStart`, `Stop`, `SessionEnd`) already flowing into `agents/`; running `claude` processes and their cwds; `~/.claude/projects/<slug>/*.jsonl` modified recently | Cheap |
| Listening ports | `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (own processes; others show without a pid unless root) | One call per refresh, on demand |
| Outbound connections | `lsof -nP -iTCP -sTCP:ESTABLISHED` for own processes; `nettop -L 1` for counts | On demand, or every few minutes when monitoring is on |
| Git worktrees | `git worktree list --porcelain` in each known repo root; then per worktree `git status --porcelain`, the branch, and whether it's merged into the default branch | Seconds for 20 worktrees; on demand, cached |
| Known repo roots | Projects in Eavesy, `~/Developer/*`, repos that Claude Code sessions ran in (`~/.claude/projects` slugs), and folders you add | Once |
| Disk use | `du -sk` per worktree (in the background, it's slow for `node_modules`); `statfs` for free space | On demand |
| Launch agents and daemons | `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` (readable), plus `launchctl print gui/<uid>` for what's loaded | A directory listing; watched with FSEvents |
| Code signature of an executable | `SecStaticCodeCheckValidity` / `codesign -dv` on the binary | Per new executable, cached by path and mtime |

**What it can't see without more privileges:** other users' and root's
processes' details and env, file opens by other processes (no Endpoint
Security), network flows per process for root daemons, and anything inside
the kernel. The doc says so in the UI rather than implying full coverage.

## What counts as stale or orphaned

Every rule below is a *classification*. It labels a row; it never acts.

### Worktrees

A worktree is **stale** when all of these hold:

1. It's a linked worktree (not the repo's main checkout).
2. Its **work is already in the default branch**: HEAD is an ancestor of it,
   or merging HEAD into it would change nothing (`git merge-tree
   --write-tree <default> HEAD` gives back the default branch's own tree).
   The second case is how a squash-merged PR looks: its commits never become
   ancestors of `main`, and once its remote branch is deleted they're on no
   remote either, but every change in them is in `main`.
3. `git status --porcelain` is empty: no staged, unstaged or untracked files
   (ignored files like `node_modules` and `target/` don't count).
4. **No open session** uses it: no running process has its cwd inside it, and
   no Claude Code session in it has been active recently (a transcript in
   `~/.claude/projects/<slug>` modified in the last 24 h).
5. It isn't locked (`git worktree lock`).

Rule 2 replaces "merged or deleted, and nothing unpushed": a branch whose
remote was deleted but whose changes aren't in `main` is **unmerged**, never
stale, whatever its upstream says. Merged-ness is checked against the remote's
default branch and its local copy, without fetching, so a PR merged since
your last fetch shows as unmerged until the next one.

Other labels, shown but never offered for removal: **dirty** (has changes),
**unmerged** (its changes aren't all in the default branch), **in use**,
**locked**, **missing** (the folder is gone; `git worktree prune` would clean
the entry).

Every git call Eavesy makes runs with `core.fsmonitor=false`, so a scan never
starts fsmonitor daemons of its own (see below: they pile up).

### Processes

A process is an **orphan** when:

- it belongs to the current user,
- it was started by an agent session, by the evidence above (ancestry while
  the session was alive, its cwd inside a worktree, or the session env), and
- that session is **gone**: no live `claude`/`codex` process for it, and the
  process has been re-parented to `launchd`, or its cwd is a worktree that
  has no live session.

Typical orphans: `vite`/`next dev`/`wrangler dev` servers, `bun --watch`,
`tsc --watch`, `cargo watch`, a `bun test` that hung, a `node` MCP server whose
client went away. The first scan of William's Mac (2026-10-24) found 98
`git fsmonitor--daemon` processes started from ended sessions, one per
worktree a session touched; they're harmless to stop (git starts one again
when it's needed).

**How the session is found, as built:** Claude Code runs every command with
`CLAUDE_PID`, `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID` in its environment,
and children inherit them. Eavesy reads them with `KERN_PROCARGS2` for your
own processes. A process is an orphan when its `CLAUDE_PID` isn't a running
`claude` that started before it, and no `claude` is among its ancestors.
macOS hides other processes' environments from sandboxed callers, so this
only works from an unsandboxed app (Eavesy isn't sandboxed). It also hides
the environment of Apple's own binaries (`/bin/sleep`, `/bin/zsh`) from
everyone, so those can't be traced to a session; the usual leftovers
(Homebrew `node`, `bun`, `git`, `cargo`) can. A process whose environment
can't be read is never labelled.

**Never orphans**, whatever the evidence: processes of other users, anything
run by launchd as a job (`launchctl` shows it), apps (`.app` bundles),
system binaries (`/System`, `/usr/libexec`, `/usr/sbin`), daemons every
session shares (`gpg-agent`, `keyboxd`, `ssh-agent`), anything whose
executable path can't be read, Eavesy itself and everything it started, the
shells and terminals you're using, and anything you marked "keep".

**Zombies** (state `Z`) are a separate label. They hold no memory and can't
be killed; only their parent can reap them. The row explains that and offers
to stop the parent only if the parent is itself an orphan.

### Ports

A listening port is shown with its process, that process's session (if any),
and the label of the process. A port held by an orphan is the most common
"why won't my dev server start" case, so the card says "port 5173 is held by
`vite` from an ended session in `sharp-hodgkin`".

## Cleanup safety

The rules, in order of importance:

1. **Never delete uncommitted or unpushed work.** Only worktrees labelled
   stale can be selected. Right before removing one, Eavesy re-checks rules
   2 to 5; any change drops it from the batch with a note.
2. **`git worktree remove` without `--force`.** Git itself refuses a worktree
   with changes or untracked files, which is a second check that doesn't
   depend on our code. The branch is left alone; deleting merged branches is
   a separate, later option.
3. **Processes: own user only, SIGTERM first.** Eavesy checks the uid and the
   `(pid, start time)` pair right before signalling, so a reused pid can't be
   hit. SIGKILL is offered only after SIGTERM and a wait of 5 s, as its own
   click.
4. **Every destructive action takes a click on a card listing exactly what
   goes.** The card names each worktree path and each process (command, pid,
   port, session). No API, MCP tool, voice command or agent can confirm it
   (architecture rule 6). A voice command can *open* the card; only a click
   confirms.
5. **Nothing automatic, nothing in the background.** No policy auto-stops
   anything in this plan. The architecture's "auto-stop orphans" policy stays
   an opt-in for later, and when it comes, it only covers processes the core
   itself recorded as a session's own.
6. **Undo where possible.** A removed worktree's branch and commits stay in
   the repo (it was merged or its commits are on a remote), so the log entry
   carries the `git worktree add <path> <commit>` that brings it back. Files
   we move rather than delete (a missing worktree's leftovers, later) go to
   the Trash, never `rm -rf`. Stopped processes can't be undone; the log
   keeps the command line and cwd so you can start it again.
7. **Keep a log.** Every inventory refresh that finds something, every card
   shown and every action taken is an Event, with what it was, the click and
   the result (`worktree.removed`, `process.stopped`, `process.stop_failed`).
   The log is local and readable from Settings.

## Suspicious-activity monitoring

This is the part with the most false positives, so it's off by default and
it never acts. It only puts a card on the attention queue.

### Signals that are realistic without kernel access

| Signal | How we see it | Typical false positives | How we cut them down |
|---|---|---|---|
| A new LaunchAgent or LaunchDaemon | FSEvents on the three folders, plus `launchctl print` diff | App updaters (Google, Microsoft, Zoom, Homebrew services) | Show the signer of the binary the plist runs; a plist whose program is signed by an identified developer is a quiet "new login item" line, not an alert |
| An unsigned or ad-hoc-signed binary listening on a port | `lsof` LISTEN + code signature check | Every dev server you build yourself (`cargo run`, `bun`, `node` itself is signed but your scripts aren't binaries) | Interpreters are judged by their own signature; a listener whose cwd is a known repo or worktree is "dev", never "suspicious" |
| A process running from `/tmp`, `/private/var/folders/*/T`, `~/Downloads` | Executable path from the process listing | Installers, `go run`, `cargo` build scripts, test binaries in `target/` (not in this list) | Ignore children of build tools; group repeats; one card per executable path, ever, until it changes |
| Unexpected outbound connections | `lsof` ESTABLISHED for own processes, sampled | Package managers, telemetry, every agent talking to its API | Only flag processes that are both unsigned-or-from-temp *and* connecting out; never judge by destination alone |
| An agent touching `~/.ssh`, `~/.aws`, `~/.config/gh`, Keychain files, `.env` | Claude Code `PreToolUse` hook (`Read`, `Bash`, `Edit` with those paths), which we already receive | You asking the agent to fix your SSH config | Shown as an info card naming the session and the path, not an alarm; "allow for this session" silences it |
| A new login item / background item | The Background Task Management database is root-only (`sfltool dumpbtm` needs admin), so we see the LaunchAgents folders above and nothing more | Same as LaunchAgents | Same |

Things we deliberately **don't** claim: malware detection, file-open
monitoring of other processes, network inspection, or anything that would
need Endpoint Security (an Apple entitlement and a system extension). Those
are what XProtect and dedicated tools do; Eavesy says "this looks unusual",
not "this is malware".

### How it's surfaced

- One card kind, `notice`, on the same attention queue as agent sessions,
  below approvals and questions. It's spoken only if you turned speaking on
  for notices, and only the one-line version ("A new login item was added by
  Zoom"), because a voice saying "suspicious" at random is worse than
  silence.
- Cards are grouped and rate-limited: at most one monitoring card every 10
  minutes, with a digest if more come in.
- Every card has **Show me** (reveals the file or process), **Fine** (never
  show this exact thing again) and, for a process the user owns, **Stop
  it…**, which opens the same confirm card as cleanup.

## Talking to it

| Ask | Where it goes |
|---|---|
| "What's running?" / "What's on port 3000?" | Inventory → one spoken sentence ("6 dev servers, 2 from ended sessions; port 3000 is `vite` in eavesy") and the inventory view opens |
| "Clean up stale worktrees" / "Stop the leftovers" | Opens the confirm card with exactly those rows selected. **The click still confirms.** |
| "Why is my Mac slow?" | Top memory and CPU users, grouped by session |

- **Voice** reuses the "Hey Eavesy" and voice-command work in
  [voice-conversation.md](voice-conversation.md) (piece 3d) and the `say`
  speech in `desktop/src-tauri/src/agents/speak.rs`. Spoken answers are one
  or two sentences; the rest is on screen.
- **MCP** reuses `machine_status` from the architecture's tool spec, extended
  with `worktrees` and `orphans` arrays for the **local** tier only. An agent
  can read the inventory and can stop processes its own session started
  (architecture rule 6). It can't remove worktrees or stop anything else; it
  can call `send_to_human` to suggest a cleanup, which shows the card.
- The remote tier keeps the architecture's summary-only `machine_status`. No
  paths, no worktrees, no cleanup.

## Privacy

**Everything is local by default.** The inventory, the monitoring signals,
the log and the classification run on the Mac and stay there. Nothing in
this plan sends process lists, paths, ports or worktree names to Eavesy's
cloud.

The only optional cloud piece: if you ask "why is my Mac slow?" and want a
written explanation, the question can go through the same small cloud model
as reply suggestions, with process names and numbers only (no paths, args or
env). That's a separate switch, off by default, and it's in the decisions
below.

Env is read only for own-user processes that are already cleanup candidates,
only to find `CLAUDE_CODE_*` / `EAVESY_SESSION`, and never stored or logged
beyond the session id it yields.

## Performance budgets

| Step | Budget |
|---|---|
| Open the inventory view (cached) | < 100 ms |
| Full refresh: processes + ports | < 500 ms |
| Full refresh: 20 worktrees, without disk use | < 3 s, in the background |
| Disk use per worktree | Background, results stream in |
| Monitoring, when on | < 1% of one core (architecture budget) |

## Build order

1. **Read-only inventory plus click-to-clean for the clear cases** (the first
   slice, built with this doc): a desktop `machine/` module that lists
   worktrees under known repo roots (stale, dirty, unpushed, in use), user
   processes whose agent session is gone (orphans) and listening dev ports; a
   Settings view that shows them; a confirm card that removes the selected
   clean stale worktrees with `git worktree remove` (no force) and sends
   SIGTERM to the selected orphans. No background work, nothing automatic.
   Tests for the classification.
   *As built:* `desktop/src-tauri/src/machine/` and Settings → This Mac. It
   scans when you open the section or press Refresh (about 10 s for 270
   worktrees in 49 repos), groups leftovers by program, and the confirm card
   lists each worktree and process. The app checks every one again before it
   acts and returns a `git worktree add` line for each removed worktree.
2. **The log and undo:** events for every action, the "bring it back"
   command for removed worktrees, a log view in Settings.
3. **Attention queue notices:** "3 leftover dev servers from ended sessions,
   4.2 GB. Clean up?" as a `notice` card, on demand or when a session ends.
4. **Voice and MCP:** "what's running?" and "clean up" through voice
   commands; `machine_status` gains the local-only arrays.
5. **Disk use and merged-branch cleanup:** sizes per worktree, and deleting
   merged local branches as a separate click.
6. **Monitoring** (if William says yes): LaunchAgents first (cheapest, most
   useful), then listeners, then temp-folder executables, then outbound
   connections, then the credential-path hook.

## Decisions for William

1. **Ship suspicious-activity monitoring at all?** It's the noisiest piece
   and the hardest to get right without Endpoint Security. I'd ship
   LaunchAgent watching and the credential-path notice, and hold the rest
   until the inventory gets real use.
2. **Which repo roots by default?** `~/Developer/*` plus Eavesy projects plus
   repos Claude Code ran in (recommended), or only folders you add?
3. **Delete merged branches too, or only worktrees?** Recommended: worktrees
   only in the first slices; branches as a separate, later click.
4. **Cloud explanation for "why is my Mac slow?"** Off and local-only
   (recommended), or the optional cloud summary with names and numbers only?
5. **Ever stop orphans automatically?** The architecture allows an opt-in
   policy. Recommended: not until the log shows the classifier has been
   right for a few weeks, and then only for processes the core recorded
   itself.
