//! Windows host (unrestricted) job adapter (PLAN-0395).
//!
//! Host jobs run the requested program directly: no sandbox, no policy. The
//! adapter only builds the `LaunchPlan` and the capability projection, and
//! keeps the "this is not isolation" marker in one place (decision #2).

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::job_engine::{JobEngineError, LaunchPlan};
use crate::process_guard::{BackendCapabilitySnapshot, FilesystemPolicy};

/// Inputs from the job route (`windows-host` workspaces).
pub struct HostJobRequest {
    pub workspace_path: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub timeout_secs: u64,
}

/// Builds the `LaunchPlan` for one unrestricted host job.
///
/// File grants are path rules for the engine (cwd must resolve inside them);
/// they are **not** an isolation boundary and must not be presented as one.
pub fn build_host_job(request: HostJobRequest) -> Result<LaunchPlan, JobEngineError> {
    if request.command.trim().is_empty() {
        return Err(JobEngineError::Unavailable(
            "host job requires a command".to_string(),
        ));
    }
    let workspace = PathBuf::from(&request.workspace_path);
    let cwd = request
        .cwd
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.clone());
    Ok(LaunchPlan {
        backend_kind: "windows-host".to_string(),
        backend_revision: "builtin".to_string(),
        program: request.command,
        args: request.args,
        cwd: Some(cwd),
        env: request.env,
        timeout_ms: request.timeout_secs.saturating_mul(1_000),
        shell: false,
        grants: FilesystemPolicy {
            read_only_roots: Vec::new(),
            read_write_roots: vec![workspace],
        },
        policy_artifact: None,
    })
}

/// 0390-shaped capability for the unrestricted host backend. The
/// `canIsolateFilesystem=false` marker is the machine-readable half of the
/// "unrestricted" label CP/UI must surface (decision #2).
pub fn host_capability(probe: &BackendCapabilitySnapshot) -> serde_json::Value {
    serde_json::json!({
        "backendKind": probe.backend_kind,
        "backendRevision": probe.backend_revision,
        "maturity": probe.maturity,
        "executionMode": probe.execution_mode,
        "canStart": true,
        "canCancel": true,
        "canStreamOutput": true,
        "canIsolateFilesystem": false,
        "available": probe.available,
        "unavailableReason": probe.reason,
        "reason": probe.reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_guard::BackendCapabilitySnapshot;

    fn probe() -> BackendCapabilitySnapshot {
        BackendCapabilitySnapshot::unavailable(
            "windows-host",
            "builtin",
            "stable",
            "windows-host",
            "NOT_PROBED",
            None,
        )
    }

    #[test]
    fn host_job_plan_defaults_cwd_to_the_workspace() {
        let workspace = std::env::temp_dir().to_string_lossy().into_owned();
        let plan = build_host_job(HostJobRequest {
            workspace_path: workspace.clone(),
            command: "cmd".to_string(),
            args: vec!["/C".to_string(), "exit 0".to_string()],
            cwd: None,
            env: BTreeMap::new(),
            timeout_secs: 7,
        })
        .expect("host plan");
        assert_eq!(plan.backend_kind, "windows-host");
        assert_eq!(plan.timeout_ms, 7_000);
        assert_eq!(
            plan.cwd.as_deref(),
            Some(PathBuf::from(&workspace)).as_deref()
        );
        assert!(plan.policy_artifact.is_none());
        assert_eq!(plan.grants.read_write_roots.len(), 1);
    }

    #[test]
    fn host_job_rejects_an_empty_command() {
        assert!(matches!(
            build_host_job(HostJobRequest {
                workspace_path: std::env::temp_dir().to_string_lossy().into_owned(),
                command: "  ".to_string(),
                args: Vec::new(),
                cwd: None,
                env: BTreeMap::new(),
                timeout_secs: 0,
            }),
            Err(JobEngineError::Unavailable(_))
        ));
    }

    #[test]
    fn host_capability_marks_no_filesystem_isolation() {
        let capability = host_capability(&probe());
        assert_eq!(capability["canIsolateFilesystem"], false);
        assert_eq!(capability["canStart"], true);
        assert_eq!(capability["canCancel"], true);
        assert_eq!(capability["canStreamOutput"], true);
        assert_eq!(capability["maturity"], "stable");
        assert_eq!(capability["unavailableReason"], "NOT_PROBED");
        assert_eq!(capability["reason"], "NOT_PROBED");
    }
}
