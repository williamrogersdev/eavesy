# Personal dictionary and contextual transcription repair

Corrections made in the web dictation editor, meeting transcript editor, desktop
transcript editor, or a supported external text field teach future recordings.
Only human edits enter `personal_dictionary`. AI suggestions never write to it.
The dictionary is scoped to the authenticated account (Clerk or a revocable
paired-device token), persists in D1, and is available on other paired devices.
Settings provides add, replace, review, and forget controls. Pair an unlinked Mac
before saving corrections; the legacy shared transcription token has no identity.

Learning uses a word-level comparison to separate individual corrections. It
ignores insertions/deletions, broad rewrites, digit/negation changes, and large
passages rather than creating arbitrary replacement rules. Source spellings
have one current correction per account. Repeated saves are idempotent; a new
human correction replaces an old one. The store retains at most 500 entries.
Relevant corrections guide contextual repair. Recent canonical spellings get
priority in Whisper's bounded `initial_prompt` on both one-shot and rolling audio.
The paired Mac refreshes its cached vocabulary after its own dictionary changes
and in the background at capture start. Web and other-device changes reach its
next refreshed capture; capture never waits for the network.

## Pasting into another app

Use dictation or Eavesy's **Paste at cursor** action. On macOS the observer binds to the
original accessible text field, locates the unique pasted passage, and watches
only that field for up to 60 seconds. After two seconds without another edit,
it sends only the dictated passage and the edited passage to the account's
feedback endpoint. It stops on focus changes, edits outside the passage, or a
new paste. Secure fields, fields without an AX text value, and ambiguous matches
are excluded. Copying and manually pasting with Cmd-V does not start observation.
Unsupported apps can use **Edit transcript** inside Eavesy instead. This is not
a keyboard logger. Offline feedback currently reports failure and requires retry
through the editor; it does not claim the correction was saved.

## Sentence-aware repair

Whisper voice activity detection is enabled and previous-text conditioning is
disabled. The repair step uses the existing Cloudflare AI runner (including its
configured credit routing) and Llama 3.3 JSON mode. An Anthropic implementation
remains available for callers that do not supply a Workers AI runner.

The model proposes small exact substring edits rather than a rewritten
transcript. Validation rejects malformed, missing, ambiguous, overlapping,
oversized, digit-changing or negation-changing edits. A model edit that would
undo an already present human-confirmed spelling is discarded. Context guides
recognition repair, but unusual statements and uncertain wording must be kept.
This is personal vocabulary conditioning, not retraining model weights.

Desktop one-shot responses include `rawText` and `repairStatus`. Paired cloud
sync saves original ASR output as `transcript.raw.md`. Web dictation keeps `transcript` separate
from `cleanedText`. Rolling meeting windows repair using surrounding sentences
without moving edits across timestamps or speakers; `transcript_segments.raw_text`
retains original recognition and paired desktop sync writes the raw transcript
alongside the repaired version. Redelivery does not overwrite human-edited lines.
Inputs above 12,000 characters or provider/validation failures keep raw output.

## Validation and release

The unit/integration suite covers human edit extraction, persistence, account
isolation, stale edits, idempotency, forgetting, meeting edits, raw retention,
structured provider replies, protected spellings, and timestamp boundaries.
Desktop Rust tests cover passage isolation and native sync formatting. Web,
launcher, Swift sidecar and Rust builds are checked separately.

On 2026-10-20 the end-to-end test used an approved 8.032-second microphone memo.
It caught an erroneous automatic `kept` → `typed` edit, persisted the human
`typed` → `kept` correction, and replayed the same audio successfully with
`repairStatus: complete` and the original transcript retained. A public human
speech fixture from the Open Speech Repository was also used to exercise the
speech service: https://www.voiptroubleshooter.com/open_speech/american.html .
This is a functional proof, not an accuracy benchmark across accents or noise.

Production requires migrations `0030_personal_dictionary.sql` and
`0033_transcript_raw_text.sql` in the repository's migration sequence, deployment
of the web and processing Workers, and an updated desktop build. These release
actions are separate from local validation. External-app accessibility behavior
varies by app and requires Eavesy's existing macOS Accessibility permission.

The optional `native_external_correction_e2e` Rust test is excluded from the
ordinary suite. It requires a disposable foreground TextEdit document containing
exactly `Existing. Open a pool request. After.` plus `EAVESY_NATIVE_TEST_BASE`
(localhost only) and `EAVESY_NATIVE_TEST_CLIENT` (the temporary test token file).
The test refuses any other field. Once it prints `OBSERVER_READY`, change `pool`
to `pull` and leave the document focused. It exercises actual AX reads, idle
observation, HTTP feedback and D1 learning. The foreground handoff was completed
on 2026-10-20: the exact fixture was captured, the human `pool` → `pull` edit
was detected, and the native test passed. A separate authenticated GET then
confirmed `pool` → `pull` in the persisted dictionary. Both the ordinary native
suite and the explicit foreground external-app integration test have passed.
