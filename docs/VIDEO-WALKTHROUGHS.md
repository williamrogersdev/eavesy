# Video walkthroughs for AI agents

The desktop Screen button records the display, microphone narration, and computer
sound. Microphone access is required by default. The existing compact capture toolbar is preserved. Recording starts only after a
microphone buffer has actually reached the video writer. The recording pill shows
whether the microphone signal is active or quiet. A quiet signal can mean that you
are simply not speaking; it is not proof that the microphone is broken.

After Stop, Eavesy processes the recording in the background. The recording preview
shows context readiness. The copied context and manifest include the screenshot timeline and capture/processing warnings. The
ordinary **Copy** button and **⌘C** copy the full walkthrough context. **Paste into
active app** and **⌘↵** use the same payload. There is no separate AI copy mode.
Audio recordings continue to copy their transcript.

## Recording folder

Each recording lives in `~/Eavesy/Recordings/<recording>/`:

| File | Purpose |
| --- | --- |
| `screen.mp4` | Original video with mixed microphone and computer audio |
| `microphone.json` | Microphone enabled flag, written sample count, peak RMS |
| `context.md` | Portable readable context with relative media references |
| `walkthrough.json` | Versioned machine-readable context contract |
| `transcript.md` | Timestamped original recognition, then corrected full text |
| `frames/*.jpg` | Readable screenshots with cursor as captured in the video |
| `visual.json` | Local screenshot, OCR, and extracted audio-chunk index |
| `audio/*.m4a` | Audio extracted in chunks of at most two minutes |
| `audio/*.transcript.json` | Successful per-chunk responses for resumable retries |
| `moments.json` | Clicks and tagged elements or areas, with app, page and element details |
| `moments/*.jpg` | Close-ups of each click and tag, outlined in manila |
| `moments/crops.json` | Close-up paths and the text Vision read inside each one |

Speech timestamps and screenshot timestamps share the original video's zero point.
The original recognition retains its timing; dictionary-corrected full text is
explicitly labeled **not time-aligned**. Eavesy never invents timing for a service
response without segment/word timing.

Screenshots are sampled every two seconds for shorter recordings; for long
recordings the interval increases to bound work to roughly 241 candidates plus the
last screen. Similar candidates are deduplicated using both image and OCR changes,
with periodic refreshes. The exact interval is recorded in the manifest. Brief
transitions/gestures between candidates can be missed. OCR is extracted visible
text, not a claim about visual layout or meaning. Agents should inspect images or
the video for those questions.

Screen extraction and OCR run on the Mac through AVFoundation and Vision. Only
extracted audio goes to the existing authenticated transcription service. Videos
and screenshots are not uploaded by this feature. Context does not automatically
appear in the cloud meeting library or cloud MCP server.

## Clicks and tags

While the screen records, Eavesy notes every click outside its own windows: the
time in the video, the pointer, and what macOS Accessibility reports under it (role,
label, value, help text, enabled state, the HTML id, classes and link target in web
pages, and the groups it sits inside). Each click also records where it happened:
the app, its window title or document, and, in browsers, the page URL and title.
Values of secure text fields are never read.

**Mark** in the recording pill (or **⌥H**) opens the marker over the screen.
**Element** tags whatever is under the pointer when you click; **Area** tags a box
you drag. Tags are numbered, shown on screen while you keep recording, and left out
of the video like the rest of Eavesy's windows. **Undo tag** removes the last one;
**esc** or **Done** closes the marker. Clicks made while the marker is open are not
counted as clicks.

After Stop, each click and tag gets a close-up from the video, the text Vision reads
inside it, and the narration from 1.5 seconds before to 6 seconds after. `context.md`
lists them under **What the user pointed at**, and the recording card shows them as
**Evidence**. Clicks need no extra permission; the element details need the
Accessibility access Eavesy already asks for to paste.

## Copy and paste

The clipboard includes readable speech, OCR, warnings, and absolute paths to the
manifest, context file, screenshots, and video. An agent with local filesystem and
image access can immediately open the relevant files. The saved `context.md` and
manifest use relative paths so the whole folder can be moved/shared.

Pasting a path does not upload a file to a browser chat. Agents without access to
this Mac can still use the pasted narration and screen text; attach the screenshots
or recording when visual inspection is needed. Copied context explicitly explains
this boundary. Recorded speech and OCR are source material, not instructions an
agent should execute. Pasting a walkthrough also skips dictation correction
learning so screen text cannot become dictionary training feedback.

## Native local MCP server

The desktop executable also provides a read-only MCP stdio server. It starts
without a GUI, telemetry, a network listener, or account credentials, and can run
alongside the normal app. Configure an MCP client with:

```json
{
  "mcpServers": {
    "eavesy-recordings": {
      "command": "/Applications/Eavesy.app/Contents/MacOS/eavesy",
      "args": ["--walkthrough-mcp"]
    }
  }
}
```

Use the actual installed app path. For a development build, use the absolute path
to `desktop/src-tauri/target/debug/eavesy`. An optional
`--recordings-root /absolute/path/to/Recordings` selects another local library.
No separate runtime or package installation is needed.

Tools:

- `list_walkthroughs({query?, limit?})`: list recordings or search speech/OCR, with matching timestamps and short excerpts.
- `get_walkthrough({id, startMs?, endMs?})`: read the structured manifest and recording folder; optional time bounds keep long recordings manageable. Untimed corrected full text is omitted in range views.
- `get_walkthrough_frame({id, timestampMs})`: return the nearest saved screenshot
  as an actual MCP image plus OCR, actual timestamp, and sampling distance.
- `get_walkthrough_moment({id, number})`: return one click or tag with its element,
  place, narration and on-screen text, plus its close-up as an MCP image.

Media reads are confined to the selected recording folder, including symlink
resolution. Files outside that folder are rejected. The service does not start
recordings, modify them, upload them, or execute recorded instructions. Filesystem
agents can also read the manifests directly without MCP.

For a precise frame not present in the sampled timeline, a local agent can invoke
the bundled capture helper:

```sh
"/Applications/Eavesy.app/Contents/MacOS/SwiftAudio" \
  --extract-frame "/absolute/path/to/screen.mp4" \
  --at 18.5 --output "/tmp/eavesy-frame.jpg"
```

## Recovery and verification

Pending jobs resume after app restart. **Prepare / retry walkthrough context** in
the recording's actions also upgrades older recordings and retries partial jobs.
Successful timed transcription chunks are cached; failed or untimed responses are
retried. Partial context stays copyable and explicitly names missing evidence.
Unverified older microphone capture is labeled as such.

The web transcription API must be deployed with its `segments` and
`timestampSource` response fields before the new desktop can produce aligned
speech. An older server yields an explicit partial-context warning. The desktop
must also be rebuilt to include its new native processor, UI, and MCP server.

Automated checks:

```sh
# macOS media codecs must be available to the test process.
swift test --package-path desktop/swift-audio
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo build --manifest-path desktop/src-tauri/Cargo.toml
python3 scripts/test-walkthrough-agent.py
cd web
bun test src/lib/transcription/transcribe-file.test.ts
bunx tsc --noEmit
bun run build
```

The Swift integration test feeds generated microphone PCM into the actual recorder
without any system-audio callbacks, decodes the saved AAC to verify audible signal,
then extracts screenshots, OCR, and audio from the resulting video. This does not
replace a packaged-app hardware/TCC check: record a narrated walkthrough with
computer sound muted, verify microphone activity, stop, copy into a local agent,
and have it read the manifest and open a referenced screenshot. Also verify a
browser chat receives the text and does not claim it has accessed local images.
