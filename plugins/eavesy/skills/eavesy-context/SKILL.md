---
name: eavesy-context
description: Look up the user's own meetings, calls, dictations and action items in Eavesy. Use when the user refers to something said in a meeting or call ("what did we decide about…", "the call with…", "my action items"), to something they dictated, or asks you to work from a recording, transcript or summary you have not been given.
---

# Eavesy context

Eavesy turns the user's recordings and dictations into Markdown: a summary
(TL;DR, decisions, action items) and a full transcript. The `eavesy` MCP
server in this plugin lets you search and read them, so you don't have to ask
the user to paste anything.

## When to use it

- The user mentions a meeting, call, standup, interview or demo and you need
  what was said or decided.
- The user asks for their open action items, or who owns a task from a call.
- The user refers to something they dictated.
- The task depends on context from a conversation you weren't part of
  ("implement what we agreed in yesterday's design review").

Don't use it for general knowledge, for the codebase, or when the user has
already pasted the brief.

## How

1. Find the recording. Use `search_meetings` with a few distinctive words
   (a topic, a person, a product name). If the user said "my last call" or
   gave a date, use `recent_meetings` instead.
2. Read it. Call `get_meeting` with the id. Prefer the summary; go to the
   transcript only for exact wording or details the summary leaves out.
3. For tasks, call `get_action_items` (`status`: `open`, `completed` or `all`;
   optional `owner`).
4. For dictations, use `search_dictations`.

Say which recording you used (title and date) so the user can check it.
"Meeting" in the tool names means any recording, not only calls.

## Limits

- Clipboard notes, images and screenshots stay on the user's Mac and are not
  available over MCP. If the Mac app is installed, they are plain files under
  `~/Eavesy/Recordings/` (`note.md`, `image.png`, `screenshot.png` with
  `capture.json`) and you can read them with filesystem access.
- The connection is read-only unless the user allowed writes when they
  approved it. If a tool is refused as read-only, tell the user; they can
  reconnect and tick "Also let it write".
- The first call opens a browser to sign in to Eavesy and approve the
  connection. If the server isn't connected, ask the user to run `/mcp` and
  authenticate `eavesy`.
