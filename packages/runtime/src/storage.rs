use std::path::{Path, PathBuf};

use regex::Regex;
use tokio::fs;

use crate::error::{Result, RuntimeError};

/// Strict storageRef pattern: grill B1 A — only alphanumeric, underscore, hyphen, 1..64
static STORAGE_REF_RE: &str = r"^[a-zA-Z0-9_-]{1,64}$";

fn storage_ref_regex() -> Regex {
    // Compiled once per call is cheap (<1ms) and keeps storage.rs self-contained.
    // For hot path, caller could cache, but resolve_host_path is per-workspace create (rare).
    Regex::new(STORAGE_REF_RE).expect("valid storageRef regex")
}

/// Returns true if `s` matches `^[a-zA-Z0-9_-]{1,64}$`
pub fn is_valid_storage_ref(s: &str) -> bool {
    storage_ref_regex().is_match(s)
}

/// Strip Windows `\\?\` extended-length prefix that `canonicalize` may return.
/// Docker bind parsing fails on `\\?\H:\...:/workspace:rw` ("too many colons"),
/// but `H:\...:/workspace:rw` is correct.
fn strip_unc_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\?\") {
        PathBuf::from(s.trim_start_matches(r"\\?\").to_string())
    } else {
        p
    }
}

/// Resolve `XIHE_WORKSPACE_HOST_ROOT` to an absolute host base.
///
/// The env value is a process-level base directory. A relative value is legacy
/// (manual `cargo run` from `packages/runtime`) and is made absolute once at the
/// process boundary; a blank value is treated as unconfigured.
pub fn host_root_from_env() -> std::result::Result<PathBuf, String> {
    let raw = std::env::var("XIHE_WORKSPACE_HOST_ROOT")
        .map_err(|_| "XIHE_WORKSPACE_HOST_ROOT is not configured".to_string())?;
    absolutize_host_root(&raw)
}

/// Lexically absolutize a configured host root without requiring it to exist.
pub fn absolutize_host_root(raw: &str) -> std::result::Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("XIHE_WORKSPACE_HOST_ROOT is empty".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let absolute = std::path::absolute(path).map_err(|error| {
        format!("XIHE_WORKSPACE_HOST_ROOT {raw:?} could not be absolutized: {error}")
    })?;
    tracing::warn!(
        raw = %raw,
        resolved = %absolute.display(),
        "XIHE_WORKSPACE_HOST_ROOT is relative; resolved against the process working directory"
    );
    Ok(absolute)
}

/// Absolutize an already-parsed host root (used by embedders/tests).
pub fn absolutize_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    match std::path::absolute(path) {
        Ok(absolute) => {
            tracing::warn!(
                raw = %path.display(),
                resolved = %absolute.display(),
                "host root is relative; resolved against the process working directory"
            );
            absolute
        }
        Err(_) => path.to_path_buf(),
    }
}

/// Resolve a Workspace's roots to validated host directories (PLAN-0502 seam B).
///
/// The single-root model yields exactly one entry; the collection shape keeps
/// multi-root additive. Fails if any root fails validation.
pub async fn resolve_hosts(host_root: &str, roots: &[String], ws_id: &str) -> Result<Vec<PathBuf>> {
    if roots.is_empty() {
        return Err(RuntimeError::InvalidPath("workspace has no roots".into()));
    }
    let mut resolved = Vec::with_capacity(roots.len());
    for storage_ref in roots {
        resolved.push(resolve_one(host_root, storage_ref, ws_id).await?);
    }
    Ok(resolved)
}

/// Single-root convenience wrapper over [`resolve_hosts`].
pub async fn resolve_host_path(host_root: &str, storage_ref: &str, ws_id: &str) -> Result<PathBuf> {
    let mut hosts = resolve_hosts(host_root, &[storage_ref.to_string()], ws_id).await?;
    Ok(hosts.remove(0))
}

/// Resolve `hostRoot + storageRef` to one validated host directory.
///
/// Validation per grill B1/B2/B6:
/// - B1: strict regex, length, no NUL/colon/slash already covered by regex
/// - Ownership: `ws_id == storageRef` (per M1a 2.1a) — kept this round to hold
///   zero behavior change; multi-root decoupling is deferred to BL-94
/// - B2: Windows canonicalize + lowercase prefix check (requires hostRoot exists;
///   if joined path not yet exists, canonicalize its parent)
/// - Returns `STORAGE_BINDING_INVALID` (InvalidPath/PathTraversal/SymlinkEscape) on failure
async fn resolve_one(host_root: &str, storage_ref: &str, ws_id: &str) -> Result<PathBuf> {
    // B1: strict regex
    if !is_valid_storage_ref(storage_ref) {
        return Err(RuntimeError::InvalidPath(format!(
            "invalid storageRef {storage_ref:?}: must match {STORAGE_REF_RE}"
        )));
    }
    if storage_ref.contains('\0') {
        return Err(RuntimeError::InvalidPath(format!(
            "storageRef contains NUL: {storage_ref:?}"
        )));
    }
    // Ownership: workspaceId must equal storageRef (prevents cross-workspace write)
    if ws_id != storage_ref {
        return Err(RuntimeError::InvalidPath(format!(
            "workspaceId {ws_id:?} != storageRef {storage_ref:?}: ownership mismatch"
        )));
    }

    let host_root_path = Path::new(host_root);
    if host_root.is_empty() {
        return Err(RuntimeError::InvalidPath("hostRoot is empty".into()));
    }

    // hostRoot must exist for canonicalize; if not, try to create it (first-run).
    // For M1a pure-logic tests, we ensure TempDir hostRoot already exists.
    if !host_root_path.exists() {
        fs::create_dir_all(host_root_path)
            .await
            .map_err(RuntimeError::Io)?;
    }

    let host_root_canonical = strip_unc_prefix(host_root_path.canonicalize().map_err(|e| {
        RuntimeError::InvalidPath(format!("hostRoot canonicalize failed {host_root:?}: {e}"))
    })?);

    // Join (lexically) — regex already guarantees no traversal, but we still canonical-check.
    let joined = host_root_path.join(storage_ref);

    // If joined exists, canonicalize it; otherwise canonicalize its first existing ancestor (hostRoot) and append remaining.
    let joined_canonical = if joined.exists() {
        strip_unc_prefix(joined.canonicalize().map_err(|e| {
            RuntimeError::InvalidPath(format!(
                "joined canonicalize failed {:?}: {}",
                joined.display(),
                e
            ))
        })?)
    } else {
        // Parent (hostRoot) is guaranteed to exist after above; canonicalize parent + push child name lexically then check.
        // We still need to ensure no symlink escape via parent: hostRoot_canonical is already canonical.
        // For non-existing child, the canonical of parent + child name is parent_canonical + child.
        host_root_canonical.join(storage_ref)
    };

    // B2: prefix check — Windows is case-insensitive, so lowercase both.
    // Use filesystem canonical forms for symlink/junction resolution.
    let host_lower = host_root_canonical.to_string_lossy().to_lowercase();
    let joined_lower = joined_canonical.to_string_lossy().to_lowercase();

    // Ensure joined is exactly hostRoot or hostRoot + separator + storageRef.
    // starts_with on Path would be case-sensitive on Windows, so use lowercased string.
    if joined_lower != host_lower
        && !joined_lower.starts_with(&format!("{host_lower}/"))
        && !joined_lower.starts_with(&format!("{}\\{}", host_lower, ""))
    // host_lower already ends without sep; handle both
    {
        // More robust: check Path starts_with on canonical Paths (which are already case-preserving but we lowercased).
        // Fall back to Path check as well.
        if !joined_canonical.starts_with(&host_root_canonical) {
            return Err(RuntimeError::SymlinkEscape {
                path: joined.display().to_string(),
                resolved: joined_canonical.display().to_string(),
            });
        }
        // If Path check passed but lowercased string check failed due to separator, still allow.
        // The Path check is authoritative for symlink.
    }

    // Additional check via Path::starts_with on canonical paths (handles symlink).
    if !joined_canonical.starts_with(&host_root_canonical) {
        return Err(RuntimeError::SymlinkEscape {
            path: joined.display().to_string(),
            resolved: joined_canonical.display().to_string(),
        });
    }

    // Also ensure the final canonical is not outside via .. after symlink resolution (already covered by starts_with).

    Ok(joined_canonical)
}

/// Sync collection variant of [`resolve_hosts`] (tests).
pub fn resolve_hosts_sync(host_root: &str, roots: &[String], ws_id: &str) -> Result<Vec<PathBuf>> {
    if roots.is_empty() {
        return Err(RuntimeError::InvalidPath("workspace has no roots".into()));
    }
    let mut resolved = Vec::with_capacity(roots.len());
    for storage_ref in roots {
        resolved.push(resolve_one_sync(host_root, storage_ref, ws_id)?);
    }
    Ok(resolved)
}

// Sync variant for tests where async not needed and hostRoot is already a TempDir (exists).
pub fn resolve_host_path_sync(host_root: &str, storage_ref: &str, ws_id: &str) -> Result<PathBuf> {
    let mut hosts = resolve_hosts_sync(host_root, &[storage_ref.to_string()], ws_id)?;
    Ok(hosts.remove(0))
}

fn resolve_one_sync(host_root: &str, storage_ref: &str, ws_id: &str) -> Result<PathBuf> {
    if !is_valid_storage_ref(storage_ref) {
        return Err(RuntimeError::InvalidPath(format!(
            "invalid storageRef {storage_ref:?}: must match {STORAGE_REF_RE}"
        )));
    }
    if ws_id != storage_ref {
        return Err(RuntimeError::InvalidPath(format!(
            "workspaceId {ws_id:?} != storageRef {storage_ref:?}: ownership mismatch"
        )));
    }
    let host_root_path = Path::new(host_root);
    let host_root_canonical = strip_unc_prefix(host_root_path.canonicalize().map_err(|e| {
        RuntimeError::InvalidPath(format!("hostRoot canonicalize failed {host_root:?}: {e}"))
    })?);
    let joined = host_root_path.join(storage_ref);
    let joined_canonical = if joined.exists() {
        strip_unc_prefix(joined.canonicalize().map_err(|e| {
            RuntimeError::InvalidPath(format!(
                "joined canonicalize failed {:?}: {}",
                joined.display(),
                e
            ))
        })?)
    } else {
        host_root_canonical.join(storage_ref)
    };
    let host_lower = host_root_canonical.to_string_lossy().to_lowercase();
    let joined_lower = joined_canonical.to_string_lossy().to_lowercase();
    let within_root = joined_lower == host_lower
        || joined_lower.starts_with(&format!("{host_lower}/"))
        || joined_lower.starts_with(&format!("{host_lower}\\"));
    if !within_root {
        return Err(RuntimeError::SymlinkEscape {
            path: joined.display().to_string(),
            resolved: joined_canonical.display().to_string(),
        });
    }
    Ok(joined_canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_valid_storage_ref() {
        assert!(is_valid_storage_ref("ws_abc123"));
        assert!(is_valid_storage_ref("a"));
        assert!(is_valid_storage_ref("A-Z_0"));
        assert!(!is_valid_storage_ref(""));
        assert!(!is_valid_storage_ref(&"a".repeat(65)));
        assert!(!is_valid_storage_ref("has/slash"));
        assert!(!is_valid_storage_ref("has\\back"));
        assert!(!is_valid_storage_ref("has:colon"));
        assert!(!is_valid_storage_ref("has.dot"));
        assert!(!is_valid_storage_ref("../etc"));
        assert!(!is_valid_storage_ref("a\0b"));
    }

    #[test]
    fn test_resolve_hosts_collection_shape() {
        let dir = TempDir::new().unwrap();
        let host_root = dir.path().to_str().unwrap();
        let hosts =
            resolve_hosts_sync(host_root, &["ws_valid123".to_string()], "ws_valid123").unwrap();
        assert_eq!(hosts.len(), 1, "single-root model yields exactly one host");
        let single = resolve_host_path_sync(host_root, "ws_valid123", "ws_valid123").unwrap();
        assert_eq!(hosts[0], single, "wrapper matches the collection element");
        assert!(
            resolve_hosts_sync(host_root, &[], "ws_valid123").is_err(),
            "no roots rejected"
        );
    }

    #[test]
    fn test_traversal_rejected() {
        let dir = TempDir::new().unwrap();
        let host_root = dir.path().to_str().unwrap();
        // Regex already rejects these, so they hit InvalidPath before canonical.
        for bad in ["../etc", "..", "a/b", "a\\b", "a:b", "a.dot"] {
            let r = resolve_host_path_sync(host_root, bad, bad);
            assert!(r.is_err(), "should reject {bad:?}");
            let msg = r.unwrap_err().to_string();
            assert!(
                msg.contains("invalid storageRef") || msg.contains("Invalid path"),
                "{}",
                msg
            );
        }
    }

    #[test]
    fn test_ownership_mismatch_rejected() {
        let dir = TempDir::new().unwrap();
        let host_root = dir.path().to_str().unwrap();
        let r = resolve_host_path_sync(host_root, "ws_abc", "ws_other");
        assert!(r.is_err());
        assert!(r.unwrap_err().to_string().contains("ownership"));
    }

    #[test]
    fn test_valid_ok() {
        let dir = TempDir::new().unwrap();
        let host_root = dir.path().to_str().unwrap();
        let r = resolve_host_path_sync(host_root, "ws_valid123", "ws_valid123").unwrap();
        let expected = strip_unc_prefix(dir.path().canonicalize().unwrap()).join("ws_valid123");
        assert_eq!(r, expected);
    }

    #[test]
    fn test_case_bypass_still_ok_with_lowercase_check() {
        // On Windows, storageRef case should still resolve inside hostRoot; our lowercased check ensures no bypass.
        let dir = TempDir::new().unwrap();
        let host_root = dir.path().to_str().unwrap();
        // Use same wsId/storageRef but different case for hostRoot string case variation — should still succeed because canonical lowercases.
        let r = resolve_host_path_sync(host_root, "WS_CASE", "WS_CASE").unwrap();
        assert!(r.ends_with("WS_CASE"));
    }

    #[test]
    fn test_absolute_rejected() {
        let dir = TempDir::new().unwrap();
        let host_root = dir.path().to_str().unwrap();
        for bad in ["/etc/passwd", "C:\\Windows"] {
            let r = resolve_host_path_sync(host_root, bad, bad);
            assert!(r.is_err(), "should reject absolute {bad:?}");
        }
    }

    #[tokio::test]
    async fn test_symlink_escape_rejected() {
        // Create a symlink inside hostRoot pointing outside, then try to use it via canonical.
        // On Windows, creating symlink may require privileges; if fails, skip test.
        let dir = TempDir::new().unwrap();
        let host_root = dir.path();
        let outside = TempDir::new().unwrap();
        let outside_path = outside.path().join("outside_secret");
        std::fs::create_dir_all(&outside_path).unwrap();

        let link_path = host_root.join("link_escape");
        #[cfg(windows)]
        let sym_res = std::os::windows::fs::symlink_dir(&outside_path, &link_path);
        #[cfg(not(windows))]
        let sym_res = std::os::unix::fs::symlink(&outside_path, &link_path);

        if sym_res.is_err() {
            println!("symlink creation not permitted, skipping test: {sym_res:?}");
            return;
        }

        // Now storageRef "link_escape" itself is valid regex, but if we later try to use it as path,
        // the canonical of hostRoot/link_escape will be outside hostRoot, so our check would catch
        // if we were to resolve a path that goes through the symlink. However our current resolve
        // only joins hostRoot + storageRef, where storageRef is "link_escape" — the joined path is
        // hostRoot/link_escape which canonicalizes to outside, so starts_with check should fail.
        let host_root_str = host_root.to_str().unwrap();
        let r = resolve_host_path_sync(host_root_str, "link_escape", "link_escape");
        // This should be considered SymlinkEscape because link_escape canonical is outside.
        // Our current logic joins hostRoot/link_escape and for non-existing child we use hostRoot_canonical+child
        // which doesn't yet resolve symlink of child (since child is the symlink itself, it exists).
        // If the child exists and is a symlink, the exists() branch will canonicalize it and detect escape.
        assert!(r.is_err(), "symlink escape should be rejected, got {r:?}");
        let msg = r.unwrap_err().to_string();
        assert!(
            msg.contains("Symlink") || msg.contains("outside"),
            "{}",
            msg
        );
    }
}
