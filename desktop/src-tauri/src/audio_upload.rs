//! Bounded-memory, replayable multipart bodies for saved recordings.
use std::fs::File;
use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(not(unix))]
use std::sync::Mutex;

#[cfg(unix)]
type SharedFile = Arc<File>;
#[cfg(not(unix))]
type SharedFile = Arc<Mutex<File>>;

fn shared_file(file: File) -> SharedFile {
    #[cfg(unix)]
    {
        Arc::new(file)
    }
    #[cfg(not(unix))]
    {
        Arc::new(Mutex::new(file))
    }
}

fn read_at(file: &SharedFile, buffer: &mut [u8], position: u64) -> io::Result<usize> {
    #[cfg(unix)]
    {
        std::os::unix::fs::FileExt::read_at(file.as_ref(), buffer, position)
    }
    #[cfg(not(unix))]
    {
        let mut file = file
            .lock()
            .map_err(|_| io::Error::other("audio file lock poisoned"))?;
        file.seek(SeekFrom::Start(position))?;
        file.read(buffer)
    }
}

pub(crate) struct AudioPiece {
    file: SharedFile,
    offset: u64,
    length: u64,
    header: Vec<u8>,
    pub filename: String,
    pub mime: &'static str,
}

impl AudioPiece {
    pub fn body_len(&self) -> u64 {
        self.header.len() as u64 + self.length
    }

    /// Each attempt gets its own cursor, while retaining the opened source
    /// inode. A retry starts at byte zero even after an earlier partial read.
    pub fn reader(&self) -> impl Read + Send + 'static {
        Cursor::new(self.header.clone()).chain(FileSlice {
            file: self.file.clone(),
            position: self.offset,
            remaining: self.length,
        })
    }
}

struct FileSlice {
    file: SharedFile,
    position: u64,
    remaining: u64,
}

impl Read for FileSlice {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 || buffer.is_empty() {
            return Ok(0);
        }
        let limit = buffer
            .len()
            .min(self.remaining.min(usize::MAX as u64) as usize);
        // Positional IO on macOS/Unix needs neither a shared cursor nor a lock.
        let count = read_at(&self.file, &mut buffer[..limit], self.position)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "audio changed during upload",
            ));
        }
        self.position += count as u64;
        self.remaining -= count as u64;
        Ok(count)
    }
}

pub(crate) struct PreparedAudio {
    pub pieces: Vec<AudioPiece>,
    temporary: Option<PathBuf>,
}

impl Drop for PreparedAudio {
    fn drop(&mut self) {
        self.pieces.clear();
        if let Some(path) = &self.temporary {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl PreparedAudio {
    pub fn original(path: &Path, is_video: bool) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("open media: {e}"))?;
        let length = file
            .metadata()
            .map_err(|e| format!("inspect media: {e}"))?
            .len();
        Ok(Self {
            pieces: vec![AudioPiece {
                file: shared_file(file),
                offset: 0,
                length,
                header: Vec::new(),
                filename: if is_video { "clip.mp4" } else { "audio.m4a" }.into(),
                mime: if is_video { "video/mp4" } else { "audio/mp4" },
            }],
            temporary: None,
        })
    }

    /// Takes ownership of afconvert's temporary WAV, including error cleanup.
    /// Plan only offsets and 44-byte headers; never load the PCM into memory.
    pub fn converted_wav(path: PathBuf, seconds: usize) -> Result<Self, String> {
        let mut prepared = Self {
            pieces: Vec::new(),
            temporary: Some(path.clone()),
        };
        let mut file = File::open(&path).map_err(|e| format!("open converted audio: {e}"))?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let (format, offset, length) =
            wav_layout(&mut file, size).map_err(|e| format!("read converted WAV: {e}"))?;
        let byte_rate = u32::from_le_bytes(format[8..12].try_into().unwrap()) as u64;
        let alignment = u16::from_le_bytes(format[12..14].try_into().unwrap()) as u64;
        if byte_rate == 0 || alignment == 0 || seconds == 0 {
            return Err("invalid WAV rate or chunk duration".into());
        }
        let chunk = byte_rate
            .checked_mul(seconds as u64)
            .ok_or("WAV chunk overflow")?;
        let chunk = (chunk / alignment)
            .max(1)
            .checked_mul(alignment)
            .ok_or("WAV chunk overflow")?;
        if chunk > u32::MAX as u64 - 36 {
            return Err("WAV chunk exceeds RIFF limit".into());
        }
        let file = shared_file(file);
        let mut position = 0;
        while position < length {
            let count = chunk.min(length - position);
            let mut header = Vec::with_capacity(44);
            header.extend_from_slice(b"RIFF");
            header.extend_from_slice(&(36 + count as u32).to_le_bytes());
            header.extend_from_slice(b"WAVEfmt ");
            header.extend_from_slice(&16u32.to_le_bytes());
            header.extend_from_slice(&format);
            header.extend_from_slice(b"data");
            header.extend_from_slice(&(count as u32).to_le_bytes());
            prepared.pieces.push(AudioPiece {
                file: file.clone(),
                offset: offset + position,
                length: count,
                header,
                filename: format!("audio-{}.wav", prepared.pieces.len()),
                mime: "audio/wav",
            });
            position += count;
        }
        Ok(prepared)
    }
}

fn wav_layout(file: &mut File, size: u64) -> io::Result<([u8; 16], u64, u64)> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "not a PCM WAV");
    let mut riff = [0; 12];
    file.read_exact(&mut riff)?;
    if &riff[..4] != b"RIFF" || &riff[8..] != b"WAVE" {
        return Err(invalid());
    }
    let mut format = None;
    let mut data = None;
    let mut at = 12u64;
    while at + 8 <= size {
        file.seek(SeekFrom::Start(at))?;
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let length = u32::from_le_bytes(header[4..].try_into().unwrap()) as u64;
        if &header[..4] == b"fmt " {
            if length < 16 || size - at - 8 < 16 {
                return Err(invalid());
            }
            let mut bytes = [0; 16];
            file.read_exact(&mut bytes)?;
            format = Some(bytes);
        } else if &header[..4] == b"data" {
            data = Some((at + 8, length.min(size - at - 8)));
        }
        at += 8 + length + (length & 1);
    }
    let format = format.ok_or_else(invalid)?;
    if u16::from_le_bytes([format[0], format[1]]) != 1 {
        return Err(invalid());
    }
    let (offset, length) = data.ok_or_else(invalid)?;
    Ok((format, offset, length))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        // SystemTime on macOS can return the same tick on parallel test threads.
        std::env::temp_dir().join(format!("eavesy-upload-{}.wav", uuid::Uuid::new_v4()))
    }
    fn wav() -> Vec<u8> {
        let mut bytes = Vec::from(&b"RIFF"[..]);
        bytes.extend_from_slice(&46u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"JUNK");
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&[7, 0]);
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.extend_from_slice(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        bytes
    }
    #[test]
    fn chunks_preserve_pcm_and_retry_from_the_start() {
        let path = fixture();
        std::fs::write(&path, wav()).unwrap();
        let prepared = PreparedAudio::converted_wav(path.clone(), 1).unwrap();
        assert_eq!(prepared.pieces.len(), 3);
        let mut joined = Vec::new();
        for piece in &prepared.pieces {
            let mut body = Vec::new();
            piece.reader().read_to_end(&mut body).unwrap();
            assert_eq!(body.len() as u64, piece.body_len());
            assert_eq!(&body[..4], b"RIFF");
            assert_eq!(&body[36..40], b"data");
            joined.extend_from_slice(&body[44..]);
            let mut partial = [0; 45];
            piece.reader().read_exact(&mut partial).unwrap();
            let mut replay = Vec::new();
            piece.reader().read_to_end(&mut replay).unwrap();
            assert_eq!(body, replay);
        }
        assert_eq!(joined, (0..10).collect::<Vec<u8>>());
        drop(prepared);
        assert!(!path.exists());
    }
    #[test]
    fn interleaved_readers_have_independent_offsets() {
        let path = fixture();
        std::fs::write(&path, wav()).unwrap();
        let prepared = PreparedAudio::converted_wav(path, 1).unwrap();
        let mut first = prepared.pieces[0].reader();
        let mut second = prepared.pieces[1].reader();
        let mut a = Vec::new();
        let mut b = Vec::new();
        for _ in 0..48 {
            let mut byte = [0];
            first.read_exact(&mut byte).unwrap();
            a.push(byte[0]);
            second.read_exact(&mut byte).unwrap();
            b.push(byte[0]);
        }
        assert_eq!(&a[44..], &[0, 1, 2, 3]);
        assert_eq!(&b[44..], &[4, 5, 6, 7]);
    }
    #[test]
    fn invalid_conversion_is_cleaned_but_original_is_retained() {
        let path = fixture();
        std::fs::write(&path, b"bad WAV").unwrap();
        assert!(PreparedAudio::converted_wav(path.clone(), 1).is_err());
        assert!(!path.exists());
        std::fs::write(&path, b"original").unwrap();
        let prepared = PreparedAudio::original(&path, true).unwrap();
        let mut bytes = Vec::new();
        prepared.pieces[0].reader().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"original");
        drop(prepared);
        assert!(path.exists());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn truncated_source_is_an_error_instead_of_a_short_success() {
        let path = fixture();
        std::fs::write(&path, b"original").unwrap();
        let prepared = PreparedAudio::original(&path, false).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(2)
            .unwrap();
        assert!(prepared.pieces[0]
            .reader()
            .read_to_end(&mut Vec::new())
            .is_err());
        drop(prepared);
        std::fs::remove_file(path).unwrap();
    }
}
