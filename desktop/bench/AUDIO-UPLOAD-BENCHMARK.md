# Bounded-memory audio uploads

Measured October 20, 2026 on macOS arm64 with rustc 1.95.0. The standalone
runner uses a synthetic sparse 128 MiB PCM WAV, eighteen four-minute chunks,
and three concurrent body readers. Each implementation produces 134,218,520
multipart-body bytes (PCM plus per-piece WAV headers).

| Isolated uploader | Maximum resident size |
| --- | ---: |
| Previous whole-file/chunk/multipart copies | 297,549,824 bytes (283.77 MiB) |
| File-backed chunk readers | 1,835,008 bytes (1.75 MiB) |

This measures the isolated preparation/upload-reader component, not the total
Tauri/webview/Swift process footprint. It uses no network service and is not
a network throughput benchmark. Timing is not used as an adoption criterion.

Production now plans file offsets and small WAV headers rather than loading
PCM into Vecs. Each multipart attempt has an independent replayable cursor
and exact body length. A shared opened file keeps the same inode across retries;
macOS/Unix uses positional reads without a shared seek cursor or mutex.
Other platforms use a locked seek/read fallback, never holding a lock during
network operations, so interleaved readers retain independent offsets. The temporary conversion
file lives until uploads finish and is removed on success/error. Original media
is retained. Chunk duration, concurrency, retry policy, MIME types, filenames,
transcript ordering, and server API stay the same.

Validation covers padded WAV metadata, exact byte equivalence to the old WAV
splitter, independent interleaved readers, partial-read replay, real multipart
retry after a local HTTP 503, truncated files, and cleanup. The full desktop
suite passes with seven added tests (247 passed, one ignored).

```sh
rustc --edition=2021 -O desktop/bench/audio-upload.rs -o /tmp/eavesy-audio-bench
/usr/bin/time -l /tmp/eavesy-audio-bench buffered
/usr/bin/time -l /tmp/eavesy-audio-bench streaming
```

The temporary test WAV is created and cleaned by the runner. macOS resource
counters may require running outside a restricted sandbox. The buffered mode
is a simulation of the previous copying strategy on a sparse file; the streaming mode imports the actual
production reader module. Both assert the same total body-byte count.
