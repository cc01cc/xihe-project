//! Checkpoint store v1 blob codec and atomic writes (`FORMAT.md` §3).
//!
//! A blob is `XCS1 | codec u8 | raw_len u64 LE | payload`. `codec=0` stores
//! the original bytes, `codec=1` stores zlib-compressed deflate output. Small
//! (<64 B) or incompressible content stays raw so the store never pays more
//! than the header for a pointless compression attempt.
//!
//! Decoding is bounded by [`MAX_BLOB_RAW_BYTES`] before any allocation, and
//! verified callers also check the decoded length and SHA-256 against the
//! content-addressed file name. That is the triple check required by
//! `FORMAT.md` §3 and enforced by the T1.2 reader.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use sha2::{Digest, Sha256};

pub const BLOB_MAGIC: [u8; 4] = *b"XCS1";
pub const HEADER_LEN: usize = 13;
pub const CODEC_RAW: u8 = 0;
pub const CODEC_ZLIB: u8 = 1;

/// Hard cap for a single decoded blob. Checkpoint files are normally far
/// smaller; the cap prevents a forged `raw_len` from causing an unbounded
/// allocation. Raise it together with the streaming decoder work (T2.8).
pub const MAX_BLOB_RAW_BYTES: u64 = 1024 * 1024 * 1024;

/// Reject a zlib stream whose declared output is more than this multiple of
/// its compressed payload *before* allocating memory to decode it. This is the
/// v1 zip-bomb guard; the streaming decoder (T2.8) can relax it once output is
/// written incrementally instead of buffered in memory.
pub const MAX_DECOMPRESSION_RATIO: u64 = 4096;

/// Content below this size is stored raw even if it happens to compress.
const RAW_STORE_THRESHOLD: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("blob I/O failed at {path:?}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("blob header at {path:?} is too short: {len} bytes (need at least 13)")]
    HeaderTooShort { path: PathBuf, len: usize },
    #[error("blob at {path:?} has invalid magic")]
    BadMagic { path: PathBuf },
    #[error("blob at {path:?} uses unsupported codec {codec}")]
    UnsupportedCodec { path: PathBuf, codec: u8 },
    #[error("blob at {path:?} declares raw_len={raw_len}, above the {limit}-byte limit")]
    RawLenTooLarge {
        path: PathBuf,
        raw_len: u64,
        limit: u64,
    },
    #[error("blob at {path:?} decoded to {actual_len} bytes, expected {expected_len}")]
    LengthMismatch {
        path: PathBuf,
        expected_len: u64,
        actual_len: u64,
    },
    #[error("blob at {path:?} hash mismatch: expected {expected}, got {actual}")]
    HashMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
    #[error("blob at {path:?} is corrupt: {reason}")]
    Corrupt { path: PathBuf, reason: String },
    #[error(
        "blob at {path:?} declares raw_len={raw_len} from only {payload_len} compressed bytes (ratio limit {limit}x)"
    )]
    CompressionRatioTooHigh {
        path: PathBuf,
        raw_len: u64,
        payload_len: u64,
        limit: u64,
    },
    #[error("blob hash {hash:?} is not 64 lowercase hex characters")]
    InvalidHash { hash: String },
    #[error("blob content is {actual_len} bytes, above the {limit}-byte limit")]
    RawContentTooLarge { actual_len: u64, limit: u64 },
    #[error("blob encoding failed: {reason}")]
    Encode { reason: String },
}

fn io_error(path: &Path, source: std::io::Error) -> BlobError {
    BlobError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Lowercase SHA-256 hex of the original (decoded) bytes.
pub fn blob_hash(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

pub fn is_valid_blob_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// `objects/<aa>/<bb>/<sha256>` under the store root (`FORMAT.md` §2).
pub fn blob_path(store_root: &Path, hash: &str) -> PathBuf {
    debug_assert!(
        is_valid_blob_hash(hash),
        "blob hash must be validated before calling blob_path"
    );
    store_root
        .join("objects")
        .join(&hash[0..2])
        .join(&hash[2..4])
        .join(hash)
}

/// Pick the v1 codec for a candidate compression result. This is also the
/// writer-side invariant that keeps us from producing a blob our reader would
/// reject: when the zlib result exceeds the reader's 4096x ratio guard we fall
/// back to raw instead of writing an unreadable object.
fn select_codec(raw_len: usize, compressed_len: usize) -> u8 {
    if raw_len < RAW_STORE_THRESHOLD
        || compressed_len >= raw_len
        || raw_len as u64 > (compressed_len as u64).saturating_mul(MAX_DECOMPRESSION_RATIO)
    {
        CODEC_RAW
    } else {
        CODEC_ZLIB
    }
}

/// Encode `raw` using the cheapest v1 codec: raw for small/incompressible
/// content, zlib otherwise. The returned bytes are exactly the on-disk blob
/// file content.
pub fn encode_blob(raw: &[u8]) -> Result<Vec<u8>, BlobError> {
    if raw.len() as u64 > MAX_BLOB_RAW_BYTES {
        return Err(BlobError::RawContentTooLarge {
            actual_len: raw.len() as u64,
            limit: MAX_BLOB_RAW_BYTES,
        });
    }
    let compressed = zlib_compress(raw)?;
    let codec = select_codec(raw.len(), compressed.len());
    let payload: &[u8] = if codec == CODEC_RAW {
        raw
    } else {
        compressed.as_slice()
    };

    let mut encoded = Vec::with_capacity(HEADER_LEN + payload.len());
    encoded.extend_from_slice(&BLOB_MAGIC);
    encoded.push(codec);
    encoded.extend_from_slice(&(raw.len() as u64).to_le_bytes());
    encoded.extend_from_slice(payload);
    Ok(encoded)
}

fn zlib_compress(raw: &[u8]) -> Result<Vec<u8>, BlobError> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw).map_err(|source| BlobError::Encode {
        reason: source.to_string(),
    })?;
    encoder.finish().map_err(|source| BlobError::Encode {
        reason: source.to_string(),
    })
}

fn parse_header<'a>(bytes: &'a [u8], path: &Path) -> Result<(u8, u64, &'a [u8]), BlobError> {
    if bytes.len() < HEADER_LEN {
        return Err(BlobError::HeaderTooShort {
            path: path.to_path_buf(),
            len: bytes.len(),
        });
    }
    if &bytes[..4] != BLOB_MAGIC.as_slice() {
        return Err(BlobError::BadMagic {
            path: path.to_path_buf(),
        });
    }

    let codec = bytes[4];
    if codec != CODEC_RAW && codec != CODEC_ZLIB {
        return Err(BlobError::UnsupportedCodec {
            path: path.to_path_buf(),
            codec,
        });
    }

    let mut len_bytes = [0u8; 8];
    len_bytes.copy_from_slice(&bytes[5..HEADER_LEN]);
    let raw_len = u64::from_le_bytes(len_bytes);
    if raw_len > MAX_BLOB_RAW_BYTES {
        return Err(BlobError::RawLenTooLarge {
            path: path.to_path_buf(),
            raw_len,
            limit: MAX_BLOB_RAW_BYTES,
        });
    }

    Ok((codec, raw_len, &bytes[HEADER_LEN..]))
}

/// Decode an in-memory blob without verifying its content hash. Prefer
/// [`decode_blob_verified`] for bytes read by hash from a store.
pub fn decode_blob(bytes: &[u8], path: &Path) -> Result<Vec<u8>, BlobError> {
    let (codec, raw_len, payload) = parse_header(bytes, path)?;
    let payload_len = payload.len() as u64;
    if codec == CODEC_ZLIB && raw_len > payload_len.saturating_mul(MAX_DECOMPRESSION_RATIO) {
        return Err(BlobError::CompressionRatioTooHigh {
            path: path.to_path_buf(),
            raw_len,
            payload_len,
            limit: MAX_DECOMPRESSION_RATIO,
        });
    }
    match codec {
        CODEC_RAW => {
            let actual_len = payload.len() as u64;
            if actual_len != raw_len {
                return Err(BlobError::LengthMismatch {
                    path: path.to_path_buf(),
                    expected_len: raw_len,
                    actual_len,
                });
            }
            Ok(payload.to_vec())
        }
        CODEC_ZLIB => {
            let decoder = ZlibDecoder::new(payload);
            // `take` bounds the output even if the stream is a decompression
            // bomb or lies about `raw_len`; the expected length is checked
            // below, so reading one extra byte is enough to detect overflow.
            let mut limited = decoder.take(raw_len.saturating_add(1));
            let mut decoded = Vec::new();
            limited
                .read_to_end(&mut decoded)
                .map_err(|source| BlobError::Corrupt {
                    path: path.to_path_buf(),
                    reason: source.to_string(),
                })?;
            let actual_len = decoded.len() as u64;
            if actual_len != raw_len {
                return Err(BlobError::LengthMismatch {
                    path: path.to_path_buf(),
                    expected_len: raw_len,
                    actual_len,
                });
            }
            Ok(decoded)
        }
        _ => Err(BlobError::UnsupportedCodec {
            path: path.to_path_buf(),
            codec,
        }),
    }
}

/// Decode and perform the full content-addressed check required for reads:
/// codec/length (inside [`decode_blob`]) plus SHA-256 of the decoded bytes.
pub fn decode_blob_verified(
    bytes: &[u8],
    path: &Path,
    expected_hash: &str,
) -> Result<Vec<u8>, BlobError> {
    if !is_valid_blob_hash(expected_hash) {
        return Err(BlobError::InvalidHash {
            hash: expected_hash.to_owned(),
        });
    }
    let decoded = decode_blob(bytes, path)?;
    let actual = blob_hash(&decoded);
    if actual != expected_hash {
        return Err(BlobError::HashMismatch {
            path: path.to_path_buf(),
            expected: expected_hash.to_owned(),
            actual,
        });
    }
    Ok(decoded)
}

/// Read and fully verify a blob by its content hash.
pub fn read_blob(store_root: &Path, hash: &str) -> Result<Vec<u8>, BlobError> {
    if !is_valid_blob_hash(hash) {
        return Err(BlobError::InvalidHash {
            hash: hash.to_owned(),
        });
    }
    let path = blob_path(store_root, hash);
    let bytes = fs::read(&path).map_err(|source| io_error(&path, source))?;
    decode_blob_verified(&bytes, &path, hash)
}

/// Result of [`write_blob`]. `deduped` tells the caller whether the content
/// was already present, so capture stats can count `blobs_new` vs
/// `blobs_dedup` without re-statting the object path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobWriteOutcome {
    pub hash: String,
    pub deduped: bool,
}

/// Write a blob atomically and return its SHA-256. Existing content is left
/// untouched (content-addressed dedup). The temporary file lives under
/// `<store>/tmp/`, is fsynced, and only then renamed into `objects/`.
pub fn write_blob(store_root: &Path, raw: &[u8]) -> Result<BlobWriteOutcome, BlobError> {
    #[cfg(test)]
    use std::time::Instant;

    #[cfg(test)]
    let started = Instant::now();
    if raw.len() as u64 > MAX_BLOB_RAW_BYTES {
        return Err(BlobError::RawContentTooLarge {
            actual_len: raw.len() as u64,
            limit: MAX_BLOB_RAW_BYTES,
        });
    }
    let hash = blob_hash(raw);
    #[cfg(test)]
    record_blob_timing(0, started);
    let final_path = blob_path(store_root, &hash);
    if final_path.is_file() {
        return Ok(BlobWriteOutcome {
            hash,
            deduped: true,
        });
    }

    #[cfg(test)]
    let started = Instant::now();
    let encoded = encode_blob(raw)?;
    let tmp_dir = store_root.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|source| io_error(&tmp_dir, source))?;
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
    }

    let mut tmp = tempfile::Builder::new()
        .prefix(".blob-")
        .tempfile_in(&tmp_dir)
        .map_err(|source| io_error(&tmp_dir, source))?;
    tmp.write_all(&encoded)
        .map_err(|source| io_error(tmp.path(), source))?;
    #[cfg(test)]
    record_blob_timing(1, started);

    #[cfg(test)]
    let started = Instant::now();
    tmp.as_file()
        .sync_all()
        .map_err(|source| io_error(tmp.path(), source))?;
    #[cfg(test)]
    record_blob_timing(2, started);

    #[cfg(test)]
    let started = Instant::now();
    tmp.persist(&final_path)
        .map_err(|error| io_error(&final_path, error.error))?;
    #[cfg(test)]
    record_blob_timing(3, started);
    Ok(BlobWriteOutcome {
        hash,
        deduped: false,
    })
}

#[cfg(test)]
static BLOB_WRITE_TIMING: [std::sync::atomic::AtomicU64; 4] = [
    std::sync::atomic::AtomicU64::new(0),
    std::sync::atomic::AtomicU64::new(0),
    std::sync::atomic::AtomicU64::new(0),
    std::sync::atomic::AtomicU64::new(0),
];

#[cfg(test)]
fn record_blob_timing(index: usize, started: std::time::Instant) {
    BLOB_WRITE_TIMING[index].fetch_add(
        started.elapsed().as_micros() as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
}

#[cfg(test)]
fn reset_blob_timing() {
    for counter in &BLOB_WRITE_TIMING {
        counter.store(0, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn memory_path() -> PathBuf {
        PathBuf::from("<memory>")
    }

    fn count_files(root: &Path) -> usize {
        let mut count = 0;
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries {
                let entry = entry.expect("dir entry");
                let path = entry.path();
                if entry.file_type().expect("file type").is_dir() {
                    stack.push(path);
                } else {
                    count += 1;
                }
            }
        }
        count
    }

    fn rewrite_raw_len(path: &Path, raw_len: u64) {
        let mut bytes = fs::read(path).expect("read blob");
        bytes[5..13].copy_from_slice(&raw_len.to_le_bytes());
        fs::write(path, bytes).expect("rewrite blob");
    }

    #[test]
    fn raw_codec_roundtrip_for_small_content() {
        let raw = b"small checkpoint file";
        let encoded = encode_blob(raw).expect("encode");
        assert_eq!(&encoded[..4], BLOB_MAGIC.as_slice());
        assert_eq!(encoded[4], CODEC_RAW);
        let decoded = decode_blob(&encoded, &memory_path()).expect("decode");
        assert_eq!(decoded, raw.to_vec());
    }

    #[test]
    fn zlib_codec_roundtrip_for_compressible_content() {
        let raw = vec![b'a'; 4096];
        let encoded = encode_blob(&raw).expect("encode");
        assert_eq!(encoded[4], CODEC_ZLIB);
        assert!(encoded.len() < raw.len() + HEADER_LEN);
        let decoded = decode_blob(&encoded, &memory_path()).expect("decode");
        assert_eq!(decoded, raw);
    }

    #[test]
    fn incompressible_content_falls_back_to_raw() {
        let raw: Vec<u8> = (0u16..512)
            .flat_map(|i| Sha256::digest(i.to_le_bytes()).to_vec())
            .collect();
        let encoded = encode_blob(&raw).expect("encode");
        assert_eq!(encoded[4], CODEC_RAW);
    }

    #[test]
    fn write_blob_is_atomic_and_content_addressed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let raw = vec![b'x'; 1024];

        let first = write_blob(root, &raw).expect("write");
        assert!(!first.deduped, "first write must miss the object cache");
        let hash = first.hash;
        assert!(is_valid_blob_hash(&hash));
        let path = blob_path(root, &hash);
        assert!(path.is_file());
        assert_eq!(blob_hash(&raw), hash);

        let bytes = fs::read(&path).expect("read blob");
        assert_eq!(
            decode_blob_verified(&bytes, &path, &hash).expect("decode"),
            raw
        );

        let leftover = fs::read_dir(root.join("tmp")).expect("tmp dir").count();
        assert_eq!(leftover, 0, "temporary files must not remain");
        assert_eq!(count_files(&root.join("objects")), 1);

        let again = write_blob(root, &raw).expect("dedup write");
        assert_eq!(
            again,
            BlobWriteOutcome {
                hash: hash.clone(),
                deduped: true,
            }
        );
        assert_eq!(count_files(&root.join("objects")), 1);
    }

    #[test]
    fn writer_falls_back_to_raw_when_ratio_exceeds_reader_guard() {
        // 1 MiB / 255 B is >4096x, so choosing zlib would create a blob that
        // the reader's ratio guard rejects. The writer must pick raw.
        assert_eq!(select_codec(1_048_576, 255), CODEC_RAW);
        // Exactly 4096x is allowed (the reader rejects only `raw_len > ...`).
        assert_eq!(select_codec(1_048_576, 256), CODEC_ZLIB);
        // Existing rules still apply: <64 B and no-gain stores stay raw.
        assert_eq!(select_codec(63, 8), CODEC_RAW);
        assert_eq!(select_codec(100, 100), CODEC_RAW);
        assert_eq!(select_codec(64, 8), CODEC_ZLIB);
    }

    #[test]
    fn one_mib_zero_blob_roundtrips_within_ratio_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let raw = vec![0u8; 1024 * 1024];
        let encoded = encode_blob(&raw).expect("encode");
        let payload_len = encoded.len() - HEADER_LEN;
        // Deflate's maximum ratio is ~1032x (measured: 1 MiB zeros -> ~1039 B,
        // ~1009x), so a real flate2 stream can never trip the 4096x reader
        // guard. Assert that fact instead of forcing a worse raw encoding.
        assert!(raw.len() as u64 <= payload_len as u64 * MAX_DECOMPRESSION_RATIO);
        assert_eq!(
            encoded[4], CODEC_ZLIB,
            "1 MiB zeros compress ~1000x, well below the 4096x guard"
        );

        let outcome = write_blob(root, &raw).expect("write");
        assert!(!outcome.deduped);
        let decoded = read_blob(root, &outcome.hash).expect("read back");
        assert_eq!(decoded, raw);
    }

    #[test]
    fn dedup_writes_two_objects_for_six_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let same = vec![b's'; 2048];
        let unique = vec![b'u'; 2048];

        let mut hits = 0;
        let mut misses = 0;
        let mut hashes = HashSet::new();
        for _ in 0..5 {
            let outcome = write_blob(root, &same).expect("write repeated content");
            if outcome.deduped {
                hits += 1;
            } else {
                misses += 1;
            }
            hashes.insert(outcome.hash);
        }
        let outcome = write_blob(root, &unique).expect("write unique content");
        if outcome.deduped {
            hits += 1;
        } else {
            misses += 1;
        }
        hashes.insert(outcome.hash);

        assert_eq!(hashes.len(), 2, "only two distinct contents exist");
        assert_eq!(misses, 2, "one miss for each distinct content");
        assert_eq!(hits, 4, "the other four writes must be dedup hits");
        assert_eq!(count_files(&root.join("objects")), 2);
    }

    #[test]
    fn corrupting_one_byte_is_rejected_with_path_and_hashes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let raw = b"corruption probe";
        let outcome = write_blob(root, raw).expect("write");
        let hash = outcome.hash;
        let path = blob_path(root, &hash);

        let mut bytes = fs::read(&path).expect("read blob");
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        fs::write(&path, bytes).expect("corrupt blob");

        let error = read_blob(root, &hash).expect_err("corrupted blob must be rejected");
        match error {
            BlobError::HashMismatch {
                path: error_path,
                expected,
                actual,
            } => {
                assert_eq!(error_path, path, "error must name the object path");
                assert_eq!(expected, hash);
                assert_ne!(actual, hash);
            }
            other => panic!("expected HashMismatch, got {other:?}"),
        }
    }

    #[test]
    fn zip_bomb_forged_raw_len_is_rejected_before_decode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let raw = vec![0u8; 1024 * 1024];
        let outcome = write_blob(root, &raw).expect("write");
        let hash = outcome.hash;
        let path = blob_path(root, &hash);

        rewrite_raw_len(&path, MAX_BLOB_RAW_BYTES + 1);
        let error = read_blob(root, &hash).expect_err("forged raw_len must be rejected");
        assert!(matches!(
            error,
            BlobError::RawLenTooLarge { raw_len, limit, .. }
                if raw_len == MAX_BLOB_RAW_BYTES + 1 && limit == MAX_BLOB_RAW_BYTES
        ));
    }

    #[test]
    fn zip_bomb_compression_ratio_is_rejected_before_decode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let raw = vec![0u8; 1024 * 1024];
        let outcome = write_blob(root, &raw).expect("write");
        let hash = outcome.hash;
        let path = blob_path(root, &hash);

        rewrite_raw_len(&path, MAX_BLOB_RAW_BYTES);
        let error = read_blob(root, &hash).expect_err("ratio bomb must be rejected");
        match error {
            BlobError::CompressionRatioTooHigh {
                raw_len,
                payload_len,
                limit,
                ..
            } => {
                assert_eq!(raw_len, MAX_BLOB_RAW_BYTES);
                assert!(payload_len < raw_len);
                assert_eq!(limit, MAX_DECOMPRESSION_RATIO);
                // The check runs before the zlib decoder is created, so no
                // buffer is allocated from the forged declared length.
            }
            other => panic!("expected CompressionRatioTooHigh, got {other:?}"),
        }
    }

    #[test]
    fn zip_bomb_output_length_mismatch_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let raw = vec![0u8; 1024 * 1024];
        let outcome = write_blob(root, &raw).expect("write");
        let hash = outcome.hash;
        let path = blob_path(root, &hash);

        rewrite_raw_len(&path, 1024);
        let error = read_blob(root, &hash).expect_err("length mismatch must be rejected");
        assert!(matches!(
            error,
            BlobError::LengthMismatch {
                expected_len: 1024,
                actual_len,
                ..
            } if actual_len > 1024
        ));
    }

    #[test]
    fn decode_rejects_bad_header_and_missing_bytes() {
        let path = memory_path();
        assert!(matches!(
            decode_blob(b"XCS", &path),
            Err(BlobError::HeaderTooShort { .. })
        ));

        let mut encoded = encode_blob(b"content").expect("encode");
        encoded[0] = b'Y';
        assert!(matches!(
            decode_blob(&encoded, &path),
            Err(BlobError::BadMagic { .. })
        ));

        let mut encoded = encode_blob(b"content").expect("encode");
        encoded[4] = 2;
        assert!(matches!(
            decode_blob(&encoded, &path),
            Err(BlobError::UnsupportedCodec { codec: 2, .. })
        ));
    }

    #[test]
    #[ignore = "manual 10k blob timing diagnostic; run with --ignored --nocapture"]
    fn diagnose_write_blob_10k() {
        let dir = tempfile::tempdir().expect("tempdir");
        reset_blob_timing();
        let started = std::time::Instant::now();
        for index in 0..10_000 {
            let raw = format!("payload-{index}");
            write_blob(dir.path(), raw.as_bytes()).expect("write blob");
        }
        let total_ms = started.elapsed().as_millis();
        let timing: Vec<u64> = BLOB_WRITE_TIMING
            .iter()
            .map(|counter| counter.load(std::sync::atomic::Ordering::Relaxed) / 1_000)
            .collect();
        eprintln!(
            "blob_write_10k total_ms={total_ms} hash_ms={} write_ms={} fsync_ms={} rename_ms={}",
            timing[0], timing[1], timing[2], timing[3]
        );
    }
}
