use std::path::{Path, PathBuf};

use tokio::fs;

use crate::error::{Result, RuntimeError};

/// Env var for native Runtime state dir (device_id, runtime_id, etc.)
const STATE_DIR_ENV: &str = "XIHE_RUNTIME_STATE_DIR";
/// Default state dir relative to A03-xihe when env not set (Windows dev:host)
const DEFAULT_STATE_DIR: &str = ".xihe-state";

/// Resolve state dir: env `XIHE_RUNTIME_STATE_DIR` or default.
/// If env is relative, resolve relative to current dir (which for `cargo run` is `packages/runtime`, for `mise` is `A03-xihe`).
/// For robustness, if the resolved dir is `packages/runtime/.xihe-state`, we still use it; the file will be created there.
pub fn resolve_state_dir() -> PathBuf {
    if let Ok(dir) = std::env::var(STATE_DIR_ENV) {
        if dir.trim().is_empty() {
            PathBuf::from(DEFAULT_STATE_DIR)
        } else {
            PathBuf::from(dir)
        }
    } else {
        PathBuf::from(DEFAULT_STATE_DIR)
    }
}

/// Ensure `device_id` file exists in `state_dir`, returning the id.
/// - If `device_id` file exists and contains a valid UUID-like string, return it.
/// - Otherwise generate a new v4 UUID, write it atomically, and return it.
/// This is `grill M2-3.1 A` — random UUID file, not hardware-derived.
pub async fn ensure_device_id(state_dir: &Path) -> Result<String> {
    fs::create_dir_all(state_dir).await.map_err(RuntimeError::Io)?;
    let device_id_path = state_dir.join("device_id");
    if device_id_path.exists() {
        let content = fs::read_to_string(&device_id_path)
            .await
            .map_err(RuntimeError::Io)?;
        let trimmed = content.trim().to_string();
        if !trimmed.is_empty() && is_valid_device_id(&trimmed) {
            return Ok(trimmed);
        }
        // If file exists but invalid, fall through to regenerate
        tracing::warn!("device_id file invalid, regenerating: {:?}", trimmed);
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    // Write atomically: write to temp then rename
    let tmp_path = state_dir.join(format!(".device_id.tmp.{}", &new_id[..8]));
    fs::write(&tmp_path, new_id.as_bytes())
        .await
        .map_err(RuntimeError::Io)?;
    // On Windows, rename may fail if target exists; remove first
    if device_id_path.exists() {
        let _ = fs::remove_file(&device_id_path).await;
    }
    fs::rename(&tmp_path, &device_id_path)
        .await
        .map_err(RuntimeError::Io)?;
    tracing::info!("device_id created: {}", new_id);
    Ok(new_id)
}

fn is_valid_device_id(s: &str) -> bool {
    // UUID v4 format: 8-4-4-4-12 hex
    if s.len() != 36 {
        return false;
    }
    // Simple check: parse as uuid
    uuid::Uuid::parse_str(s).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_ensure_device_id_creates_and_reuses() {
        let dir = TempDir::new().unwrap();
        let state_dir = dir.path().join("state");
        let id1 = ensure_device_id(&state_dir).await.unwrap();
        assert_eq!(id1.len(), 36);
        assert!(uuid::Uuid::parse_str(&id1).is_ok());
        // Second call should return same id
        let id2 = ensure_device_id(&state_dir).await.unwrap();
        assert_eq!(id1, id2);
        // File should exist
        assert!(state_dir.join("device_id").exists());
    }

    #[tokio::test]
    async fn test_ensure_device_id_regenerates_invalid() {
        let dir = TempDir::new().unwrap();
        let state_dir = dir.path().join("state2");
        tokio::fs::create_dir_all(&state_dir).await.unwrap();
        tokio::fs::write(state_dir.join("device_id"), b"not-a-uuid").await.unwrap();
        let id = ensure_device_id(&state_dir).await.unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_ne!(id, "not-a-uuid");
    }

    #[test]
    fn test_is_valid_device_id() {
        assert!(is_valid_device_id(&uuid::Uuid::new_v4().to_string()));
        assert!(!is_valid_device_id("not-uuid"));
        assert!(!is_valid_device_id(""));
        assert!(!is_valid_device_id(&"a".repeat(36)));
    }
}
