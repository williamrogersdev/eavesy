# Startup, substring search, and transcription workers

Compared with desktop 0.5.4 (`3a08f273`) on Apple M5 Pro / 48 GiB / macOS 26.6.2, Rust 1.95.0. Optimized builds use thin LTO, one codegen unit, and unchanged full-disk flush durability. Synthetic data only; no user recordings or provider calls.

## Results

Medians of seven repetitions after warm-up, with warm files and OS caches. History fixtures have a roughly 105 KB transcript plus summary/notes. These are component measurements, not whole-app launch or end-to-end transcription latency.

| Operation | Recordings | 0.5.4 | Optimized |
| --- | ---: | ---: | ---: |
| Reconciliation work | 500 | 242.43 ms | 150.48 ms |
| Missing search term | 500 | 39.36 ms | 4.88 ms |
| Oldest-record search | 500 | 43.06 ms | 5.41 ms |
| Common-term search | 500 | 1.60 ms | 1.88 ms |
| Reconciliation work | 2,000 | 1056.41 ms | 666.88 ms |
| Missing search term | 2,000 | 156.42 ms | 5.79 ms |
| Oldest-record search | 2,000 | 170.96 ms | 6.16 ms |
| Common-term search | 2,000 | 2.70 ms | 2.96 ms |

Recovery now runs on a worker. Dispatch measured 0.014 ms at 2,000 recordings, excluding native watcher registration and other setup. Background recovery still takes 667 ms. Sync waits for offline edits and already-queued folder moves to reach the outbox, while setup proceeds. Readiness waits are bounded; a timeout reports and retries without allowing cloud writes to bypass recovery. The watcher registers before scanning and replays queued events afterwards; each collection window is bounded so a steady event stream cannot postpone processing indefinitely.

At the same three-request cap, 18 synthetic transcription pieces with repeating 120/20/20 ms durations took 762.9 → 408.6 ms. Uniform 40 ms pieces took 291.2 → 284.7 ms. This measures scheduling headroom, not live-provider speed. Ordered assembly, retry policy, error handling and the concurrency cap are preserved.

## Search and tradeoffs

- Trigram document-ID indexes narrow candidates; original lowercased `instr` checks remain authoritative for substring, all-token, Unicode and punctuation behavior. Short queries retain the exact scan fallback. SQLite's tokenizer stops at embedded NULs, so indexed exception sets keep those rows eligible for full checking.
- A bounded recent-row probe avoids enumerating every index hit for common searches. Independent read-only WAL connections keep searches off the history mutation mutex. UI generations propagate through every refreshed page; obsolete SQL work is cancelled even when IPC requests arrive out of order.
- Initial indexing is atomic background work, with the scan fallback available until ready. Pending history mutations interrupt and roll back construction; the worker retries later. Filesystem replay runs independently of index construction. The one-time 2,000-record build took 1914 ms, excluded from steady-state query timings.
- At 2,000 records, durable title changes were 4.01 → 3.92 ms; transcript changes were 3.96 → 6.02 ms. Index maintenance adds about 2 ms per transcript edit in this fixture. Empty-page reads were 1.30 → 1.41 ms, including opening the optimized read connection and installing cancellation.
- Database size grew from 438,689,792 to 439,005,184 bytes. Repetitive synthetic transcripts compress well: index size, build time and write overhead on diverse real text may differ substantially. No whole-app RAM reduction is claimed.

## Reproduction

`next-results.json` includes all timings and ranges, index/storage costs, and implementation fingerprints emitted from compile-time `include_bytes!` snapshots, not hashes recomputed after a run. The portable runner imports the production history and worker-queue modules with dependency versions pinned to the desktop lockfile and the same release profile:

```sh
cargo run --locked --release --manifest-path desktop/bench/next-runner/Cargo.toml
```

The harness is also the desktop `next-performance` example. `next-history-baseline.rs` freezes 0.5.4 history excluding tests; the harness retains the old batch scheduler. Both history implementations assert identical fixture responses before timing.

After the normal desktop prebuild, benchmark actual filesystem recovery:

```sh
cargo test --locked --release --manifest-path desktop/src-tauri/Cargo.toml --lib next_reconciliation_benchmark -- --ignored --nocapture
```

`next-reconcile.rs` compares the frozen old per-file algorithm with production recovery, using isolated synthetic app databases. Fixtures are removed on success. Run performance suites serially to avoid competing disk IO. Verify the recorded snapshots against the checkout with `node desktop/bench/check-next-sources.mjs`; source drift requires remeasurement rather than rewriting the recorded fingerprints.

Regression coverage includes exact Unicode/substring parity, paging/filters, index insert/update/delete and rollback, interrupted and retryable indexing, recording-write priority, reordered cancellation, queued/offline edits without observation rows, sync readiness, ordered work, bounded concurrency, panics and failure scheduling. Existing native capture and Worker suites remain in CI. This PR does not cut a desktop release.
