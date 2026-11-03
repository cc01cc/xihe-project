//! Store layout, VERSION validation, and cross-process locking
//! (`FORMAT.md` §2 and §7).
//!
//! v1 serializes the whole store with one OS-level exclusive lock. The lock is
//! advisory to other processes and is released by the OS when the holder exits
//! or crashes, so a leftover `lock` file never means "still busy". The file
//! content is diagnostic: it records `(pid, created_at_ms, process_start_token)`
//! so a stale owner can be identified without trusting a recycled PID alone.

use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const STORE_VERSION: &str = "xh-checkpoint-store/1";
pub const VERSION_FILE: &str = "VERSION";
pub const LOCK_FILE: &str = "lock";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("store I/O failed at {path:?}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("store VERSION file is missing at {path:?}")]
    VersionMissing { path: PathBuf },
    #[error("store version mismatch: expected {expected:?}, found {found:?}")]
    VersionMismatch { expected: String, found: String },
    #[error("store is busy: {path:?} is locked by another process")]
    Busy { path: PathBuf },
    #[error("lock owner file at {path:?} is invalid: {reason}")]
    LockOwnerInvalid { path: PathBuf, reason: String },
    #[error("lock owner serialization failed: {reason}")]
    LockOwnerEncode { reason: String },
}

fn io_error(path: &Path, source: std::io::Error) -> StoreError {
    StoreError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Directory name for a logical root id. Unsupported or unsafe values are
/// hashed so a root id can never escape `slices/` (`..` included, even though
/// the character class would otherwise allow it).
pub fn root_id_dir(root_id: &str) -> String {
    let safe = !root_id.is_empty()
        && root_id.len() <= 64
        && root_id != "."
        && root_id != ".."
        && root_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if safe {
        return root_id.to_owned();
    }
    let digest = format!("{:x}", Sha256::digest(root_id.as_bytes()));
    format!("h-{}", &digest[..16])
}

/// Diagnostic lock owner. The OS lock is authoritative; this metadata is for
/// stale detection (PID reuse, crash) and human debugging.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockOwner {
    pub pid: u32,
    pub created_at_ms: u64,
    /// Opaque process start token (Windows: raw FILETIME ticks; Linux: the
    /// starttime field from /proc). Comparable only for the same boot.
    pub process_start_token: Option<u64>,
}

impl LockOwner {
    /// `evaluated_start_token` is looked up for `pid` by the caller (injected
    /// in tests). A vanished process or a different start token means the PID
    /// was recycled, so the on-disk owner is stale.
    pub fn looks_stale(&self, evaluated_start_token: Option<u64>) -> bool {
        match (self.process_start_token, evaluated_start_token) {
            (Some(stored), Some(current)) => stored != current,
            _ => true,
        }
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn process_start_token(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // Safety: the handle is closed below; FILETIME pointers are valid for the
    // duration of GetProcessTimes. This is the only unsafe in the checkpoint
    // store and mirrors the existing job_engine Windows boundary.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    Some((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

#[cfg(unix)]
fn process_start_token(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let end = stat.rfind(')')?;
    let fields: Vec<&str> = stat[end + 1..].split_whitespace().collect();
    fields.get(19)?.parse().ok()
}

#[cfg(not(any(windows, unix)))]
fn process_start_token(_pid: u32) -> Option<u64> {
    None
}

#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// Create the v1 layout and VERSION file if absent. An existing VERSION
    /// must match; `init` never migrates or downgrades silently.
    pub fn init(root: impl AsRef<Path>) -> Result<Self, StoreError> {
        let root = root.as_ref();
        fs::create_dir_all(root).map_err(|source| io_error(root, source))?;
        for relative in ["objects", "manifests", "slices", "index/stat", "gc", "tmp"] {
            let dir = root.join(relative);
            fs::create_dir_all(&dir).map_err(|source| io_error(&dir, source))?;
        }
        let version_path = root.join(VERSION_FILE);
        if !version_path.exists() {
            fs::write(&version_path, format!("{STORE_VERSION}\n"))
                .map_err(|source| io_error(&version_path, source))?;
        }
        Self::open(root)
    }

    /// Open an existing store. The root is canonicalized (Windows gets the
    /// `\\?\` long-path form); VERSION must match exactly (trailing newline
    /// tolerated).
    pub fn open(root: impl AsRef<Path>) -> Result<Self, StoreError> {
        let root =
            fs::canonicalize(root.as_ref()).map_err(|source| io_error(root.as_ref(), source))?;
        let version_path = root.join(VERSION_FILE);
        let content = match fs::read_to_string(&version_path) {
            Ok(content) => content,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Err(StoreError::VersionMissing { path: version_path });
            }
            Err(source) => return Err(io_error(&version_path, source)),
        };
        let found = content.trim_end_matches(['\n', '\r']).to_owned();
        if found != STORE_VERSION {
            return Err(StoreError::VersionMismatch {
                expected: STORE_VERSION.to_owned(),
                found,
            });
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn version(&self) -> &'static str {
        STORE_VERSION
    }

    pub fn blob_path(&self, hash: &str) -> PathBuf {
        super::blob::blob_path(&self.root, hash)
    }

    pub fn manifest_path(&self, manifest_id: &str) -> PathBuf {
        debug_assert_eq!(manifest_id.len(), 64, "manifest id must be 64 hex chars");
        self.root
            .join("manifests")
            .join(&manifest_id[0..2])
            .join(&manifest_id[2..4])
            .join(format!("{manifest_id}.json"))
    }

    pub fn slice_dir(&self, root_id: &str) -> PathBuf {
        self.root.join("slices").join(root_id_dir(root_id))
    }

    pub fn stat_cache_path(&self, root_id: &str) -> PathBuf {
        self.root
            .join("index")
            .join("stat")
            .join(format!("{}.json", root_id_dir(root_id)))
    }

    pub fn lock_path(&self) -> PathBuf {
        self.root.join(LOCK_FILE)
    }

    /// Read the diagnostic lock owner, if the lock file exists and is valid.
    pub fn lock_owner(&self) -> Result<Option<LockOwner>, StoreError> {
        let path = self.lock_path();
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(io_error(&path, source)),
        };
        if bytes.is_empty() {
            return Ok(None);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| StoreError::LockOwnerInvalid {
                path,
                reason: error.to_string(),
            })
    }

    /// Acquire the v1 store-wide lock immediately; never waits.
    pub fn lock(&self) -> Result<StoreLock, StoreError> {
        StoreLock::acquire(self)
    }
}

/// Exclusive store lock. Dropping it releases the OS lock; a process crash
/// releases it too, so stale `lock` files are not blocking.
#[derive(Debug)]
pub struct StoreLock {
    file: File,
}

impl StoreLock {
    pub fn acquire(store: &Store) -> Result<Self, StoreError> {
        let path = store.lock_path();
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|source| io_error(&path, source))?;
        match file.try_lock_exclusive() {
            Ok(()) => {}
            Err(source)
                if source.kind() == std::io::ErrorKind::WouldBlock
                    || source.raw_os_error() == Some(33) =>
            {
                return Err(StoreError::Busy { path });
            }
            Err(source) => return Err(io_error(&path, source)),
        }
        file.set_len(0).map_err(|source| io_error(&path, source))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|source| io_error(&path, source))?;
        let owner = LockOwner {
            pid: std::process::id(),
            created_at_ms: now_ms(),
            process_start_token: process_start_token(std::process::id()),
        };
        let encoded = serde_json::to_vec(&owner).map_err(|error| StoreError::LockOwnerEncode {
            reason: error.to_string(),
        })?;
        file.write_all(&encoded)
            .map_err(|source| io_error(&path, source))?;
        Ok(Self { file })
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::*;

    fn test_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Store::init(dir.path()).expect("init store");
        (dir, store)
    }

    #[test]
    fn init_creates_layout_and_open_validates_version() {
        let (dir, store) = test_store();
        assert_eq!(
            fs::read_to_string(store.root().join(VERSION_FILE)).expect("version"),
            format!("{STORE_VERSION}\n")
        );
        for relative in ["objects", "manifests", "slices", "index/stat", "gc", "tmp"] {
            assert!(store.root().join(relative).is_dir(), "{relative} missing");
        }
        let reopened = Store::open(dir.path()).expect("reopen");
        assert_eq!(reopened.root(), store.root());

        fs::write(store.root().join(VERSION_FILE), "xh-checkpoint-store/999\n")
            .expect("corrupt version");
        assert!(matches!(
            Store::open(dir.path()),
            Err(StoreError::VersionMismatch { .. })
        ));
    }

    #[test]
    fn open_rejects_missing_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(matches!(
            Store::open(dir.path()),
            Err(StoreError::VersionMissing { .. })
        ));
    }

    #[test]
    fn root_id_dir_escapes_unsafe_values() {
        assert_eq!(root_id_dir("workspace-1.local"), "workspace-1.local");
        assert_eq!(root_id_dir(".."), {
            let digest = format!("{:x}", Sha256::digest(b".."));
            format!("h-{}", &digest[..16])
        });
        assert_eq!(root_id_dir("."), {
            let digest = format!("{:x}", Sha256::digest(b"."));
            format!("h-{}", &digest[..16])
        });
        let long = "a".repeat(65);
        let expected = {
            let digest = format!("{:x}", Sha256::digest(long.as_bytes()));
            format!("h-{}", &digest[..16])
        };
        assert_eq!(root_id_dir(&long), expected);
        assert!(root_id_dir("root id with spaces").starts_with("h-"));
    }

    #[test]
    fn sharded_paths_match_layout() {
        let (_dir, store) = test_store();
        let hash = format!("{:064x}", 0xabu8);
        let blob = store.blob_path(&hash);
        assert!(
            blob.ends_with(
                Path::new("objects")
                    .join(&hash[0..2])
                    .join(&hash[2..4])
                    .join(&hash)
            )
        );
        let manifest = store.manifest_path(&hash);
        assert!(
            manifest.ends_with(
                Path::new("manifests")
                    .join(&hash[0..2])
                    .join(&hash[2..4])
                    .join(format!("{hash}.json"))
            )
        );
        assert!(
            store
                .slice_dir("ws-1")
                .ends_with(Path::new("slices").join("ws-1"))
        );
        assert!(
            store
                .stat_cache_path("ws-1")
                .ends_with(Path::new("index").join("stat").join("ws-1.json"))
        );
    }

    #[test]
    fn second_lock_in_same_process_is_busy() {
        let (_dir, store) = test_store();
        let first = store.lock().expect("first lock");
        assert!(matches!(
            StoreLock::acquire(&store),
            Err(StoreError::Busy { .. })
        ));
        drop(first);
        assert!(StoreLock::acquire(&store).is_ok());
    }

    #[test]
    fn lock_owner_staleness_handles_pid_reuse() {
        let owner = LockOwner {
            pid: std::process::id(),
            created_at_ms: 100,
            process_start_token: Some(111),
        };
        assert!(!owner.looks_stale(Some(111)), "same process is live");
        assert!(owner.looks_stale(Some(222)), "PID reused by newer process");
        assert!(owner.looks_stale(None), "process vanished");
        let unknown = LockOwner {
            pid: 1,
            created_at_ms: 100,
            process_start_token: None,
        };
        assert!(unknown.looks_stale(Some(111)));
    }

    #[test]
    fn stale_lock_file_is_reported_and_reacquired() {
        let (_dir, store) = test_store();
        let stale = LockOwner {
            // A PID that is not this test process. The OS lock is free because
            // no process holds it, which is exactly the crash-recovery shape.
            pid: u32::MAX,
            created_at_ms: 1,
            process_start_token: Some(0xdead_beef),
        };
        fs::write(
            store.lock_path(),
            serde_json::to_vec(&stale).expect("encode stale owner"),
        )
        .expect("write stale lock");

        let owner = store.lock_owner().expect("read owner").expect("owner");
        assert!(owner.looks_stale(process_start_token(owner.pid)));
        assert!(StoreLock::acquire(&store).is_ok());
        let refreshed = store.lock_owner().expect("read owner").expect("owner");
        assert_eq!(refreshed.pid, std::process::id());
    }

    /// Child process entry used by the crash-release test below. It is
    /// `#[ignore]` so the normal suite never runs it; the parent invokes this
    /// exact test in a child process with `--ignored`.
    #[test]
    #[ignore = "helper for lock_is_released_when_holder_process_dies"]
    fn lock_holder_helper() {
        let store_root = std::env::var("XIHE_CHECKPOINT_LOCK_STORE").expect("store env");
        let ready = std::env::var("XIHE_CHECKPOINT_LOCK_READY").expect("ready env");
        let store = Store::open(store_root).expect("open store");
        let _lock = store.lock().expect("acquire lock");
        fs::write(ready, b"ready").expect("ready file");
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn lock_is_released_when_holder_process_dies() {
        let (dir, store) = test_store();
        let ready = dir.path().join("lock-holder-ready");
        let exe = std::env::current_exe().expect("current exe");
        let mut child = Command::new(exe)
            .args([
                "--exact",
                "checkpoint_store::store::tests::lock_holder_helper",
                "--ignored",
                "--nocapture",
            ])
            .env("XIHE_CHECKPOINT_LOCK_STORE", store.root())
            .env("XIHE_CHECKPOINT_LOCK_READY", &ready)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn lock holder");

        let ready_deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() && Instant::now() < ready_deadline {
            if let Some(status) = child.try_wait().expect("try_wait holder") {
                panic!("lock holder exited before ready: {status}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ready.exists(), "lock holder did not signal ready");

        let busy = StoreLock::acquire(&store).expect_err("second process must be busy");
        assert!(matches!(busy, StoreError::Busy { .. }));

        child.kill().expect("kill lock holder");
        child.wait().expect("wait for killed holder");

        // OS releases the lock on process death. Retry briefly for Windows
        // teardown; the leftover `lock` file itself must not block.
        let release_deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match StoreLock::acquire(&store) {
                Ok(lock) => {
                    drop(lock);
                    break;
                }
                Err(StoreError::Busy { .. }) if Instant::now() < release_deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(other) => panic!("lock was not released after crash: {other}"),
            }
        }
        let owner = store.lock_owner().expect("read owner").expect("owner");
        assert_eq!(owner.pid, std::process::id());
    }
}
