# Transcription engine comparison

Runs the same recordings through Whisper (what Eavesy uses) and NVIDIA
Nemotron 3.5 Transcribe, and scores both against a reference transcript. It
answers "would switching engines make transcripts better?" with numbers
from our own kind of audio, not the vendor's leaderboard.

| Engine | How it runs here |
|---|---|
| `whisper` | The production call (`WorkersAiSegmentTranscriber`, Whisper Large v3 Turbo on Workers AI) on 4-minute pieces, as the app uploads them, with the production hallucination filter. |
| `nemotron` | `nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B` through any OpenAI-compatible chat completions server, whole file at once (it takes up to an hour), with the model card's speaker-tag prompt. |

## Recordings

- **Scripted calls**: the two-track bench's scenarios (`bun bench/generate.ts`),
  mic and computer audio mixed into one file, as a single-mic room or the
  meeting bot hears them. Synthetic `say` voices, so treat them as a smoke
  test, not a verdict.
- **Your own**: `--cases <folder>` with one folder per recording holding
  `audio.*` (anything `afconvert` or `ffmpeg` reads), `reference.txt`, and
  optionally `terms.txt` (vocabulary, one per line, sent to both engines).
  Write `reference.txt` by hand: a model's transcript is not ground truth.
  Put `Name: words` on every line to score speakers too. Keep this folder,
  its audio and the saved responses out of Git.

## Running it

```bash
cd web
bun bench/generate.ts
CLOUDFLARE_ACCOUNT_ID=… NEMOTRON_BASE_URL=https://…/v1 NEMOTRON_API_KEY=… \
  ../scripts/cf bun bench/engines/compare.ts --cases ~/eavesy-eval
```

`NEMOTRON_BASE_URL` is the `/v1` root of a server that takes the model card's
request: a self-hosted vLLM (`http://127.0.0.1:8000/v1`, one 80 GB H100 for
BF16) or a hosted provider that serves the model. Set `NEMOTRON_MODEL` if the
provider names it differently. An engine with no credentials is skipped. An
API key is only sent over https, or to this machine. The whole recording goes
in one request as a 16 kHz WAV (about 110 MiB for an hour); the model card's
server takes up to 180 MiB, but a hosted provider or proxy may cap requests
lower, so try a short recording first.

Flags: `--engines whisper,nemotron`, `--only <recording>`, `--language en`
(Whisper only), and `--replay`, which re-scores the saved responses without
any network or spend.

Every response is saved in `bench/out/engines/` (ignored by Git) as soon as
it arrives, so a failure halfway through keeps what was already paid for;
`report.md` goes there too. Replaying a recording whose saved responses no
longer fit its audio fails and names the file to record again.

## Scores

- **WER**: word error rate over the whole recording, after lowercasing,
  dropping punctuation and thousands separators and spelling out 0 to 99, so
  "5" and "five" match. Bigger numbers and decimals are not spelled out, so
  write them in `reference.txt` the way the engines will. Silence reports the
  words invented instead.
- **cpWER**: speaker-attributed WER. Each reference speaker's words are
  paired with one recognized speaker's, picking the pairing with the fewest
  errors, so words given to the wrong person count, and a transcript with no
  speaker tags scores as one speaker. Only Nemotron labels
  speakers on one track; Whisper's "you" and "them" come from the two-track
  split, which `bench/score.ts` measures.
- **Speed**: audio length over the time the calls took, including the
  network.

`bun test bench/engines` checks the scoring and Nemotron parsing.
