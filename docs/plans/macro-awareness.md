# Plan: Eavesy knows what else is going on

Status: proposal (2026-11-13). This extends [assistant.md](assistant.md)
(sections B, D, H and N) and [agent-architecture.md](agent-architecture.md).
Where they disagree with this file, they win.

## In one paragraph

Today Eavesy answers each message with only that conversation in front of it,
and the conversation is gone when the app quits. This plan makes Eavesy aware
of your other work: the meeting you had this morning, the note you saved last
week, and the Claude Code session that is already fixing the bug you just
mentioned. Every piece of work gets a short written **brief**. Before each of
your turns, Eavesy looks up the briefs that match what you said and puts the
few that matter in front of the model. When another agent session already owns
the problem, Eavesy can pass your message to it. Nothing new runs in the
cloud, and there is no new app.

## Where the idea comes from

[Junior](https://github.com/getsentry/junior) is Sentry's open-source Slack
agent (Apache-2.0, TypeScript, about 100,000 lines). Its author describes it
as becoming "macro aware" of its other conversations. We read the source at
commit `cff5c65` (2026-11-14) and two posts,
[Building an Intern](https://cra.mr/building-an-intern) and
[A Little Determinism](https://cra.mr/a-little-determinism).

Most of Junior solves problems Eavesy doesn't have: many people in one Slack
workspace, serverless timeouts, and a sandbox that must never hold a
credential. Eavesy is one person with a Mac, and its loop already runs there
(`desktop/src-tauri/src/assistant/thread.rs`). So we port four designs and no
code.

| Idea | In Junior | Eavesy |
|---|---|---|
| A structured **Brief** per conversation: summary, intent, outcome status, decisions, facts, links, keywords. Versioned, rewritten after a turn | `chat/briefs/schema.ts` | **Port.** One brief per Session and per Item (step 1) |
| Search over briefs, not transcripts. One embedding per conversation, made from the latest brief; word match and meaning combined | `chat/conversations/search.ts`, `embedding.ts` | **Port.** Local word search first, meaning search second (steps 1 and 3) |
| Recall before each user turn, limited to what directly helps | `junior-memory` plugin | **Port**, extended from memories to related work (step 2) |
| One conversation messages another, which wakes it | `messageAgent`, `chat/agent-invocations/message.ts` | **Port** onto the existing `send` verb and the agents hub (step 4) |
| External events arrive as queued messages with a stated intent, and never jump ahead of the person | Watches, `chat/tools/watch-events.ts` | **Port** into monitors (assistant.md D), step 5 |
| Leases, continuation tasks, a 240-second soft deadline | Vercel Queues plumbing | **Don't copy.** The Mac has no function timeout |
| A man-in-the-middle egress proxy that injects credentials | Sandbox egress | **Don't copy.** Secrets are assistant.md M |
| Public and private visibility rules for search | `policies/conversation-access.md` | **Don't copy.** One person, one library |

Two limits on what we know. The automatic "related conversation" injection in
the author's post is not in the public repository yet: there, conversation
search is a tool the model chooses to call. And we could not read his "Side
Quests for Agents" post, which is not on his blog.

## What exists today

| Piece | State |
|---|---|
| The conversation | In memory on the Mac, cleared on quit; the last 40 messages are sent (`thread.rs`) |
| The cloud | One stateless model step per call (`web/src/server/assistant.ts`, `runTurn`) |
| Memory | `memory.md` and `about-you.md` on the Mac, with merge and review (assistant.md H) |
| Meaning search | Meetings and dictations only (`embeddings.source_type` in `web/src/db/schema.ts`) |
| Word search | Local FTS5 over history (`desktop/src-tauri/src/history_search_index.rs`) |
| Other agents | The Mac sees Claude Code sessions and can reply to them (`desktop/src-tauri/src/agents/`) |
| Monitors and schedules | Planned only (assistant.md D) |

## How it fits the model (no new nouns)

| Feature | Noun + verb |
|---|---|
| A brief | An **Event** on a Session or Item: a derived summary, replaced by the next version |
| Related work in a turn | Reading Items and Sessions (tier 0) |
| Passing your message to another session | **send** (human → Session), with Eavesy as the carrier |
| A watched event | An Event source feeding the attention queue (D2) |

## Requirements

### P. Briefs

- **P1.** A brief is a small JSON record: `summary` (600 characters),
  `intent` (one line), `outcome` (`in_progress`, `answered`, `done`,
  `partial`, `blocked` or `abandoned`, plus one line), up to 20 `decisions`,
  30 `facts`, 40 `links` and 12 `keywords`. These are Junior's fields and
  limits; we keep them so the two stay comparable.
- **P2.** Everything gets one: an Eavesy conversation, a meeting, a
  dictation, a note, a screenshot with text, and an agent session.
- **P3.** A brief is rewritten when its source changes and goes quiet: after
  a conversation has been idle for two minutes, when a meeting's summary
  lands, when an agent session stops or waits. A newer brief replaces the
  older one; an older write never replaces a newer one.
- **P4.** Briefs are written by the small model (Haiku 5.5) through the same
  stateless cloud call as today's summaries. The cloud keeps nothing.
- **P5.** Briefs live in the Mac's SQLite, next to the thread. Meetings and
  dictations already have a cloud copy; their briefs sync with them. Briefs
  of agent sessions and Eavesy conversations stay on the Mac (see decision 2).
- **P6.** The conversation itself is saved in SQLite, so it survives a
  restart. **Clear** and **Off the Record** (H3) still work: an
  off-the-record conversation is never saved and never briefed.

### Q. Related work in a turn

- **Q1.** Before each of your turns, the Mac searches the briefs with your
  words and sends the top matches with the turn, at most five, at most
  2,000 characters in all.
- **Q2.** Each match is one line: what it is, its title, its outcome status
  and when it last changed. For example: "Claude Code session · eavesy repo ·
  fixing HUD phase sync · in progress · 4 minutes ago".
- **Q3.** Matches go to the model as a fenced data block, like notes (H3).
  They are content, never instructions (C4), and never go to the check (C7).
- **Q4.** In-progress work ranks above finished work, and recent above old.
  A match must clear a threshold; below it, nothing is sent. Sending nothing
  is the normal case.
- **Q5.** The model can ask for more with a `related_work` tool (tier 0)
  that returns a full brief by id.
- **Q6.** You can see what was sent: the turn shows "Looked at: 2 related
  items", and opening it lists them.
- **Q7.** A switch in Settings → Assistant turns the whole thing off.

### R. Passing a message on

- **R1.** When a related agent session owns what you are talking about,
  Eavesy may offer to pass your message to it: "The eavesy session is on
  this. Send it your note?" It is a tier 2 action with read-back: you see
  the exact words and the session's name before anything is sent.
- **R2.** It reuses the reply path the agents hub already has. Eavesy adds
  one line saying the message came through it and what you said, word for
  word. It never rewrites your words into an instruction of its own.
- **R3.** Tool results that name a piece of work (a pull request, a branch)
  carry the ids of the sessions working on it, so the model doesn't have to
  search for them.
- **R4.** Sessions don't message each other on their own in this plan. An
  agent asking another agent for something goes through N, at the caller's
  tier.

### S. Watched events

- **S1.** A watch is a monitor (D1) with a target and an intent: "pull
  request 412, tell me if checks fail".
- **S2.** An event joins the attention queue at the level you set (D2). It
  never interrupts a turn in progress and never jumps ahead of something you
  said.
- **S3.** A watch proposes; it does not act (D3).
- **S4.** While the Mac is awake, watches are polled from the Mac. Firing
  while the Mac sleeps needs the `MacLink` Durable Object from
  agent-architecture.md, and is out of scope here.

## Where it runs

- **The Mac** keeps the loop, the tools, the thread, the briefs and the
  search index. It is still the only app that manages Eavesy.
- **The cloud** stays a stateless model step, plus the embedding index that
  meetings and dictations already use.
- **The phone** reaches Eavesy through the Mac, over the Drops and inbox
  paths that exist. With the Mac off it can still search the library.
- **Offline**, you keep your conversations, briefs and word search. There is
  no local model in the app, so answers and meaning search need a connection.

## Decisions

These take the recommended option and can be changed in a follow-up.

1. **Word search first.** Step 2 ships on the local FTS5 index alone. It
   needs no new cloud data and works offline.
2. **Agent-session briefs stay local by default.** Meaning search over them
   means sending brief text to the cloud for embedding, so step 3 puts that
   behind a switch that is off until you turn it on.
3. **One embedding per brief**, not per chunk, for the new source types.
   Meetings and dictations keep their chunk embeddings.
4. **The threshold starts at Junior's 0.4 cosine** for a match by meaning
   alone, and gets tuned on real use. Junior marks the number as untuned.
5. **No autonomous peer messaging** (R4) until passing messages by hand has
   been used for a while.

## Build order

Each step ships on its own and is useful alone.

1. **Save the conversation and write briefs** (P). A table for threads, a
   table for briefs, the brief call, and briefs listed on each item's page.
   Built: Eavesy's conversation is saved as it grows and comes back after a
   restart (`assistant/saved.rs`). It gets a brief two minutes after it goes
   quiet and again on Clear, written by `/api/assistant/brief` on the small
   model and kept in the Mac's `briefs` table. Settings → Assistant → Memory
   lists the briefs, each with Forget. Off the record, nothing is saved or
   briefed, and what was saved before goes. Clear keeps the brief unless you
   also forget what the conversation taught. "Don't remember this" drops the
   brief, and the next one leaves that exchange out. Briefs follow the
   Memory switch until step 2 gives them their own.
   Still to do: briefs for meetings, dictations, notes, screenshots and
   agent sessions (P2), and a brief on each item's own page.
2. **Related work in a turn, by word match** (Q), with the "Looked at" line
   and the off switch.
3. **Meaning search over briefs**: widen `embeddings.source_type`, embed one
   vector per brief, and combine the two scores (decisions 2 to 4).
4. **Passing a message to a session** (R1 to R3).
5. **Watches** (S), with assistant.md step 6.

## How we'll know it works

- Steps 1 and 2: a recorded set of real questions, each with the items a
  person would call related. We track how often the right item is in the top
  five, and how often something is sent when nothing should be.
- Step 4: every passed message appears in the Activity log with the words
  sent and the session it went to.

## Sources

- [getsentry/junior](https://github.com/getsentry/junior), commit `cff5c65`
- [Building an Intern](https://cra.mr/building-an-intern), David Cramer, 2026-07-02
- [A Little Determinism](https://cra.mr/a-little-determinism), David Cramer, 2026-10-29
- [Junior docs](https://junior.sentry.dev/)
