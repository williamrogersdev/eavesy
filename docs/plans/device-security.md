# Plan: Eavesy keeps your Mac safe

Status: proposal (2026-10-25). It builds on
[machine-companion.md](machine-companion.md) (the inventory, the `notice`
card, the suspicious-activity signals) and
[agent-architecture.md](agent-architecture.md) (the monitor, Events, the
attention queue, trust tiers and performance budgets). It reuses the
policy tiers in `desktop/src-tauri/src/assistant/policy.rs`.

It changes the machine companion on purpose, because William asked for
"a top-notch security thing" that protects the device and finds problems on
it, and for all of it in the first version:

- **Monitoring is a product pillar, not an afterthought.** Machine
  companion decision 1 ("ship suspicious-activity monitoring at all?") is
  answered: yes. Monitoring now ships in the first version, and it gets a
  Security section of its own.
- **Deeper visibility is on the roadmap.** The machine companion said Eavesy
  would never use Endpoint Security or network inspection. That changes.
  Both become later, opt-in phases (7 and 8 below) and come with Apple's
  entitlement and approval steps.

- **The assistant does the work.** Added 2026-10-25, again at William's
  request: you can ask Eavesy to clean up, fix a setting or deal with a
  threat, and it acts for you. It doesn't just open the right pane. See
  [The assistant does the work](#the-assistant-does-the-work).

What doesn't change: monitors only propose, and nothing happens because a
monitor saw something. Changes happen when you ask, through the same
`policy.rs` tiers and modes as every other assistant action. Eavesy only ever
makes the Mac *stricter*: no tool can turn a security setting off or silence
an alert. Everything stays local unless you turn on a switch that says
otherwise. Where this doc and the architecture doc disagree
about anything else, the architecture doc wins.

## The goal

**One place that answers "is my Mac safe, and if not, what do I do?"**,
written for a person, not an IT department. A top-class personal security
product does five things well:

1. **Checks your setup.** Is the disk encrypted, the firewall on, macOS up to
   date, the screen locking? Each check gives a plain reason and the fix.
2. **Shows who can watch you.** Which apps can use the camera, mic and
   screen, which can read every file or every keystroke, and who is using the
   camera or mic right now.
3. **Notices changes.** A new login item, a new configuration profile, a new
   browser extension, a changed DNS server, an unsigned program listening on
   a port: when one appears, you hear about it once, with who did it.
4. **Keeps your secrets yours.** It finds keys and tokens lying around in
   plain text, spots AI agents reaching for credentials, and makes sure
   Eavesy never captures a password itself.
5. **Helps when something is wrong.** One button freezes the evidence and
   walks you through what to do next.

And one constraint over all of it, in William's words: it must not hurt
performance, "from the AI or anything, really".

## Principles

1. **Fast or it doesn't ship.** Detection is event-driven, never a polling
   loop. The whole security monitor stays under the architecture's budget of
   **< 1% of one core**, and each monitor has its own row in
   [Performance budgets](#performance-budgets).
2. **No model in the detection path.** Rules in Rust classify every signal.
   Card explanations are written in advance for each kind of finding, and
   nothing is sent off the Mac to explain one (decision 7). The assistant
   talks about a finding only when you ask it.
3. **Heavy work waits.** Full checkups, signature sweeps and secret scans run
   at background QoS. They pause while you record, dictate or transcribe, on
   battery, in Low Power Mode, and when the thermal state is `serious` or
   worse. They resume later.
4. **Fixes only tighten, and you see them before they run** (one exception:
   in Auto mode, a single-setting tightening such as "firewall on" runs
   after the macOS password prompt without a card, per decision 9). Eavesy can make
   a fix itself, from the Security section's **Fix** button or because you
   asked the assistant. Each tool is fixed in code to one direction, which
   is stricter. Admin changes go through macOS's own password dialog, which
   you type into and Eavesy never sees. Fixes Eavesy can't or shouldn't make
   itself (FileVault, an SSH key's passphrase) open the exact System Settings
   pane (`x-apple.systempreferences:` URLs) and walk you through it.
   Removing or quarantining something always shows a card first. See
   [The assistant does the work](#the-assistant-does-the-work).
5. **Local by default; every off-device feature is its own switch.** Each
   feature that sends anything off the Mac is marked ☁ below, is off by
   default, and is listed in [Decisions](#decisions-william-2026-10-25).
6. **Honest coverage.** Eavesy says "this looks unusual", not "this is
   malware". The Security section shows what it can't see without more
   access, and which permission would let it.
7. **Quiet.** One `notice` card per thing, ever, until that thing changes.
   At most one security card every 10 minutes, with a digest for the rest.
   Speaking is off for notices unless you turn it on. Anything marked
   **Fine** is never shown again.

## How it fits the model (no new nouns)

| Feature | Noun + verb |
|---|---|
| Security checkup | **watch** the Mac: a `machine_status` section, on demand plus once a day |
| Privacy audit, camera/mic use | Events (`privacy.device_in_use`, `privacy.grant_added`) |
| Persistence, profiles, extensions, network changes | Events (`machine.persistence_added`, `machine.profile_added`, …) → attention queue as `notice` |
| Secret exposure | Events (`secret.exposed`, `agent.credential_access`) |
| "Something's wrong" | A human action that writes an evidence bundle; no new noun |
| Fixes | Open a Settings pane (Do tier), or a confirm card (Click tier) |

Everything is an Event in the existing local log, so "what changed on my Mac
this week" is a query, not a feature.

## What Eavesy can see

Checked on William's Mac (macOS 26.6.2, signed in as an admin user, no root)
on 2026-10-25. "As user" means it ran without a password prompt.

### Setup checks

| Check | How | Works as user | Cost (measured) |
|---|---|---|---|
| FileVault | `fdesetup status` | Yes | Instant |
| Gatekeeper | `spctl --status` | Yes | Instant |
| System Integrity Protection | `csrutil status` | Yes | Instant |
| Firewall, stealth mode | `socketfilterfw --getglobalstate`, `--getstealthmode` | Yes | Instant |
| Screen lock delay | `sysadminctl -screenLock status` | Yes | Instant |
| Automatic login | `autoLoginUser` in `/Library/Preferences/com.apple.loginwindow` | Yes | Instant |
| MDM / DEP enrollment | `profiles status -type enrollment` | Yes | Instant |
| Configuration profiles | `profiles` / `system_profiler SPConfigurationProfileDataType` | Yes | < 1 s |
| macOS and Safari updates pending | `softwareupdate --list` | Yes | ~4 s (network) |
| XProtect and other security data versions | `system_profiler SPInstallHistoryDataType` | Yes | < 1 s |
| Sharing services (Screen Sharing, File Sharing, Remote Login) | `launchctl print system/<service>` (absent means off) | Yes | Instant |
| Remote Login | `systemsetup -getremotelogin` | **No** (needs admin); use `launchctl` above | n/a |
| Lockdown Mode | `LDMGlobalEnabled` in global defaults | Yes | Instant |
| System extensions | `systemextensionsctl list` | Yes | Instant |
| DNS servers, proxy | `scutil --dns`, `networksetup -getwebproxy` | Yes | Instant |
| Battery and power state (for deferring work) | `pmset -g batt`, `NSProcessInfo.thermalState` / `isLowPowerModeEnabled` | Yes | Instant |

### Things that need more access

| What | Why it's blocked | How we get it |
|---|---|---|
| Who has camera, mic, screen, Accessibility, Input Monitoring and Full Disk Access (the TCC databases) | Both `TCC.db` files are "authorization denied" without Full Disk Access | Opt-in: ask for Full Disk Access with a clear reason. Without it, show what we *can* know: our own grants, and apps that declare the usage keys in their `Info.plist` |
| Background items database (all login items) | `sfltool dumpbtm` asks for an admin password (it showed a prompt in our test) | Never run it unprompted. Watch the LaunchAgent/LaunchDaemon folders instead (readable), and offer a one-off "full login items check" behind a card that warns about the password prompt |
| Other users' and root's processes in detail; file opens by other processes | No Endpoint Security | Phase 7 (opt-in system extension) |
| Network flows per process for root daemons, and blocking | No Network Extension | Phase 8 (opt-in system extension) |

### App and network facts

| What | How | Cost (measured) |
|---|---|---|
| Who signed an app | `codesign -dv` (or `SecStaticCodeCreateWithPath` + `SecCodeCopySigningInformation`) | ~20 ms per app |
| Is the signature intact | `codesign --verify --deep --strict` (or `SecStaticCodeCheckValidity`) | ~350 ms per app (Slack). Background only, cached by path + mtime |
| Notarized / Gatekeeper verdict | `spctl --assess -vv` | ~450 ms per app. Background only, cached |
| Listening ports | `lsof -nP -iTCP -sTCP:LISTEN` | ~60 ms |
| Established connections (own processes) | `lsof -nP -iTCP -sTCP:ESTABLISHED` | ~50 ms (124 connections) |
| Launch agents and daemons | The three folders (14 entries on William's Mac), watched with FSEvents | Free after start |
| Browser extensions | Chrome/Edge/Brave `Extensions/` folders, Safari via `pluginkit -m` | ~5 ms |
| Camera / mic in use right now | CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` listeners; camera via `AVCaptureDevice.isInUseByAnotherApplication` (KVO), CoreMediaIO's `…IsRunningSomewhere` as a cross-check | Callbacks, no polling. Known gaps: Bluetooth mics may always read inactive, some pro hardware bypasses CoreAudio, and which app is responsible can't always be named. The UI says so (*from developer-forum reports, unverified with Apple*) |

Eavesy's own clipboard capture already skips anything marked
`org.nspasteboard.ConcealedType`, `TransientType` or `AutoGeneratedType`
(`desktop/src-tauri/src/commands.rs`), so password managers' copies never
reach a capture. The secrets pillar extends that to text that *looks* like a
secret.

## The pillars

### 1. Security checkup

A Security section in Settings with one line per check: a status, one
sentence on why it matters, and **Fix** or **Fine** (accept the risk; this
check never nags again). **Fix** makes the change through the same
`security_fix` action the assistant uses, or opens the pane when the table
below says it does. Only you can press **Fine**. The assistant has no tool
for it. Plus a summary at the top ("2 things
to fix") rather than a gamified score. A score invites gaming and implies a
precision we don't have.

Checks, in order of how much they matter for a personal Mac:

| Check | Good | Fix opens |
|---|---|---|
| macOS and Safari up to date | No recommended updates pending | Software Update |
| FileVault | On | Privacy & Security → FileVault |
| Screen locks quickly | Password required within 5 min | Lock Screen |
| Automatic login | Off | Users & Groups |
| Firewall | On (stealth mode suggested, not required) | Network → Firewall |
| Gatekeeper | Assessments enabled | Privacy & Security |
| SIP | Enabled | Explains Recovery mode; no pane |
| XProtect data | Updated in the last 30 days | Software Update |
| Sharing services | Off unless you use them (Remote Login, Screen Sharing, File Sharing, Remote Management) | General → Sharing |
| Configuration profiles / MDM | None, or ones you recognise | Device Management |
| System extensions | Ones you recognise | Login Items & Extensions |
| Lockdown Mode | Shown as information, never "fix" | Privacy & Security |
| DNS / proxy | What your network gave you, or a resolver you chose (named, e.g. Cloudflare WARP `127.0.2.2`) | Network |

It runs when you open the section and once a day in the background (with the
deferral rules). A check that gets worse since the last run (firewall turned
off, a new profile) becomes a `notice`.

### 2. Privacy: who can watch you

- **Live use.** A small entry in the menu bar menu and an Event whenever the
  camera or mic turns on or off, naming the app when macOS lets us. A log in
  Settings: "Zoom used the camera 14:02–14:47". A notice only for something
  new: an app that has never used the camera before, or use while the screen
  is locked or asleep.
- **Grants audit** (needs Full Disk Access, opt-in). Every app with camera,
  mic, Screen Recording, Accessibility, Input Monitoring, Full Disk Access or
  Automation, grouped by power. It flags grants to apps that are deleted,
  unsigned, or haven't run in 90 days. "Remove" resets the grant with
  `revoke_access` (`tccutil reset`), so the app has to ask again. Where
  that doesn't work, it opens the right Privacy & Security pane. Eavesy
  never writes to the TCC database.
- **Screen sharing and recording right now.** ScreenCaptureKit and the
  system's own indicator tell us when something is capturing the screen.
  Shown the same way as the camera.
- **Eavesy itself.** A plain list of what Eavesy has access to, why, and a
  button to turn each off. A security product earns trust by showing its own
  footprint first.

### 3. Persistence and change watch

Things that let code survive a restart, or change how your Mac trusts
others. Each one is watched with FSEvents (free when nothing changes) or
checked in the daily checkup.

| What | How | When it's a notice |
|---|---|---|
| LaunchAgents / LaunchDaemons | FSEvents on `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` | New or changed plist. Quiet line if the program it runs is notarized by an identified developer; a notice if it's unsigned, ad-hoc, in a temp or Downloads folder, or a script |
| Login items | `SMAppService` status for apps we know, plus the folders above; full list on request (admin prompt) | New entry |
| Configuration profiles | Daily `profiles` check | Any new profile. Profiles can install root certificates and proxies, so this is always a notice |
| Root certificates | `security find-certificate -a` on the System and login keychains | A new trusted root you didn't add |
| Browser extensions | FSEvents on the browsers' extension folders | New extension, with its name and permissions from its manifest |
| Shell startup files | FSEvents on `~/.zshrc`, `~/.zprofile`, `~/.bash_profile`, `~/.config/fish` | Changed by a process other than your editor or a known installer (Homebrew, nvm, rustup) |
| `crontab`, periodic scripts | `crontab -l` daily | Any entry |
| `/etc/hosts`, DNS, proxy | FSEvents on `/etc/hosts`; `SCDynamicStore` notifications for DNS and proxy | Any change |
| SSH | FSEvents on `~/.ssh/authorized_keys` and `~/.ssh/config` | A new authorized key |
| System extensions | `systemextensionsctl list` daily | A new one |

Every notice says what changed, which program did it when we can tell, who
signed that program, and offers **Show me**, **Fine** and, where it's yours
to remove, **Remove…** (Click tier; moves the file to the Trash, logs the
path for undo).

### 4. App trust

- **Installed apps.** A background sweep of `/Applications` and
  `~/Applications` records each app's signer, team ID and notarization, cached
  by path and modification time. William's Mac has 25 apps, so the first
  sweep is roughly 10–20 s of background work at the measured per-app cost;
  after that, only new or changed apps are checked again. It flags: unsigned or ad-hoc apps, a
  signature that no longer verifies (the app was modified after signing), and
  an app whose team ID changed between versions.
- **Running executables.** The machine companion's process listing already
  sees each new pid. Each new executable path gets the same signature check
  (cached). A notice for: a process running from `/tmp`,
  `/private/var/folders/*/T` or `~/Downloads`; an unsigned binary listening
  on a port or connecting out. Children of build tools, and anything whose
  working folder is a known repo or worktree, count as "dev" and are never
  flagged, which keeps the false positives from `cargo run` and `bun` away.
- **Quarantine.** Files you downloaded carry `com.apple.quarantine`. An
  executable in Downloads that had the attribute stripped before it ran is a
  classic sign of someone talking you past Gatekeeper. Notice.
- ☁ **Known-vulnerable apps** (opt-in, in 1.0). Compare installed app
  versions with a public vulnerability feed. Only app names and versions
  would leave the Mac. Decision 4.

### 5. Network

- **Listeners.** Every listening port, its program, signer and whether it
  listens on all interfaces or only localhost. A notice for a new non-dev
  listener on all interfaces, which is reachable from the café Wi-Fi.
- **Outbound.** Sampled connections for your own processes, checked only
  when the monitor is on and at most every few minutes. Flags a process
  that's both unsigned-or-from-temp *and* connecting out. Never judged by
  destination alone.
- **Wi-Fi.** A notice when you join an open (unencrypted) network, with a
  suggestion to use a VPN. Uses `CWWiFiClient` notifications, which are
  event-driven. Reading the network name needs Location access on recent
  macOS, so this check asks for it only if you turn it on.
- **DNS and proxy changes.** These come from `SCDynamicStore` notifications
  (pillar 3). A changed resolver or a new proxy is how a lot of adware
  works.

### 6. Secrets and accounts

- **Secrets lying around.** An on-demand and weekly local scan for: private
  SSH keys without a passphrase, `~/.aws/credentials`,
  `~/.config/gh/hosts.yml`, `.npmrc` tokens, `.env` and `.dev.vars` files
  that aren't git-ignored in your repos, and tokens in shell history
  (`AKIA…`, `ghp_…`, `sk-…`, `xox…` patterns). It reports the file and
  the kind of secret, never the value, and stores nothing but the path and a
  hash. "Fix" runs `protect_secret` for the safe, local fixes (ignore the
  file, tighten its permissions, remove a history line, each backed up). For
  the rest (add a passphrase, move it to the Keychain or 1Password CLI,
  rotate the key) it explains the fix and opens the place to do it.
- **Eavesy's own captures.** Clipboard text, dictations and screenshots that
  look like a secret (same patterns, plus credit card numbers by Luhn check)
  are kept out of uploads and MCP results and are marked in history, on top
  of the concealed-type rule that exists today. You can unmark one.
- **AI agents and credentials.** The `PreToolUse` hook we already receive
  from Claude Code shows when an agent reads or edits `~/.ssh`, `~/.aws`,
  `~/.config/gh`, Keychain files or `.env`. An info card names the session
  and the path; "allow for this session" silences it. An agent that writes a
  LaunchAgent, a shell startup file or `authorized_keys` gets a notice from
  pillar 3 that also names the session.
- ☁ **Breach check** (opt-in). Have I Been Pwned's k-anonymity range API
  checks whether a password you type into Eavesy's check has been in a
  breach. Only the first 5 characters of its SHA-1 hash leave the Mac.
  Checking your email address against breaches would send the address
  itself, so it's a separate switch. Decision 5.

### 7. Help when something's wrong

**"Something's wrong"** in the Security section and the menu bar:

1. **Freeze the evidence.** It writes a bundle to
   `~/Eavesy/Security/<date>/`: the process list with signers, listening
   ports and connections, persistence items, profiles, recent security Events
   and the checkup. It's local, and you choose whether to share it.
2. **Walk through next steps,** one at a time: disconnect from the network
   (opens Wi-Fi), stop and remove the suspicious item (Click tier), rotate
   the credentials pillar 6 found, change passwords from a different device,
   and when to get professional help or reinstall macOS.
3. **Nothing is wiped and nothing is sent.** Eavesy can carry out each step
   you approve: `lockdown` turns Wi-Fi off, `remove_item` removes the item,
   `stop_process` stops a process. But it never erases the Mac, and it
   never sends the bundle anywhere.

### 8. Deeper visibility (later, opt-in)

Both of these need an Apple entitlement, a system extension the user
approves in System Settings, and for Endpoint Security, Full Disk Access.
They ship as a separate, optional download so that the main app keeps its
footprint small.

- **Endpoint Security** (`com.apple.developer.endpoint-security.client`).
  Real-time `exec`, file-open-on-sensitive-paths and persistence events for
  every process, including root's. It replaces the folder watching and
  sampling above with exact, attributed events. It needs Apple to grant the
  entitlement, and developers report Full Disk Access granted to the host
  app doesn't carry over to the extension on macOS 26
  (*developer-forum reports, unverified*). Notify-only ES events; no
  blocking (AUTH) events in the first version, because a bug in an AUTH
  client can hang the Mac.
- **Network Extension content filter** (`NEFilterDataProvider`). Per-app
  connections for every process, and later "ask before this app connects"
  like LuLu or Little Snitch. Developer ID distribution is allowed on macOS,
  but developers report activation failures on macOS 26 Tahoe
  (*developer-forum reports, unverified*). Prototype before promising it.

## The assistant does the work

You can say "clean up my Mac", "fix my security", "what's that new login
item? get rid of it" or "something's wrong, lock it down", and Eavesy acts
for you. Each action goes through `assistant::policy::decide` like every
other tool, so the mode you chose (Ask, Auto, Bypass) applies, along with the
rules below, which no mode loosens.

### What already exists

Worktree and leftover-process cleanup through the assistant is already
built: `machine_overview` (Look) and `clean_machine` (Click, a card listing
each worktree and process, every row re-checked before it's touched) in
`desktop/src-tauri/src/assistant/tools.rs` and
`web/src/server/assistant.ts`. This plan adds security tools next to them
and doesn't change those two.

### Rules every security tool follows

1. **Only stricter, fixed in code.** Every tool tightens in one direction
   that's set in Rust. The model never passes on/off, enabled/disabled or a
   level. There is no "loosen" verb to misuse; turning a macOS security
   setting off stays in the **Never** row of
   [assistant.md](assistant.md).
2. **Silencing counts as loosening.** **Fine**, "accept risk", "allow for
   this session" and turning off a monitor are your clicks in Eavesy's UI
   only. No assistant, agent or MCP tool dismisses or suppresses a notice,
   because hiding an alert is the first thing a prompt injection would want.
3. **Targets come from Eavesy, not from the model.** Destructive tools take
   ids that a `security_status` result handed out (the same pattern as
   `clean_machine`'s paths and pids). Right before acting, Rust checks that
   the id is still flagged and still points at the same file (path, inode,
   mtime) or process (pid, start time). The model can't name an arbitrary
   path, bundle id or service.
4. **Monitor data is untrusted text.** Plist labels, program arguments,
   extension names and descriptions, profile names, Wi-Fi names, process
   names and file contents can be written by an attacker. Tool results wrap
   them as quoted data, the model is told they're not instructions, and no
   tool takes free text from them as a target.
5. **Secrets stay secret.** Results about secrets carry the path and the
   kind ("AWS access key"), never the value or any part of it.
6. **Only you can ask for security changes.** A new `Facts` field,
   `you_only`, is set on every security tool that changes something. With
   it, `decide` treats a `LocalAgent` like a `Monitor`: a card in every mode,
   trusted folder or not. A coding agent can read `security_status`, but it
   can't remove a LaunchDaemon or change the firewall unattended. `Remote`
   gets the summary ("2 things to fix") and no changes.
7. **Snapshot before removing.** Any removal first writes that item's
   evidence (the file, its signer, the process tree, connections) to the
   Something's-wrong bundle folder, so cleaning up never destroys the
   forensics.
8. **Admin goes through Apple's dialog.** When a change needs admin rights,
   Eavesy runs one constant command per verb behind macOS's own password
   prompt, one prompt per batch. You type the password into Apple's dialog
   and Eavesy never sees it. A model's text never becomes part of the
   command.

### Tools

Every new tool goes in both `desktop/src-tauri/src/assistant/tools.rs`
(tier and facts) and `web/src/server/assistant.ts` (name and description
for the model), as the existing ones do.

| Tool | What it does | Tier and facts | In Auto mode | Phase |
|---|---|---|---|---|
| `security_status` | The checkup, open notices, privacy grants and secrets found (path and kind only), each with an id | Look | Runs | 1 |
| `security_fix` `{ check }` | Tightens one setting from a fixed list: firewall on, stealth mode on, screen lock within 5 min, automatic login off, Remote Login / Screen Sharing / File Sharing off, Gatekeeper assessments on | Click, `you_only`, `safe_listed`, undoable by you in Settings (not by the assistant, rule 1); admin prompt where needed | Runs, after the macOS password prompt | 1 |
| `security_fix` `{ check: "updates" }` | Installs pending macOS and Safari updates | Click, `you_only`, `irreversible` (may restart) | Card | 1 |
| `security_fix` `{ check: "filevault" }` | Opens FileVault and walks you through it. Never scripted: `fdesetup enable` prints the recovery key, and a model must never see it | Do (opens a pane) | Runs | 1 |
| `remove_item` `{ ids }` | Removes flagged persistence items: unloads a LaunchAgent/Daemon (`launchctl bootout`) and moves its plist to the Trash; removes a browser extension's folder to the Trash; removes a configuration profile (`profiles remove`); removes an added `authorized_keys` line (backed up) | Click, `you_only`; snapshot first | **Card in every mode, Bypass too.** A 10 s undo can't catch "my VPN stopped working tomorrow" | 2 |
| `revoke_access` `{ ids }` | Resets an app's camera, mic, screen or other privacy grant (`tccutil reset <service> <bundle id>`); the app has to ask again | Click, `you_only`, undoable (the app can ask again) | Card | 3 |
| `quarantine_file` `{ ids }` | Moves a flagged executable to `~/Eavesy/Quarantine`, removes its execute bit and keeps the quarantine attribute. **Restore** puts it back | Click, `you_only`, undoable; snapshot first | Card | 4 |
| `stop_process` `{ ids }` | Stops a flagged process you own: SIGTERM, then SIGKILL as its own click. The same code path as `clean_machine`'s processes | Click, `you_only` | Card | 4 |
| `protect_secret` `{ ids }` | Safe, local fixes: adds a `.env` to `.gitignore`, tightens a key file to mode 600, removes a token line from shell history (backed up). For rotating a key or adding a passphrase, it opens the provider's page or `ssh-keygen -p` in Terminal for you to type | Do for `.gitignore` and permissions (undoable); Click, `you_only` for history | Runs / Card | 5 |
| `secure_my_mac` | One card with every open fix, ticked by default, grouped as settings, removals and secrets, with one admin prompt for the batch. Whatever you untick stays as it is | Click, `you_only` | Card | 6 |
| `lockdown` | For "something's wrong": freezes the evidence bundle, turns Wi-Fi off, and puts the steps from pillar 7 on one card | Click, `you_only` | Card | 6 |
| `clean_up_everything` | "Clean up my Mac": `clean_machine`'s stale worktrees and orphans, plus Eavesy's own old caches, on one card | Click (as `clean_machine`) | Card | 2 |

How a request goes:

> You: "Fix my security."
> Eavesy calls `security_status`, then `secure_my_mac`. A card lists:
> firewall on, stealth mode on, Remote Login off, remove an unsigned
> LaunchAgent `com.example.helper` (snapshot kept), and add `.env` in
> `~/Developer/foo` to `.gitignore`. You untick the LaunchAgent and click
> **Fix 4**. macOS asks for your password once. Eavesy says "Done: 4 fixed,
> 1 left as it was." The Activity log has each change, and Settings → Security
> shows each setting's new state.

In Auto mode, "turn the firewall on" runs straight away after the password
prompt, because it's a safe-listed tightening of a single setting. "Get rid
of that login item" always shows the card first.

**Not verified yet.** These still need a test in the VM
(`desktop/scripts/vm-test.sh`), not on William's Mac:

- `tccutil reset` for system-level services (Accessibility, Screen
  Recording) as the user.
- `launchctl bootout` for `/Library/LaunchDaemons` behind the admin prompt.
- `profiles remove` for a user-installed profile.
- Which sharing services can be turned off by command on macOS 26.

A verb that doesn't work by command falls back to opening the pane.

## Phase 0: harden Eavesy itself

A security product that's easy to attack is worse than none. Before pillar 1
ships, audit Eavesy's own footprint and drop what it doesn't need:

| Today | Action | Status |
|---|---|---|
| `com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory` in `entitlements.plist` weaken the hardened runtime | Remove each one that the signed app runs without | Testing. The VM test builds an unsigned debug app, where the hardened runtime doesn't apply, so it can't answer this. Instead `macos-release.yml` takes a `without_entitlements` input (manual runs only) and launches every signed build; an entitlement goes once a candidate without it stays up |
| `macOSPrivateApi: true` in `tauri.conf.json` | Keep only if needed, and document why | Kept: Tauri needs it for the transparent HUD and card windows. In `SECURITY.md` |
| Not sandboxed (needed to read other processes' environments for the machine companion) | Keep, and document it as a deliberate trade-off. Every read of another process stays own-user only | Done, in `SECURITY.md` |
| Apple Events automation, screen capture and microphone entitlements | Keep. They're the product. List each with its reason in the Security section's "Eavesy itself" view | Listed in `SECURITY.md`; the in-app view comes with the checkup |
| Capture sidecar (`SwiftAudio`) launched by the app | Check its signature and team ID before launch, so a replaced binary never runs | Done (`sidecar_trust.rs`). Checked once in the background at launch and again whenever the file changes. A dev build has no team ID and skips it |
| Local agent socket, which checks the peer's uid (`agents/mod.rs`) | Keep the uid check. The socket's folder must be 0700 and the user's. Add the peer's code signature to the Activity log | Folder check done: Eavesy refuses to listen in a folder that's shared, a symlink or someone else's. The peer signature moves to the checkup, with the Activity log work |
| Updater with a minisign public key in `tauri.conf.json` | Keep it pinned | Done: a test fails if the key changes, so a change is always a deliberate commit |
| Security Events in the local log | Make them tamper-evident: each entry carries a hash of the one before, and the Security section warns if the chain is broken | Moves to the checkup, which writes the first Security Events |
| No security review in CI for desktop code | Add `cargo audit` for the desktop crate | Done. Ignored advisories, each with its reason, are in `desktop/src-tauri/.cargo/audit.toml`. The Swift sidecar has no third-party packages, so there's nothing to audit there yet |

## Performance budgets

These add rows to the machine companion's table. The total for everything
always-on stays under **< 1% of one core** and **< 30 MB** of extra memory.

| Monitor | How it runs | Budget |
|---|---|---|
| Persistence and change watch | FSEvents + `SCDynamicStore` callbacks | ~0 when idle; < 50 ms per change |
| Camera / mic in use | CoreAudio/AVFoundation callbacks | ~0 when idle |
| New-executable signature check | Per new executable path, cached | < 25 ms (`codesign -dv` measured ~20 ms) |
| Deep signature verify, Gatekeeper assess | Background QoS, new/changed apps only | ~350–450 ms per app, never while recording |
| Listeners | With the process refresh | < 100 ms (measured ~60 ms) |
| Outbound sample | Every 5 min at most, when monitoring is on | < 100 ms (measured ~50 ms) |
| Full checkup | On open and daily, background QoS | < 2 s without `softwareupdate`; the update check (~4 s, network) runs on its own |
| Secret scan | Weekly or on demand, background QoS, deferred on battery | Streams results; no budget on total time, < 5% of one core while running |
| Explanations | Rule-written text, shown with the card | Free; no model runs |

Each budget gets a timing in the diagnostics bundle, and the deferral rules
(recording, dictating, transcribing, battery, Low Power Mode, thermal) get a
test.

## What we don't claim

- Eavesy is not antivirus. XProtect is, and the checkup makes sure it's up to
  date. Eavesy doesn't scan file contents against malware signatures.
- Without phases 7–8 Eavesy can't see other users' or root's file activity,
  or root's network flows. The Security section says so and names the
  permission that would change it.
- It doesn't block anything until a Network Extension phase exists, and even
  then only when you ask it to.

## Build order

William asked for all of it in the first version, so phases 0–6 together
make up **Eavesy Security 1.0**. They ship as separate PRs, in this order,
each behind the Security section's own switch until 1.0 is complete:

0. **Harden Eavesy** (the table above). This comes first because every later
   phase adds to Eavesy's footprint.
1. **Checkup**: the Security section, every check in pillar 1, Fix/Fine, the
   daily run with the deferral rules, and Events for checks that got worse.
2. **Persistence and change watch** (pillar 3) on the attention queue as
   `notice` cards, with rate limits and the digest. This also delivers the
   machine companion's build step 6 (monitoring).
3. **Privacy** (pillar 2): live camera, mic and screen-capture use, the
   "Eavesy itself" view, then the grants audit behind the Full Disk Access
   opt-in.
4. **App trust and network** (pillars 4 and 5): the signature cache, new
   executable checks, listener and outbound rules, Wi-Fi and quarantine
   checks, and the opt-in ☁ known-vulnerable apps check.
5. **Secrets** (pillar 6): the opt-in ☁ breach checks, the local scan,
   secret-looking captures kept out of uploads, and the agent
   credential-path cards.
6. **Something's wrong** (pillar 7): the evidence bundle and guided steps,
   `secure_my_mac` and `lockdown`. Voice ("Is my Mac OK?") and MCP
   (`machine_status` gains a `security` section for the local tier only;
   the remote tier gets "2 things to fix" and nothing more).

Each phase ships its assistant tools with it (see the "Phase" column in
[The assistant does the work](#the-assistant-does-the-work)), so you can ask
for a fix the day you can see the problem.

After 1.0, each its own decision:

7. **Endpoint Security extension**: prototype notify-only events. The
   entitlement application happens now, as William's step (decision 6), so
   it can be granted by the time this starts.
8. **Network Extension filter**: prototype on macOS 26 first, given the
   reported activation problems.
9. Nothing else yet. Known-vulnerable apps and breach checks moved into
   1.0 (decisions 4 and 5).

Every phase has unit tests for its classification rules (the same style as
`machine/` today) and a run in the VM (`docs/TESTING-ENVIRONMENTS.md`), where
we can plant a LaunchAgent, a profile, an unsigned listener and a fake key
and check that each produces exactly one notice.

## Decisions (William, 2026-10-25)

1. **Full Disk Access:** an explicit opt-in in the Security section, never
   during onboarding. Without it, everything except the grants audit works.
2. **Daily background checkup:** on by default, with the deferral rules.
3. **Phase 0 entitlements:** remove `allow-jit` and
   `allow-unsigned-executable-memory` if the VM test passes without them.
   If it doesn't, keep them and write down why.
4. ☁ **Known-vulnerable apps:** in 1.0, opt-in (off by default). It's built
   with phase 4 (app trust). Only app names and versions leave the Mac.
5. ☁ **Breach checks:** both, opt-in, as two separate switches. The
   password check uses k-anonymity, so only a 5-character hash prefix leaves
   the Mac. The email check says plainly that your address leaves the Mac.
   Built with phase 5 (secrets).
6. **Endpoint Security:** apply for the entitlement now. Building waits
   until after 1.0. Applying is William's step, from the Apple Developer
   account.
7. **"Explain this":** rule-written explanations only. Nothing leaves the
   Mac. The assistant can still talk about a finding when you ask.
8. **Admin rights:** one macOS password prompt per batch. No privileged
   helper: a root helper registered with `SMAppService` is the biggest
   privilege increase Eavesy could make, and it goes against phase 0. If one
   is ever proposed, it accepts only the fixed tighten-only verbs, takes no
   command strings, and checks its caller by audit token and code-signing
   requirement, never by pid.
9. **Auto mode:** single-setting tightenings (`safe_listed`) run after the
   password prompt without a card. Removals, quarantine, grant resets and
   updates always show a card.

## Sources

- Endpoint Security entitlement and Full Disk Access: Apple Developer Forums
  threads [651274](https://developer.apple.com/forums/thread/651274),
  [129222](https://developer.apple.com/forums/thread/129222),
  [844239](https://developer.apple.com/forums/thread/844239).
- Network Extension filters with Developer ID, and macOS 26 activation
  reports: Apple Developer Forums
  [820254](https://developer.apple.com/forums/thread/820254),
  [675923](https://developer.apple.com/forums/thread/675923).
- Camera and mic "running somewhere" caveats: Apple Developer Forums
  [697124](https://developer.apple.com/forums/thread/697124),
  [741026](https://developer.apple.com/forums/thread/741026);
  [Objective-See OverSight](https://objective-see.org/products/oversight.html).
