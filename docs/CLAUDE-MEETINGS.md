# Eavesy and Claude Meetings

Claude Meetings (Anthropic, beta from November 2026, Team and Enterprise
plans) adds Claude to a Google Meet call as a visible participant. It answers
in the Meet chat, builds docs and whiteboards during the call, and keeps
notes, action items and a transcript on a meeting page in Claude. It saves no
audio. Other platforms are announced, not shipped.

As of 2026-11-12, from Anthropic's pages below. Nothing here was tried in a
live call with Claude: plan defaults, the guest rule and connector use are
Anthropic's description, and the product is in beta, so confirm them in
Claude's own settings before relying on them.

Sources: <https://support.claude.com/en/articles/18325154-use-claude-meetings>,
<https://claude.com/resources/articles/claude-meetings>.

## What works together

Unconfirmed, as Anthropic describes it:

| Eavesy | With Claude in the call |
| --- | --- |
| Mac app recording | Works. Eavesy adds nobody to the call, so Claude's guest rules don't apply. Anything Claude says aloud lands in the "Them" track; a doc it presents is caught as snapshots. |
| Eavesy Notetaker (the bot) | Works only where the organization allows outside guests. See below. |
| Eavesy connector (MCP) | Works. Claude can use a person's connectors during a call, with their approval, so "Claude, what did we decide last week?" can be answered from the Eavesy library (`search_meetings`, `get_meeting`, `get_action_items`). |
| Claude's notes into Eavesy | Not possible yet. Claude Meetings has no API, export or MCP access to its meeting pages. Anthropic lists transcript hand-off to other notetakers as coming soon. |

## The bot and Claude's guest rule

Claude treats anyone from outside the organization as an outside guest,
**another company's notetaker included**. Eavesy's bot joins signed out, so it
is one. Unless an owner has allowed meetings with external guests (off by
default on Enterprise, on by default on Team), Claude stays out of a call the
bot is invited to and leaves when the bot joins. When guests are allowed,
Claude keeps taking notes but stops replying in the Meet chat.

Eavesy can't change that from its side. For a call where Claude should stay,
record with the Mac app instead of sending the bot.

## What Eavesy does about Claude

- **Leaving.** The bot counts a call that holds only itself and other
  notetakers as empty and leaves after the usual minute
  (`workers/meeting-bot/bot/src/assistants.rs`). It stays whenever the app's
  head count differs from the tiles it reads, or one of them has spoken at
  any point in the call. **Not handled yet:** a tile named just "Claude". That
  is probably what Claude Meetings shows, but it isn't documented and it is a
  person's name, so the bot treats it as a person. In a call left to the bot
  and a tile named "Claude", the bot therefore stays until the call ends or
  its own time limit is reached. Add the name to `CLAUDE_NAMES` once it has
  been seen in a call.
- **Notes.** The summary prompt treats an assistant on the call as software:
  what it reported is kept, but it never owns an action item or a decision
  (`web/src/lib/ai/meeting-summary.ts`).

## Ideas worth taking

Not built. Listed in the order they'd pay off for Eavesy:

1. **Answer in the call's chat.** The bot posts one line today. Reading the
   chat for "Eavesy, …" and answering from the live transcript and the library
   is the heart of Claude Meetings, and Eavesy already has the rolling summary
   and "Ask Eavesy".
2. **Recap before the call ends.** Post decisions and action items in chat
   when asked, or when the scheduled end is near.
3. **Pause and resume.** "Stop listening" from the chat or the meeting page,
   for the off-the-record part of a call.
4. **Auto-join rules.** All meetings, or all except one-to-ones.
5. **Guest rule of our own.** An option to keep the bot out of calls with
   people outside the user's domain.
6. **Recap email** to the invited people in the user's workspace.
