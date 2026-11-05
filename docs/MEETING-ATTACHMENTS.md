# Meeting attachments: Snapshots and screenshots

While the Mac app records a meeting it keeps pictures of what was on screen,
so the notes can cover the slides, charts and designs, not only the words.

- **Snapshots.** Automatic. Every 2.5 s the capture engine
  (`desktop/swift-audio/Sources/SwiftAudio/SnapshotSampler.swift`) grabs the
  meeting window (Zoom, Teams, Webex, FaceTime, Slack, or a browser tab titled
  like a call), or the display under the pointer when no meeting window is
  found. A sample is kept only when all of these hold:
  1. it has settled: its 1024-bit difference hash is within 3% of the previous
     sample's (so transitions, scrolling and video are skipped; a small speaker
     tile over a share is not enough to unsettle it);
  2. it isn't blank (brightness spread of at least 6/255);
  3. it looks like shared content, not cameras: at least 40% of neighbouring
     pixels in a 256×144 sample are exactly equal;
  4. it changed at least 4% of a 128×72 thumbnail's pixels (by more than 24
     levels) from the last Snapshot kept: a new slide, or a new line on one;
  5. it comes at least 8 s after the last Snapshot.

  Only Meeting recordings (the `mixed` source) take Snapshots; the setting
  "Keep shared screens" (`snapshots` in settings.json, on unless turned off)
  stops them. Without Screen Recording permission the engine does nothing.
- **Screenshots.** The screenshot button on the panel's live meeting bar, and
  ⌘⇧3/4/5 screenshots (when "Add macOS screenshots automatically" is on),
  join the meeting being recorded instead of the history.

## On the Mac

Both live in the recording's folder, named by their offset in milliseconds
from the first audio (the transcript's clock):

```text
~/Eavesy/Recordings/2026-11-05 Weekly sync/
  snapshots/snapshot-000123456.jpg        123.456 s in, JPEG, ≤1920 px
  screenshots/screenshot-000200000.png
  screenshots/screenshot-000200000-2.png  a second one in the same ms
```

Files being written are hidden (`.name.partial`) and renamed when complete.
Sync (`desktop/src-tauri/src/meeting_attachments.rs`) uploads each file once,
after the transcript's audio segments, and records it in the local
`recording_attachments` table. One the server refuses for good (4xx) is
recorded as given up and not retried.

## Upload

`PUT /api/sessions/{meetingId}/attachments/{name}` with the device token.

| | |
|---|---|
| `{name}` | the file name without extension: `snapshot-000123456`, `screenshot-000200000-2` |
| `x-attachment-kind` | `snapshot` or `screenshot` (must match the name) |
| `x-attachment-offset-ms` | offset from the start of the recording |
| body | the PNG or JPEG, at most 20 MB; the type is read from the bytes |

201 on a new picture, 200 `{ idempotent: true }` for one already stored.
Quota: `meeting-attachment`, 3,000 a day.

## Stored shape

D1 table `meeting_attachments` (`web/src/db/schema.ts`):

| column | |
|---|---|
| `id` | `matt_…` |
| `meeting_id`, `user_id` | owner; rows go with the meeting (cascade) and the account purge |
| `kind` | `snapshot` \| `screenshot` |
| `client_name` | the uploader's name; unique per meeting |
| `offset_ms` | ms from the start of the recording, the same clock as `transcript_segments.start_ms` |
| `r2_key` | `users/{userId}/meetings/{meetingId}/attachments/{client_name}.{jpg,png}` (removed with the meeting's prefix) |
| `content_type`, `bytes`, `width`, `height` | read from the image itself |
| `caption`, `caption_model`, `captioned_at` | null until a vision step describes it |
| `created_at` | |

Indexes: `(meeting_id, offset_ms)` for a meeting's timeline, and
`created_at WHERE captioned_at IS NULL` for the captioning queue.

Read and write through `web/src/db/repo/attachments.ts`:

- `listForMeeting(db, meetingId)`: a meeting's pictures in time order.
- `listUncaptioned(db, { meetingId?, limit? })`: the captioning queue, oldest first.
- `setCaption(db, { id, caption, model })`: what the vision step writes back.
- `toView(row)`: the shape the meeting API returns.

To put a picture next to what was said, take the transcript lines whose
`start_ms` is within a few seconds of `offset_ms`. The image bytes are
`getObject(r2_key)` (`web/src/server/r2.ts`).

## In the app

`GET /api/meetings/{id}` returns `attachments: [{ id, kind, offsetMs, url,
width, height, caption }]`. The meeting page files each one in the transcript
after the line being spoken when it was taken
(`web/src/components/meeting/attachment-placement.ts`); clicking the time plays
the call from there, clicking the picture opens it full size.
