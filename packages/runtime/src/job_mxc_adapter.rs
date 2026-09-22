//! MXC job adapter (PLAN-0394).
//!
//! Translates a route-level request into a PLAN-0393 `LaunchPlan` whose
//! `program` is `wxc-exec.exe` and whose only argument is a Runtime-generated
//! policy artifact. The engine owns the process; this module only assembles
//! the policy (decision #3/#5) and never leaks the artifact path upward.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::job_engine::{JobEngineError, LaunchPlan};
use crate::process_guard::{FilesystemPolicy, MxcPolicyRequest, build_mxc_policy};

/// Inputs from the job route (`windows-mxc` workspaces).
pub struct MxcJobRequest {
    pub workspace_path: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub timeout_secs: u64,
}

/// Builds the `LaunchPlan` for one MXC job and writes its policy artifact into
/// the job's output directory (removed by cleanup / TTL / startup reap).
pub fn build_mxc_job(
    request: MxcJobRequest,
    job_output_dir: &Path,
) -> Result<LaunchPlan, JobEngineError> {
    let workspace = PathBuf::from(&request.workspace_path);
    let cwd = request
        .cwd
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.clone());
    let executable =
        std::env::var("XIHE_MXC_EXECUTABLE").unwrap_or_else(|_| "wxc-exec.exe".to_string());
    let file_worker = request.args.iter().any(|arg| arg == "--file-worker");
    let file_worker_parent = workspace.parent().map(Path::to_path_buf);
    let mut worker_env = request.env;
    if file_worker {
        worker_env.insert("XIHE_FILE_WORKER".to_string(), "1".to_string());
    }
    let policy = build_mxc_policy(&MxcPolicyRequest {
        program: request.command,
        args: request.args,
        cwd: cwd.clone(),
        env: worker_env,
        timeout_ms: request.timeout_secs.saturating_mul(1_000),
        // Rust's canonicalize needs traverse/read access to the workspace's
        // parent on MXC. Keep this extra read grant limited to the fixed
        // file-worker executable; its lexical/canonical checks still reject
        // every caller-supplied path outside WorkspaceStorage.
        read_only_roots: if file_worker {
            file_worker_parent.into_iter().collect()
        } else {
            Vec::new()
        },
        read_write_roots: vec![workspace.clone()],
    });
    std::fs::create_dir_all(job_output_dir).map_err(|error| {
        JobEngineError::Unavailable(format!("job output dir creation failed: {error}"))
    })?;
    let policy_path = job_output_dir.join("policy.json");
    let bytes = serde_json::to_vec_pretty(&policy).map_err(|error| {
        JobEngineError::Unavailable(format!("MXC policy serialization failed: {error}"))
    })?;
    std::fs::write(&policy_path, bytes).map_err(|error| {
        JobEngineError::Unavailable(format!("MXC policy write failed: {error}"))
    })?;
    Ok(LaunchPlan {
        backend_kind: "windows-mxc".to_string(),
        backend_revision: "builtin".to_string(),
        program: executable,
        args: vec![policy_path.to_string_lossy().into_owned()],
        cwd: Some(cwd),
        env: BTreeMap::new(),
        timeout_ms: request.timeout_secs.saturating_mul(1_000),
        shell: false,
        grants: FilesystemPolicy {
            read_only_roots: Vec::new(),
            read_write_roots: vec![workspace],
        },
        policy_artifact: Some(policy_path),
    })
}

/// 0390-shaped capability for the MXC backend; `canIsolateFilesystem=true` is
/// the only capability difference from the host adapter (decision #15 in
/// PLAN-0393 keeps capability content adapter-owned).
pub fn mxc_capability(
    probe: &crate::process_guard::BackendCapabilitySnapshot,
) -> serde_json::Value {
    serde_json::json!({
        "backendKind": probe.backend_kind,
        "backendRevision": probe.backend_revision,
        "maturity": probe.maturity,
        "executionMode": probe.execution_mode,
        "canStart": true,
        "canCancel": true,
        "canStreamOutput": true,
        "canIsolateFilesystem": true,
        "available": probe.available,
        "unavailableReason": probe.reason,
        "reason": probe.reason,
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_mxc_job_writes_the_policy_into_the_job_output_dir() {
        let root =
            std::env::temp_dir().join(format!("xihe-mxc-adapter-test-{}", uuid::Uuid::new_v4()));
        let plan = build_mxc_job(
            MxcJobRequest {
                workspace_path: std::env::temp_dir().to_string_lossy().into_owned(),
                command: "cmd".to_string(),
                args: vec!["/C".to_string(), "exit 0".to_string()],
                cwd: None,
                env: BTreeMap::new(),
                timeout_secs: 5,
            },
            &root,
        )
        .expect("mxc job plan");
        let policy_path = plan.policy_artifact.clone().expect("policy artifact");
        assert!(policy_path.starts_with(&root));
        assert_eq!(plan.args, vec![policy_path.to_string_lossy().into_owned()]);
        assert_eq!(plan.backend_kind, "windows-mxc");
        assert_eq!(plan.timeout_ms, 5_000);
        let policy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&policy_path).expect("policy file"))
                .expect("policy json");
        assert_eq!(policy["containment"], "processcontainer");
        assert_eq!(policy["process"]["timeout"], 5_000u64);
        assert!(
            policy["filesystem"]["readwritePaths"]
                .as_array()
                .is_some_and(|paths| !paths.is_empty())
        );
    }
}
