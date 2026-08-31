use serde::{Deserialize, Serialize};

/// Minimal environment snapshots for v1 — grill Q6 C (hybrid) / Q7 A (blocked/degraded) use these.
/// Host snapshot: collected by native Runtime, not from container.
/// Execution snapshot: collected from Workspace Sandbox Container via Docker inspect.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostSnapshot {
    pub os: String,
    pub arch: String,
    pub host_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionSnapshot {
    pub image: String,
    pub profile: String,
}

impl HostSnapshot {
    pub fn collect(host_root: &str) -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            host_root: host_root.to_string(),
        }
    }
}

impl ExecutionSnapshot {
    pub fn collect(image: &str, profile: &str) -> Self {
        Self {
            image: image.to_string(),
            profile: profile.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_redact::redact_text;

    #[test]
    fn test_host_snapshot_collect() {
        let snap = HostSnapshot::collect("H:\\test");
        assert!(!snap.os.is_empty());
        assert!(!snap.arch.is_empty());
        assert_eq!(snap.host_root, "H:\\test");
    }

    #[test]
    fn test_execution_snapshot_collect() {
        let snap = ExecutionSnapshot::collect("xihe/workspace", "coding");
        assert_eq!(snap.image, "xihe/workspace");
        assert_eq!(snap.profile, "coding");
    }

    #[test]
    fn test_snapshot_redaction_minimal() {
        // Q14 A: only token/env/path are redacted; snapshot should not contain token
        let host = HostSnapshot::collect("H:\\test");
        let json = serde_json::to_string(&host).unwrap();
        // Simulate logging with a fake token nearby
        let log_line = format!("snapshot {} with token Bearer abc123", json);
        let redacted = redact_text(&log_line);
        assert!(!redacted.contains("abc123"));
        assert!(redacted.contains("***redacted***"));
        // Snapshot itself should not be redacted (no token inside)
        let snap_redacted = redact_text(&json);
        assert_eq!(snap_redacted, json);
    }
}
