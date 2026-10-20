# Library quality evaluations

`bun bench/library/evaluate.ts` checks citation boundaries without network calls or paid inference. It writes an offline report and explicitly marks model quality unmeasured.

After a separately approved pilot, set server-only `WORKERS_AI_API_KEY`, `WORKERS_AI_ACCOUNT_ID` to the credits account, `AI_CREDITS_EXPECTED_ACCOUNT_ID` to the same explicitly approved account, and `AI_CREDITS_STOP_AT`. Run:

```sh
bun bench/library/evaluate.ts --live --max-usd=0.10 --compare
```

This sends only the synthetic fixtures in `fixtures.ts` to three approved Cloudflare models. The cumulative budget persists in `out/ledger.sqlite` across runs; keep that file to preserve the limit. The report contains answers, exact quotes, latency, and automatic checks for abstention, names, amounts, negation, proposals, commitments, changed decisions and prompt injection. Human review is still required to judge whether the cited words support each claim. Passing a synthetic check is not proof of production quality or credit application on an invoice.

Extend the corpus with licensed or explicitly authorized audio and manually checked questions. Keep private fixtures, provider responses and raw audio outside Git. Expand the existing two-track bench for transcription; do not label model guesses as human ground truth. Compare summaries using the same transcripts and `creditSummary` schema, leaving Anthropic as the product default until the result has been reviewed.
