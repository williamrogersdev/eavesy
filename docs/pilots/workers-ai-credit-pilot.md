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

## Initial synthetic comparison

After correcting structured response handling, Qwen3 30B passed 10/10 automatic
fixture checks, Mistral Small passed 8/10 (including an unsafe interpretation of
a quoted injection), and Llama 3.3 passed 4/10 (several malformed response
shapes). The pilot therefore selects Qwen3 30B for answers and import summaries.
These are small synthetic tests, not a general model-quality benchmark.
