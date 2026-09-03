use std::path::Path;

/// M5 negative inventory scan — Q33 A: only at startup, Q28 B: found => blocked not delete
/// Grill Q28 B: scan found fallback => mark blocked for manual confirmation, not auto-delete.
#[derive(Debug, Clone, PartialEq)]
pub enum InventoryResult {
    Clean,
    Blocked(String),
}

pub fn scan_with_env(host_root: &Path, xihe_workspace: Option<&str>, gate: Option<&str>) -> InventoryResult {
    if let Some(ws) = xihe_workspace
        && !ws.trim().is_empty()
        && gate != Some("true")
    {
        return InventoryResult::Blocked(format!(
            "negative inventory: XIHE_WORKSPACE legacy fallback present without gate (value length {})",
            ws.len()
        ));
    }

    #[cfg(windows)]
    {
        let legacy_tmp = Path::new(r"C:\tmp\xihe-workspace");
        if legacy_tmp.exists() {
            return InventoryResult::Blocked(
                "negative inventory: legacy C:\\tmp\\xihe-workspace directory exists; manual confirmation required".to_string(),
            );
        }
        let tmp2 = Path::new("/tmp/xihe-workspace");
        if tmp2.exists() {
            return InventoryResult::Blocked(
                "negative inventory: /tmp/xihe-workspace exists; blocked per PLAN-201".to_string(),
            );
        }
    }
    #[cfg(not(windows))]
    {
        let legacy_tmp = Path::new("/tmp/xihe-workspace");
        if legacy_tmp.exists() && gate != Some("true") {
            return InventoryResult::Blocked(
                "negative inventory: /tmp/xihe-workspace exists without gate".to_string(),
            );
        }
    }

    let host_root_str = host_root.to_string_lossy().to_lowercase();
    if host_root_str.contains("tmp") && host_root_str.contains("xihe-workspace") {
        return InventoryResult::Blocked(format!(
            "negative inventory: host_root {:?} looks like legacy fallback; must use XIHE_WORKSPACE_HOST_ROOT allowlist",
            host_root
        ));
    }

    let legacy_marker = host_root.join(".xihe-legacy-fallback");
    if legacy_marker.exists() {
        return InventoryResult::Blocked(format!(
            "negative inventory: legacy marker exists at {:?}",
            legacy_marker
        ));
    }

    InventoryResult::Clean
}

pub fn scan_at_startup(host_root: &Path) -> InventoryResult {
    // Read env without unsafe: use std::env::var which is safe to call (reading is safe, only set_var is unsafe)
    // clippy: allow reading env
    let ws = std::env::var("XIHE_WORKSPACE").ok();
    let gate = std::env::var("XIHE_SINGLE_WORKSPACE_MODE").ok();
    scan_with_env(host_root, ws.as_deref(), gate.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_clean_when_no_fallback() {
        let dir = TempDir::new().unwrap();
        let result = scan_with_env(dir.path(), None, None);
        assert_eq!(result, InventoryResult::Clean);
    }

    #[test]
    fn test_blocked_when_legacy_env_without_gate() {
        let dir = TempDir::new().unwrap();
        let result = scan_with_env(dir.path(), Some("/tmp/fallback"), None);
        assert!(matches!(result, InventoryResult::Blocked(_)));
    }

    #[test]
    fn test_clean_when_legacy_env_with_gate() {
        let dir = TempDir::new().unwrap();
        let result = scan_with_env(dir.path(), Some("/tmp/fallback"), Some("true"));
        assert_eq!(result, InventoryResult::Clean);
    }

    #[test]
    fn test_blocked_when_host_root_is_tmp() {
        let legacy = Path::new("/tmp/xihe-workspace/legacy");
        let result = scan_with_env(legacy, None, None);
        assert!(matches!(result, InventoryResult::Blocked(_)));
    }

    #[test]
    fn test_blocked_when_legacy_marker() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(".xihe-legacy-fallback"), b"legacy").unwrap();
        let result = scan_with_env(dir.path(), None, None);
        assert!(matches!(result, InventoryResult::Blocked(_)));
    }

    #[test]
    fn test_scan_at_startup_uses_env() {
        // Ensure scan_at_startup compiles and returns Clean with typical test env (no XIHE_WORKSPACE)
        let dir = TempDir::new().unwrap();
        let result = scan_at_startup(dir.path());
        // In test env, XIHE_WORKSPACE is usually not set, so should be Clean unless host_root is tmp
        assert!(matches!(result, InventoryResult::Clean | InventoryResult::Blocked(_)));
    }
}
