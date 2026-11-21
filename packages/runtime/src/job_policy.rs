//! Host job policy artifact: construction, parsing and enforcement (task-204 / DSD-1525 A1).
//!
//! # Why this module exists
//!
//! "windows-host" used to ship "policy_artifact: None" from the adapter, and the
//! engine never parsed an artifact anyway -- the only effective host check was
//! "validate_cwd". This module closes that gap in three steps:
//!
//! 1. the adapter **writes** a host-policy.json artifact into the job output
//!    directory and puts its absolute path on the plan (never None again);
//! 2. the engine **reads it back** before spawning and fails closed with
//!    [JobEngineError::PolicyDenied] when it is missing, malformed or the plan
//!    disagrees with it;
//! 3. the child environment stops inheriting the whole parent environment: only
//!    the system keys in [INHERITED_ENV_KEYS] plus the artifact-sanctioned
//!    "plan.env" keys reach the process.
//!
//! # What this module is **not**
//!
//! - Not an isolation boundary: "windows-host" still runs on the host with the
//!   user's privileges. The artifact records what was authorized; it does not
//!   confine the process (that is what MXC/Docker backends are for).
//! - Not the cross-protocol contract: POLICY_DENIED is a Runtime-internal code
//!   and is only surfaced in the job failure detail (A2 will decide whether CP
//!   learns a first-class code).
//! - Not the real data source for program_whitelist / env_allowlist: CP does not
//!   send them yet (A2). Today the adapter writes an **empty** program whitelist
//!   (= no program-level restriction, deliberate) and the allowlist of the env
//!   keys CP itself passed in the request.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::job_engine::{JobEngineError, LaunchPlan};
use crate::plugin::spec::INHERITED_ENV_KEYS;

/// File name of the artifact inside the job output directory.
pub const HOST_POLICY_FILE: &str = "host-policy.json";

/// "backend_kind" this module enforces. Every other backend keeps its own
/// artifact handling ("windows-mxc" writes policy.json and wxc-exec reads it).
pub const HOST_BACKEND_KIND: &str = "windows-host";

/// The policy the host backend promises to itself, serialized as the artifact.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostJobPolicy {
    /// Writable roots granted to the job (same roots the engine validates "cwd" against).
    #[serde(default)]
    pub read_write_roots: Vec<PathBuf>,
    /// Programs the job may start. **Empty means "no program-level restriction"**
    /// (the documented semantics of the empty whitelist), and the adapter emits
    /// an audit line recording that fact.
    #[serde(default)]
    pub program_whitelist: Vec<String>,
    /// Env keys the artifact sanctions. A "plan.env" key outside this list is
    /// rejected by [enforce]; parent-only keys never reach the child at all
    /// because the engine clears the environment before applying [child_env].
    #[serde(default)]
    pub env_allowlist: Vec<String>,
}

impl HostJobPolicy {
    #[must_use]
    pub fn program_whitelist_is_empty(&self) -> bool {
        self.program_whitelist.is_empty()
    }

    /// Empty whitelist means "no program-level restriction" -- the documented
    /// semantics, not an accident. A non-empty list matches the final program
    /// string (case-insensitively) or its file name, so "cmd" also matches
    /// "C:/Windows/System32/cmd.exe".
    #[must_use]
    pub fn allows_program(&self, program: &str) -> bool {
        if self.program_whitelist.is_empty() {
            return true;
        }
        let requested = program.trim().to_ascii_lowercase();
        if requested.is_empty() {
            return false;
        }
        let requested_name = Path::new(&requested)
            .file_name()
            .map(|value| value.to_string_lossy().to_ascii_lowercase());
        self.program_whitelist.iter().any(|allowed| {
            let allowed = allowed.trim().to_ascii_lowercase();
            if allowed.is_empty() {
                return false;
            }
            requested == allowed || requested_name.as_deref() == Some(allowed.as_str())
        })
    }

    #[must_use]
    pub fn allows_env(&self, key: &str) -> bool {
        self.env_allowlist
            .iter()
            .any(|allowed| allowed.trim().eq_ignore_ascii_case(key.trim()))
    }
}

/// Writes the artifact into "job_output_dir" and returns its absolute path.
///
/// Failures are PolicyDenied: the adapter could not produce the policy it is
/// required to produce, which is a policy failure, not an unavailable backend.
pub fn write_artifact(
    policy: &HostJobPolicy,
    job_output_dir: &Path,
) -> Result<PathBuf, JobEngineError> {
    std::fs::create_dir_all(job_output_dir).map_err(|error| {
        JobEngineError::PolicyDenied(format!("host policy output dir creation failed: {error}"))
    })?;
    let policy_path = job_output_dir.join(HOST_POLICY_FILE);
    let bytes = serde_json::to_vec_pretty(policy).map_err(|error| {
        JobEngineError::PolicyDenied(format!("host policy serialization failed: {error}"))
    })?;
    std::fs::write(&policy_path, bytes).map_err(|error| {
        JobEngineError::PolicyDenied(format!("host policy write failed: {error}"))
    })?;
    if policy_path.is_absolute() {
        return Ok(policy_path);
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&policy_path))
        .map_err(|error| {
            JobEngineError::PolicyDenied(format!("runtime current dir lookup failed: {error}"))
        })
}

/// Reads an artifact back. Unreadable or malformed artifacts fail closed.
pub fn parse(path: &Path) -> Result<HostJobPolicy, JobEngineError> {
    let bytes = std::fs::read(path).map_err(|error| {
        JobEngineError::PolicyDenied(format!(
            "host policy artifact is unreadable ({}): {error}",
            path.display()
        ))
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        JobEngineError::PolicyDenied(format!(
            "host policy artifact is malformed ({}): {error}",
            path.display()
        ))
    })
}

/// Enforces the artifact for one launch plan.
///
/// Returns Ok(None) for every non-host backend: "windows-mxc" keeps its own
/// artifact and its inherited environment (see job_engine::start_windows), so
/// enforcing here would be a cross-backend regression, not a hardening.
///
/// Ordering contract (kept so InvalidPath stays the first failure for a bad
/// "cwd", exactly as before this module existed): the engine calls
/// "validate_cwd" first, this function second.
pub fn enforce(plan: &LaunchPlan) -> Result<Option<HostJobPolicy>, JobEngineError> {
    if plan.backend_kind != HOST_BACKEND_KIND {
        return Ok(None);
    }
    let artifact = plan.policy_artifact.as_deref().ok_or_else(|| {
        JobEngineError::PolicyDenied(
            "host job policy artifact missing (the adapter must write one)".to_string(),
        )
    })?;
    let policy = parse(artifact)?;
    if !policy.allows_program(&plan.program) {
        return Err(JobEngineError::PolicyDenied(format!(
            "program not allowed by host policy: {}",
            plan.program
        )));
    }
    for key in plan.env.keys() {
        if !policy.allows_env(key) {
            return Err(JobEngineError::PolicyDenied(format!(
                "env key not allowed by host policy: {key}"
            )));
        }
    }
    if let Some(cwd) = plan.cwd.as_deref()
        && !policy.read_write_roots.is_empty()
        && !is_within_any(cwd, &policy.read_write_roots)
    {
        return Err(JobEngineError::PolicyDenied(format!(
            "cwd {} is outside the host policy roots",
            cwd.display()
        )));
    }
    Ok(Some(policy))
}

/// Environment handed to a "windows-host" child process.
///
/// Parent environment is filtered to [INHERITED_ENV_KEYS] (the same allowlist the
/// plugin runner uses, so the two host-level spawn paths do not drift), then the
/// artifact-sanctioned "plan.env" keys are overlaid. Keys are upper-cased:
/// Windows env vars are case-insensitive and both PATH and Path in the same map
/// makes the winner undefined.
#[must_use]
pub fn child_env(
    policy: &HostJobPolicy,
    plan_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for (key, value) in std::env::vars_os() {
        let Some(name) = key.to_str() else { continue };
        let upper = name.to_ascii_uppercase();
        if !INHERITED_ENV_KEYS.contains(&upper.as_str()) {
            continue;
        }
        let Some(text) = value.to_str() else { continue };
        env.insert(upper, text.to_string());
    }
    for (key, value) in plan_env {
        if policy.allows_env(key) {
            env.insert(key.to_ascii_uppercase(), value.clone());
        }
    }
    env
}

fn is_within_any(candidate: &Path, roots: &[PathBuf]) -> bool {
    let canonical = match std::fs::canonicalize(candidate) {
        Ok(path) => path,
        Err(_) => return false,
    };
    roots.iter().any(|root| match std::fs::canonicalize(root) {
        Ok(root) => canonical.starts_with(&root),
        Err(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_with(artifact: Option<PathBuf>) -> LaunchPlan {
        LaunchPlan {
            backend_kind: HOST_BACKEND_KIND.to_string(),
            backend_revision: "test".to_string(),
            program: "cmd".to_string(),
            args: vec!["/C".to_string(), "exit 0".to_string()],
            cwd: Some(std::env::temp_dir()),
            env: BTreeMap::new(),
            timeout_ms: 1_000,
            shell: false,
            grants: crate::process_guard::FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![std::env::temp_dir()],
            },
            policy_artifact: artifact,
        }
    }

    fn policy(programs: &[&str], env_keys: &[&str]) -> HostJobPolicy {
        HostJobPolicy {
            read_write_roots: vec![std::env::temp_dir()],
            program_whitelist: programs.iter().map(|value| (*value).to_string()).collect(),
            env_allowlist: env_keys.iter().map(|value| (*value).to_string()).collect(),
        }
    }

    #[test]
    fn empty_program_whitelist_does_not_restrict_any_program() {
        let directory = tempfile::tempdir().expect("tempdir");
        let artifact = write_artifact(&policy(&[], &[]), directory.path()).expect("artifact");
        assert!(artifact.is_absolute());
        let plan = plan_with(Some(artifact.clone()));
        let parsed = enforce(&plan).expect("enforce").expect("host policy");
        assert!(parsed.program_whitelist_is_empty());
        assert!(parsed.allows_program("definitely-any-program.exe"));
        let raw = std::fs::read(&artifact).expect("artifact bytes");
        let value: serde_json::Value = serde_json::from_slice(&raw).expect("json");
        assert_eq!(
            value["programWhitelist"].as_array().expect("array").len(),
            0
        );
        assert!(
            !value["readWriteRoots"]
                .as_array()
                .expect("roots")
                .is_empty()
        );
    }

    #[test]
    fn missing_artifact_fails_closed_with_policy_denied() {
        let error = enforce(&plan_with(None)).expect_err("must fail closed");
        assert_eq!(error.code(), "POLICY_DENIED");
        assert_ne!(error.code(), "RUNTIME_UNAVAILABLE");
        assert_ne!(error.code(), "PROCESS_BACKEND_LAUNCH_PENDING");
        assert!(error.reason().contains("artifact missing"));
    }

    #[test]
    fn non_host_backend_is_not_policed_here() {
        let mut plan = plan_with(None);
        plan.backend_kind = "windows-mxc".to_string();
        assert!(enforce(&plan).expect("mxc untouched").is_none());
    }

    #[test]
    fn program_outside_a_non_empty_whitelist_is_denied() {
        let directory = tempfile::tempdir().expect("tempdir");
        let artifact = write_artifact(&policy(&["cmd"], &[]), directory.path()).expect("artifact");
        let plan = plan_with(Some(artifact.clone()));
        enforce(&plan).expect("cmd is allowed");
        let mut blocked = plan_with(Some(artifact));
        blocked.program = "powershell".to_string();
        let error = enforce(&blocked).expect_err("must deny");
        assert_eq!(error.code(), "POLICY_DENIED");
        assert!(error.reason().contains("program not allowed"));
    }

    #[test]
    fn env_key_outside_the_artifact_allowlist_is_denied() {
        let directory = tempfile::tempdir().expect("tempdir");
        let artifact = write_artifact(&policy(&[], &["PATH"]), directory.path()).expect("artifact");
        let mut plan = plan_with(Some(artifact));
        plan.env
            .insert("XIHE_TEST_SECRET".to_string(), "leaked".to_string());
        let error = enforce(&plan).expect_err("must deny");
        assert_eq!(error.code(), "POLICY_DENIED");
        assert!(error.reason().contains("env key not allowed"));
    }

    #[test]
    fn child_env_drops_parent_only_keys_and_keeps_allowlisted_plan_env() {
        let policy = policy(&[], &["PATH", "XIHE_TEST_SECRET"]);
        let mut plan_env = BTreeMap::new();
        plan_env.insert("PATH".to_string(), "C:/sanctioned".to_string());
        plan_env.insert("XIHE_TEST_SECRET".to_string(), "allowed".to_string());
        plan_env.insert("XIHE_NOT_ALLOWED".to_string(), "dropped".to_string());
        let env = child_env(&policy, &plan_env);
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("C:/sanctioned"),
            "allowlisted plan env must win over the inherited PATH"
        );
        assert_eq!(
            env.get("XIHE_TEST_SECRET").map(String::as_str),
            Some("allowed")
        );
        assert!(!env.contains_key("XIHE_NOT_ALLOWED"));
        assert!(!env.contains_key("XIHE_PARENT_ONLY"));
    }

    #[test]
    fn malformed_artifact_fails_closed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join(HOST_POLICY_FILE);
        std::fs::write(&path, b"not json").expect("write");
        let error = enforce(&plan_with(Some(path))).expect_err("must fail closed");
        assert_eq!(error.code(), "POLICY_DENIED");
        assert!(error.reason().contains("malformed"));
    }
}
