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
    let (codec, payload): (u8, &[u8]) =
        if raw.len() < RAW_STORE_THRESHOLD || compressed.len() >= raw.len() {
            (CODEC_RAW, raw)
        } else {
            (CODEC_ZLIB, compressed.as_slice())
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

/// Write a blob atomically and return its SHA-256. Existing content is left
/// untouched (content-addressed dedup). The temporary file lives under
/// `<store>/tmp/`, is fsynced, and only then renamed into `objects/`.
pub fn write_blob(store_root: &Path, raw: &[u8]) -> Result<String, BlobError> {
    if raw.len() as u64 > MAX_BLOB_RAW_BYTES {
        return Err(BlobError::RawContentTooLarge {
            actual_len: raw.len() as u64,
            limit: MAX_BLOB_RAW_BYTES,
        });
    }
    let hash = blob_hash(raw);
    let final_path = blob_path(store_root, &hash);
    if final_path.is_file() {
        return Ok(hash);
    }

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
    tmp.as_file()
        .sync_all()
        .map_err(|source| io_error(tmp.path(), source))?;
    tmp.persist(&final_path)
        .map_err(|error| io_error(&final_path, error.error))?;
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_path() -> PathBuf {
        PathBuf::from("<memory>")
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

        let hash = write_blob(root, &raw).expect("write");
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

        let again = write_blob(root, &raw).expect("dedup write");
        assert_eq!(again, hash);
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
}
