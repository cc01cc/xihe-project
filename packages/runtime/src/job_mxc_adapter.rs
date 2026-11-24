//! MXC job adapter (PLAN-0394).
//!
//! Translates a route-level request into a PLAN-0393 `LaunchPlan` whose
//! `program` is `wxc-exec.exe` and whose only argument is a Runtime-generated
//! policy artifact. The engine owns the process; this module only assembles
//! the policy (decision #3/#5) and never leaks the artifact path upward.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
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
    build_mxc_job_with_roots(request, &[], job_output_dir)
}

/// task-979: build the MXC job policy with **every** declared root granted.
///
/// `roots` is the ordered `(rootId, hostPath)` declaration from the
/// ExecutionSpec. MXC's own policy already accepts many read/write roots
/// (`MxcPolicyRequest::read_write_roots: Vec<PathBuf>`); this function is the
/// adapter-side wiring that turns that capability into per-root grants.
pub fn build_mxc_job_with_roots(
    request: MxcJobRequest,
    roots: &[(String, String)],
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
    let mut args = request.args;
    let granted_roots = mxc_granted_roots(&workspace, roots);
    let mut worker_parents = BTreeSet::new();
    for root in &granted_roots {
        if let Some(parent) = root.parent() {
            worker_parents.insert(parent.to_path_buf());
        }
    }
    if file_worker {
        for (root_id, host_path) in roots {
            args.push("--root".to_string());
            args.push(format!("{root_id}={host_path}"));
        }
    }
    let mut worker_env = request.env;
    if file_worker && worker_env.is_empty() {
        // task-544: the worker identifies itself through its argv
        // (`--file-worker`), so no marker variable is needed. It still gets the
        // allowlisted system variables so the child can initialize on Windows.
        worker_env = crate::process_guard::sandbox_env(&BTreeMap::new());
    }
    let policy = build_mxc_policy(&MxcPolicyRequest {
        program: request.command,
        args,
        cwd: cwd.clone(),
        env: worker_env,
        timeout_ms: request.timeout_secs.saturating_mul(1_000),
        // Rust's canonicalize needs traverse/read access to the workspace's
        // parent on MXC. Keep this extra read grant limited to the fixed
        // file-worker executable; its lexical/canonical checks still reject
        // every caller-supplied path outside WorkspaceStorage.
        read_only_roots: if file_worker {
            worker_parents.into_iter().collect()
        } else {
            Vec::new()
        },
        read_write_roots: granted_roots.clone(),
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
    let policy_path = if policy_path.is_absolute() {
        policy_path
    } else {
        std::env::current_dir()
            .map_err(|error| {
                JobEngineError::Unavailable(format!("Runtime current dir lookup failed: {error}"))
            })?
            .join(policy_path)
    };
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
            read_write_roots: granted_roots,
        },
        policy_artifact: Some(policy_path),
    })
}

/// task-979: the primary root plus every declared root, de-duplicated by path.
fn mxc_granted_roots(workspace: &Path, roots: &[(String, String)]) -> Vec<PathBuf> {
    let mut granted = vec![workspace.to_path_buf()];
    for (_, host_path) in roots {
        let trimmed = host_path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if path.is_absolute() && !granted.contains(&path) {
            granted.push(path);
        }
    }
    granted
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
        let root = PathBuf::from("target/.tmp")
            .join(format!("xihe-mxc-adapter-test-{}", uuid::Uuid::new_v4()));
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
        assert!(policy_path.is_absolute());
        assert!(policy_path.starts_with(std::env::current_dir().unwrap().join(&root)));
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
        std::fs::remove_dir_all(root).expect("remove adapter test output");
    }

    /// task-979: every declared root gets its own read/write grant in one MXC
    /// policy, and the file worker receives the root table it routes by.
    #[test]
    fn multi_root_policy_grants_each_declared_root() {
        let root = PathBuf::from("target/.tmp")
            .join(format!("xihe-mxc-multi-root-test-{}", uuid::Uuid::new_v4()));
        let primary = std::env::temp_dir().join("xihe-mxc-primary");
        let second = std::env::temp_dir().join("xihe-mxc-second");
        let plan = build_mxc_job_with_roots(
            MxcJobRequest {
                workspace_path: primary.to_string_lossy().into_owned(),
                command: "xihe-runtime.exe".to_string(),
                args: vec!["--file-worker".to_string()],
                cwd: None,
                env: BTreeMap::new(),
                timeout_secs: 30,
            },
            &[
                (
                    "ws-primary".to_string(),
                    primary.to_string_lossy().into_owned(),
                ),
                ("root-b".to_string(), second.to_string_lossy().into_owned()),
            ],
            &root,
        )
        .expect("mxc multi-root plan");
        let policy_path = plan.policy_artifact.clone().expect("policy artifact");
        let policy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&policy_path).expect("policy file"))
                .expect("policy json");
        println!(
            "task-979 multi-root policy filesystem: {}",
            policy["filesystem"]
        );
        let granted = policy["filesystem"]["readwritePaths"]
            .as_array()
            .expect("readwritePaths")
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            granted.len(),
            2,
            "each root must be granted once: {granted:?}"
        );
        assert!(granted.iter().any(|path| path.contains("xihe-mxc-second")));
        assert_eq!(plan.grants.read_write_roots.len(), 2);
        let command_line = policy["process"]["commandLine"]
            .as_str()
            .expect("commandLine");
        assert!(command_line.contains("--root"), "{command_line}");
        assert!(
            command_line.contains(&format!("root-b={}", second.to_string_lossy())),
            "{command_line}"
        );
        std::fs::remove_dir_all(root).expect("remove adapter test output");
    }

    /// task-544: a file-worker job must not force the caller-environment merge.
    /// Its environment is the allowlist only, and it identifies itself by argv.
    #[test]
    fn file_worker_policy_env_is_allowlist_only() {
        let root = PathBuf::from("target/.tmp")
            .join(format!("xihe-mxc-worker-test-{}", uuid::Uuid::new_v4()));
        let plan = build_mxc_job(
            MxcJobRequest {
                workspace_path: std::env::temp_dir().to_string_lossy().into_owned(),
                command: "xihe-runtime.exe".to_string(),
                args: vec!["--file-worker".to_string(), "--workspace".to_string()],
                cwd: None,
                env: BTreeMap::new(),
                timeout_secs: 30,
            },
            &root,
        )
        .expect("mxc file-worker plan");
        let policy_path = plan.policy_artifact.clone().expect("policy artifact");
        let policy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&policy_path).expect("policy file"))
                .expect("policy json");
        let names = policy["process"]["env"]
            .as_array()
            .expect("file worker must still get the allowlisted system variables")
            .iter()
            .map(|entry| {
                let rendered = entry.as_str().unwrap_or_default();
                rendered
                    .split_once('=')
                    .map(|(key, _)| key.to_string())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        assert!(
            !names.iter().any(|name| name == "XIHE_FILE_WORKER"),
            "the file-worker marker must be gone: {names:?}"
        );
        let unexpected = names
            .iter()
            .filter(|name| !crate::process_guard::SANDBOX_ENV_ALLOWLIST.contains(&name.as_str()))
            .collect::<Vec<_>>();
        assert!(
            unexpected.is_empty(),
            "file worker env must be allowlist-only: {unexpected:?}"
        );
        println!("task-552 file-worker policy env names: {names:?}");
        std::fs::remove_dir_all(root).expect("remove worker test output");
    }
}
