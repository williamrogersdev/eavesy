# Workers AI credit pilot

Imports, transcript-backed library answers, and read-only MCP library tools run
back to back, with verification after each operation rather than calendar stages.

## Access and budget

All three Workers accept server-only `WORKERS_AI_API_KEY`,
`WORKERS_AI_ACCOUNT_ID`, and `AI_CREDITS_EXPECTED_ACCOUNT_ID`. The latter two
must match; explicitly enabled credits mode fails closed on a missing credential
or wrong account. Use a Workers AI Write token restricted to the credits account.
Never put the token or account IDs in Git or client bundles.

Runtime switches: `AI_CREDITS_ENABLED`, `AI_CREDITS_PAUSED`,
`AI_CREDITS_STOP_AT`, `AI_CREDITS_BUDGET_USD`,
`AI_CREDITS_DAILY_BUDGET_USD`, and `AI_SUMMARY_PROVIDER=workers-ai`.
The approved pilot has a $100 cumulative ceiling, $10 UTC daily ceiling, and
stops November 17, 2026 at 00:00 UTC. The deployment stores these as Worker
secrets so future deployments preserve the configuration. Pause by setting
`AI_CREDITS_PAUSED=true` on all three Workers.

Only the pilot's own calls go through the credits account: the purposes in
`CREDIT_PURPOSES` (`web/src/lib/ai/credit-runner.ts`): import transcription
and summaries, library answers, and the MCP library tools. Meeting embeddings,
search, translation and transcript repair predate the pilot and always run on
the Worker's own `AI` binding, so pausing or ending the pilot leaves them
alone. That includes the embeddings `/api/library/reindex` backfills: the
route is only offered while the pilot is on, but the vectors it queues are
the same ones every new meeting gets, on the binding and outside the pilot's
caps.

D1 atomically reserves conservative per-request costs before inference. Failed
and interrupted requests retain their reservations. The programme counter is
shared by all Workers. One dollar of that ceiling is pre-reserved for setup and
external synthetic comparisons, whose separate persistent ledger is capped at
$0.25. Reservations and model-reported estimates are not invoices or proof that
Cloudflare applied promotional credits. Other applications' use of the same
credits account is outside this application's cap.

## Product paths

- `/app/import`: authenticated upload, original archive plus validated mono PCM
  WAV segments, resume, cancel and retry. Up to 60 minutes and 100 MiB per file.
  Processing begins only after every segment and the original are durable.
- Imports use Workers AI transcription and structured summaries. Existing
  desktop/browser provider choices remain in place. The downstream agent
  transcript uses model-free cleanup for pilot imports, avoiding an unmetered
  call to another provider. Summaries currently reject
  transcripts exceeding 60,000 characters; they never silently truncate them.
- `/app/memory`: hybrid transcript retrieval, exact-quote citations and source
  links that seek to the cited timestamp. Edited or deleted evidence is checked
  again after inference; unsupported citations fail closed.
- MCP exposes `search_library` and `ask_library` under existing revocable token
  and OAuth authentication. Neither tool changes meeting data.

All embedding calls use the same Qwen model/dimension as the existing index.
Only source records owned by the authenticated caller, completed and not
soft-deleted, become library evidence. A valid exact quote proves provenance;
it does not prove the model's interpretation. Review synthetic comparison
answers and actual citations before expanding usage. No background loop spends
credits merely to exhaust the grant.

## Verification

Run web build, typecheck, ESLint, unit and Worker tests, two-track bench and
migration checks, plus both standalone Worker typechecks and deployment dry
runs. The live check imports synthetic speech, waits for queue transcription,
checks summary model provenance and the D1 usage ledger, asks a supported and
unsupported question, follows a citation, and invokes both MCP tools with a
real owner token. Verify invalid credentials are rejected. Keep private raw
responses and credentials outside Git.

Migration aliases already applied from the old checkout are documented in
`web/drizzle/README.md`. Never reapply or delete that history.

## After the pilot

The runner fails closed from November 17, 2026 at 00:00 UTC: imports, the
answer step of `/app/memory` and the MCP library tools stop with "paused or
expired" until someone acts. Retrieval keeps working, since query embeddings
run on the binding; only the written answer is credit-gated. Within the week
before, in this order:

1. Decide what survives. `search_library`, `ask_library` and `/app/memory`
   answer with `@cf/qwen/qwen3-30b-a3b-fp8` and could run on the Worker's own
   `AI` binding at Workers AI list prices (the `TEXT_MODELS` figures in
   `credit-runner.ts`, taken on `PRICING_VERSION` 2026-10-20: about $0.05 per
   million input tokens and $0.34 per million output tokens; check the
   Workers AI pricing page before deciding). Keeping them means removing
   the `creditsConfigured` gates in `web/src/routes/api/library/ask.ts`,
   `web/src/routes/api/library/reindex.ts` and `workers/mcp/src/index.ts`
   and adding a daily quota per user; dropping them means removing the two
   MCP tools from `TOOL_DEFS`, the plugin's skill and `connect-mcp.mdx`, and
   the Memory page. Imports keep working either way: with the pilot off,
   `import-transcription` and `import-summary` fall through to the `AI`
   binding, so leave `AI_SUMMARY_PROVIDER=workers-ai` only if that cost is
   acceptable, otherwise unset it so imports use the Anthropic summary path.
2. Turn the pilot off, don't just let it expire: set `AI_CREDITS_ENABLED=false`
   on all three Workers, then delete `WORKERS_AI_API_KEY`,
   `WORKERS_AI_ACCOUNT_ID`, `AI_CREDITS_EXPECTED_ACCOUNT_ID`,
   `AI_CREDITS_STOP_AT`, `AI_CREDITS_BUDGET_USD` and
   `AI_CREDITS_DAILY_BUDGET_USD` (`wrangler secret delete`). Revoke the Workers
   AI token in the Cloudflare dashboard.
3. Keep the ledger. `ai_credit_budgets` and `ai_credit_usage` are the only
   record of what the pilot spent; export them before any cleanup migration and
   leave the tables in place (additive schema only).
4. Check nothing else depended on the credits account: run one import, one
   search, one translation and one MCP `search_meetings` on production after
   the switch, and watch `/api/ops/metrics` for a day.

## Initial synthetic comparison

After correcting structured response handling, Qwen3 30B passed 10/10 automatic
fixture checks, Mistral Small passed 8/10 (including an unsafe interpretation of
a quoted injection), and Llama 3.3 passed 4/10 (several malformed response
shapes). The pilot therefore selects Qwen3 30B for answers and import summaries.
These are small synthetic tests, not a general model-quality benchmark.
