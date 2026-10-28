# Two-track bench

Scores who-said-what on scripted calls. It answers "did this change make
attribution better or worse?" with numbers instead of a feeling.

To compare Whisper with another transcription engine on the same audio, see
[`engines/`](engines/README.md).

| Scenario | What it checks |
|---|---|
| `call-headset` | Clean two-sided call: baseline recall and attribution. |
| `call-speakers` | The other side leaks into the mic (laptop speakers): echo must not become "you". |
| `overlap` | Both sides talk at once: both are kept, on the right side. |
| `several-remote` | Two remote voices: both are "them". |
| `silence` | Hiss only: no invented lines. |

## Running it

```bash
cd web
bun bench/generate.ts   # macOS: voices each script with `say` into bench/out/
../scripts/cf bun bench/record.ts
bun bench/score.ts --check
```

`record.ts` sends each track through the production Whisper call
(`WorkersAiSegmentTranscriber`) and commits Whisper's raw output to
`bench/recorded/`. `score.ts` replays that through the real processing
Worker on an in-memory D1, so CI scores every change to attribution, echo
removal and hallucination filtering without any network or spend.
Re-record when the Whisper model or its parameters change.

Scores: **found** is the share of scripted words present near their time;
**side** is the share of those on the right side; **leaked** counts mic lines
that are really the other side's echo; **lines** must be zero for silence.
Thresholds live in `thresholds.json`.
