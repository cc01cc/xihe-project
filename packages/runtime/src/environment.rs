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
}
