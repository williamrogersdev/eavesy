---
name: eavesy-context
description: Look up the user's own meetings, calls, dictations, notes, screenshots and action items in Eavesy. Use when the user refers to something said in a meeting or call ("what did we decide about…", "the call with…", "my action items"), to something they dictated, noted or took a screenshot of, or asks you to work from a recording, transcript, summary or capture you have not been given.
---

# Eavesy context

Eavesy turns what the user records, dictates, writes down and captures into
Markdown: recordings get a summary (TL;DR, decisions, action items) and a full
transcript, and notes, clipboard text and screenshots are kept alongside them.
The `eavesy` MCP server in this plugin lets you search and read all of it, so
you don't have to ask the user to paste anything.

## When to use it

- The user mentions a meeting, call, standup, interview or demo and you need
  what was said or decided.
- The user asks for their open action items, or who owns a task from a call.
- The user refers to something they dictated, a note they wrote, text they
  copied, or a screenshot they took.
- The task depends on context from a conversation you weren't part of
  ("implement what we agreed in yesterday's design review").

Don't use it for general knowledge, for the codebase, or when the user has
already pasted the brief.

## How

1. Find the item.
   - `search` with a few distinctive words (a topic, a person, a product
     name). It covers every kind; narrow it with `kinds` (`meeting`,
     `dictation`, `note`, `image`, `video`, `audio`), `project`, and
     `since`/`until` (ISO dates like `2026-10-01`).
   - `recent` when the user said "my last call", "the note I wrote this
     morning" or gave a date, with the same filters.
2. Read it. Call `get` with the item's `id`. For a recording, prefer the
   summary and the user's own notes; go to the transcript only for exact
   wording or details the summary leaves out. A screenshot comes back as an
   image you can look at.
3. For tasks, call `get_action_items` (`status`: `open`, `completed` or `all`;
   optional `owner`).
4. For a question that needs quotes across many recordings, `ask_library`
   answers with sources, but it counts against the user's daily AI quota.

Say which item you used (title and date) so the user can check it.
"Meeting" means any recording, not only calls.

## Limits

- Only what is in the user's account can be found. Notes, clipboard text,
  screenshots and images made on a Mac that was signed out stay on that Mac.
  If the Mac app is installed, they are plain files under
  `~/Eavesy/Recordings/` (`note.md`, `image.png`, `screenshot.png` with
  `capture.json`) and you can read them with filesystem access.
- Screenshots from the Mac app are found by their title, not their text. If
  `search` misses one, try `recent` with `kinds: ["image"]` and a date range.
- A `search` that includes recordings or dictations counts against the
  user's daily search quota. Pass `kinds` when you know what you want.
- The connection is read-only unless the user allowed writes when they
  approved it. If a tool is refused as read-only, tell the user; they can
  approve the connection again and grant write access on the approval page.
- The first call opens a browser to sign in to Eavesy and approve the
  connection. If the server isn't connected, ask the user to run `/mcp` and
  authenticate `eavesy`.
