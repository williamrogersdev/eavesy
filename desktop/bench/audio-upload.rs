//! Standalone memory comparison; run each mode under `/usr/bin/time -l`.
#[allow(dead_code)]
#[path = "../src-tauri/src/audio_upload.rs"]
mod audio_upload;
use std::fs::File;
use std::io::{self, Cursor, Write};

fn main() {
    let mode = std::env::args().nth(1).expect("buffered or streaming");
    assert!(mode == "buffered" || mode == "streaming");
    let size = 128 * 1024 * 1024u64;
    let path = std::env::temp_dir().join(format!("eavesy-audio-memory-{}.wav", std::process::id()));
    let mut file = File::create(&path).unwrap();
    file.write_all(b"RIFF").unwrap();
    file.write_all(&(size as u32 + 36).to_le_bytes()).unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16u32.to_le_bytes()).unwrap();
    for value in [1u16, 1] {
        file.write_all(&value.to_le_bytes()).unwrap();
    }
    file.write_all(&16_000u32.to_le_bytes()).unwrap();
    file.write_all(&32_000u32.to_le_bytes()).unwrap();
    for value in [2u16, 16] {
        file.write_all(&value.to_le_bytes()).unwrap();
    }
    file.write_all(b"data").unwrap();
    file.write_all(&(size as u32).to_le_bytes()).unwrap();
    file.set_len(size + 44).unwrap();
    drop(file);
    let total: u64;
    if mode == "streaming" {
        let prepared = audio_upload::PreparedAudio::converted_wav(path.clone(), 240).unwrap();
        total = std::thread::scope(|scope| {
            let mut count = 0;
            for batch in prepared.pieces.chunks(3) {
                let workers: Vec<_> = batch
                    .iter()
                    .map(|piece| {
                        scope.spawn(move || {
                            let actual = io::copy(&mut piece.reader(), &mut io::sink()).unwrap();
                            assert_eq!(actual, piece.body_len());
                            actual
                        })
                    })
                    .collect();
                count += workers
                    .into_iter()
                    .map(|worker| worker.join().unwrap())
                    .sum::<u64>();
            }
            count
        });
    } else {
        // Match the old preparation: whole-file buffer plus copied WAV pieces,
        // followed by another owned multipart-body copy per concurrent request.
        let bytes = std::fs::read(&path).unwrap();
        let pieces: Vec<Vec<u8>> = bytes[44..]
            .chunks(32_000 * 240)
            .map(|pcm| {
                let mut out = bytes[..44].to_vec();
                out[4..8].copy_from_slice(&(pcm.len() as u32 + 36).to_le_bytes());
                out[40..44].copy_from_slice(&(pcm.len() as u32).to_le_bytes());
                out.extend_from_slice(pcm);
                out
            })
            .collect();
        std::hint::black_box(&bytes);
        std::hint::black_box(&pieces);
        drop(bytes);
        total = std::thread::scope(|scope| {
            let mut count = 0;
            for batch in pieces.chunks(3) {
                let workers: Vec<_> = batch
                    .iter()
                    .map(|piece| {
                        scope.spawn(move || {
                            let copied = std::hint::black_box(piece.clone());
                            io::copy(&mut Cursor::new(copied), &mut io::sink()).unwrap()
                        })
                    })
                    .collect();
                count += workers
                    .into_iter()
                    .map(|worker| worker.join().unwrap())
                    .sum::<u64>();
            }
            count
        });
    }
    let chunks = size.div_ceil(32_000 * 240);
    assert_eq!(total, size + 44 * chunks);
    let _ = std::fs::remove_file(path);
    println!("{mode}: {chunks} chunks, {total} body bytes, three concurrent uploads");
}
