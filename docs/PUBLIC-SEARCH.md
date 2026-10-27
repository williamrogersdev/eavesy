# Public search implementation

This website change starts from `0281b20` on main, the source matching the public site reviewed on October 20, 2026. The branch was then updated with main after PR #151 merged. It leaves desktop, database, provider configuration, and account access unchanged. The older primary checkout contains ongoing product work and is not the release base for this change.

## Product facts used by the public pages

| Fact | Current source |
| --- | --- |
| Talk uses on-device recognition when available, with signed-in cloud fallback | `desktop/src-tauri/src/audio.rs`, `web/src/content/docs/talk-and-dictation.mdx` |
| Meeting captures microphone and computer audio; Video adds the screen | `desktop/src-tauri/src/audio.rs`, `web/src/content/docs/meetings.mdx`, `web/src/content/docs/video.mdx` |
| Recording files use summary.md, transcript.md, notes.md, meeting.json, and available media | `desktop/src-tauri/src/fs_writer.rs` |
| Recording folder is configurable, with a default under ~/Eavesy/Recordings | `desktop/src-tauri/src/fs_writer.rs`, desktop settings |
| Hosted MCP uses account authorization and offers read tools for supported synced content | `workers/mcp/src/index.ts`, `web/src/server/mcp-oauth.ts` |
| Cross-recording answers include evidence and can abstain or report context limits | `web/src/server/library-memory.ts`, `web/src/lib/ai/library-answer.ts`, `web/src/routes/app/memory.tsx` |
| Downloaded version 0.5.4 predates walkthrough context and local walkthrough MCP; newer source includes them | Release tag `desktop-v0.5.4` at `3a08f27`; walkthrough implementation merged later as `01e6122` in PR #151 |

These are source-backed product descriptions. Website checks do not constitute a fresh hardware capture test or authenticated third-party client test. The guides use supported setup instructions and explain access boundaries; the examples explicitly identify fictional, hand-authored teaching material. The workspace screenshot is captured from the included working teaching fixture, not presented as output from Eavesy.

## First 20 pages

Existing URLs are retained where the intent already had a page. There are 15 new detail pages and 5 existing pages expanded or corrected, plus three navigation hubs.

| Plan item | Path | Treatment |
| --- | --- | --- |
| 1 | `/features/walkthroughs` | New capability with released recording and visual-access limits |
| 2 | `/guides/screen-recording-to-markdown` | New practical guide |
| 3 | `/integrations/claude-code` | New local-files and hosted-MCP guide |
| 4 | `/integrations/cursor` | New dictation, screenshot, and MCP guide |
| 5 | `/templates/ai-bug-report` | New copy/download template |
| 6 | `/examples/narrated-ui-bug` | New worked example and interactive fixture |
| 7 | `/features/dictation` | Expanded technical dictation behavior and boundaries |
| 8 | `/integrations/obsidian` | Rewritten as explicit Markdown/file compatibility |
| 9 | `/guides/record-microphone-and-system-audio` | New mode, permissions, and playback guide |
| 10 | `/integrations/zoom` | Expanded call-specific workflow |
| 11 | `/integrations/google-meet` | Expanded browser-call workflow |
| 12 | `/guides/local-recording-context` | Replaces the proposed unreleased local-MCP guide with a supported local-file workflow |
| 13 | `/docs/connect-mcp` | Updated current tools, limits, and hosted/local distinction |
| 14 | `/guides/share-local-recordings-with-ai` | New file/attachment/access guide |
| 15 | `/guides/recording-microphone-troubleshooting` | New practical diagnostic guide |
| 16 | `/templates/decision-log` | New copy/download template |
| 17 | `/templates/meeting-action-items` | New copy/download template |
| 18 | `/guides/find-decisions-in-recordings` | New retrieval and source-checking guide |
| 19 | `/examples/meeting-to-markdown` | New illustrative transcript and brief |
| 20 | `/examples/library-answer-with-sources` | New source-verification exercise |

## Existing site repairs

- Remove the homepage comparison component and its unused data.
- Remove the existing comparison articles. Permanently redirect the bot-free recording article to `/features/bot-free-capture` and the speech-to-text listicle to `/features/transcription`. The unrelated text-to-speech listicle has no equivalent Eavesy feature and returns 404.
- Correct the captions/account contradiction, dictation copy, overly broad recording/MCP claims, default shortcut description, and promises of unlimited retrieval or perfect recovery.
- Explain copy and paste, local files, and hosted MCP accurately on integration pages. Remove assertions that organization or device policies cannot apply.
- Add guide, template, and example hubs with contextual navigation and related links.
- Enforce publication state for direct lookups and lists. Drafts and scheduled dated content cannot resolve publicly or enter the sitemap.
- Use actual editorial dates where present and omit unknown lastmod values. Remove nonfunctional public SearchAction markup and escape JSON-LD script content.

## Verification

From `web/`, run `bun run build`, `bunx tsc --noEmit`, `bunx eslint . --max-warnings 0`, `bun run lint`, `bun run lint:parity`, `bun test src`, and `bun run test:workers`. The processing and MCP packages also retain their typecheck and dry-run bundle checks.

With a local preview running, `bun scripts/audit-publication-preview.ts` exercises the actual publication gates with temporary fixtures and removes them afterward.

With a local preview running, `bun scripts/audit-public-site.ts http://127.0.0.1:4173` audits the rendered sitemap, page status, one H1, title, description, canonical, internal links, retired URLs, and known stale claims. It reports all failures and exits unsuccessfully if any are found. It can also read an explicitly selected deployed origin.

Initial publication pass (PRs #156 and #158) validation: 70 sitemap pages and 7 additional internal link targets pass the SSR audit; all first 20 paths render at 320px without horizontal overflow or browser runtime errors. The Markdown copy control reports success at 390px. The committed publication audit checks a published control, five draft collections, and a scheduled guide through the actual routes and hubs. The unit and Worker suites pass; use the PR’s required CI run for the exact commit-specific counts. Vite refuses to start or build when stale audit fixtures remain.

Search Console/Bing ownership, actual search indexation, ranking, referral conversion, and packaged-app hardware behavior remain separate operational checks. No traffic volume or ranking gain is asserted by this implementation.

## Resource experience follow-up — October 21, 2026

The first publishing pass made the routes available but left plain collection grids
and static template code blocks. The follow-up adds curated capture-to-template-to-example
paths, a homepage resource entry, collection filtering with all entries server-rendered
initially, responsive article navigation, and reading estimates. All 20 launch content
sources now have additional task-specific guidance, troubleshooting, or worked output.

The three template pages have local editable fields, a Markdown preview, fictional
sample loading, clear/reset, clipboard copy, and a generated Markdown download. These
are website formatting utilities, not app features or AI generation. Drafts are held in
component memory only; nothing in the utility submits or persists entered fields.
The existing blank downloads remain available without JavaScript.

Mac 0.5.5 was publicly released on October 21 with walkthrough context and local MCP.
Walkthrough instructions now name that release while retaining the explicit 0.5.4
fallback and the distinction between local media and hosted account retrieval.
This source/release check does not substitute for installed-app hardware acceptance.

This follow-up (PR #171) browser QA covered the homepage, three collections, and all 20 launch routes at
375px with one H1 and no horizontal overflow or console errors. The three sample
loaders and template output were exercised; the bug report was edited, copied,
and downloaded, and collection empty-result recovery was checked. A source-level
unit test verifies missing fields remain explicit and entered source lines survive
Markdown output. The public HTTP audit also checks real section targets, article
navigation, and server-rendered editable-template previews.

The article-navigation check exposed an existing MDX/Vite issue: the MDX transform
was recompiling `?raw` text modules into empty layout components, leaving source
text unavailable for TOCs and reading estimates. The Vite wrapper now skips raw
queries and delegates normal MDX compilation unchanged. This also restores existing
docs/blog consumers of raw article content.
