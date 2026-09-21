//! PLAN-0379 v1 process backend contract and Windows capability probing.
//!
//! The probe is deliberately separate from process launch. Every launch repeats
//! the probe so a stale CP preflight cannot bypass Runtime's fail-closed gate.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{Result, RuntimeError};

pub const CONTRACT_VERSION: &str = "v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformDiagnostics {
    pub runtime_os: String,
    pub runtime_arch: String,
    pub execution_os: String,
    pub execution_arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackendDiagnostics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<PlatformDiagnostics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackendCapabilitySnapshot {
    pub contract_version: String,
    pub backend_kind: String,
    pub backend_revision: String,
    pub maturity: String,
    pub execution_mode: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<BackendDiagnostics>,
}

impl BackendCapabilitySnapshot {
    pub fn available(
        backend_kind: impl Into<String>,
        backend_revision: impl Into<String>,
        maturity: impl Into<String>,
        execution_mode: impl Into<String>,
        diagnostics: Option<BackendDiagnostics>,
    ) -> Self {
        Self {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: backend_kind.into(),
            backend_revision: backend_revision.into(),
            maturity: maturity.into(),
            execution_mode: execution_mode.into(),
            available: true,
            reason: None,
            diagnostics,
        }
    }

    pub fn unavailable(
        backend_kind: impl Into<String>,
        backend_revision: impl Into<String>,
        maturity: impl Into<String>,
        execution_mode: impl Into<String>,
        reason: impl Into<String>,
        diagnostics: Option<BackendDiagnostics>,
    ) -> Self {
        Self {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: backend_kind.into(),
            backend_revision: backend_revision.into(),
            maturity: maturity.into(),
            execution_mode: execution_mode.into(),
            available: false,
            reason: Some(reason.into()),
            diagnostics,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectAttachProbeRequest {
    pub storage_mode: String,
    pub host_path: String,
    pub execution_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRequest {
    #[serde(default = "default_contract_version")]
    pub contract_version: String,
    #[serde(default)]
    pub backend_kind: Option<String>,
    #[serde(default)]
    pub backend_revision: Option<String>,
    pub execution_mode: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub filesystem: FilesystemPolicy,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub shell: bool,
    /// Authorized stdout/stderr cap per stream; `None` uses
    /// [`DEFAULT_OUTPUT_CAP_BYTES`]. Output is always bounded.
    #[serde(default)]
    pub output_limit_bytes: Option<u64>,
}

fn default_contract_version() -> String {
    CONTRACT_VERSION.to_string()
}

fn default_timeout_ms() -> u64 {
    30_000
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResult {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    /// The stream hit the capture cap and was truncated (large-output boundary).
    #[serde(default)]
    pub stdout_truncated: bool,
    #[serde(default)]
    pub stderr_truncated: bool,
}

/// Default per-stream capture cap for one-shot execution when the caller has no
/// authorized output limit (aligned with the container path's 4096-line default
/// order of magnitude).
pub const DEFAULT_OUTPUT_CAP_BYTES: u64 = 262_144;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemPolicy {
    #[serde(default)]
    pub read_only_roots: Vec<PathBuf>,
    #[serde(default)]
    pub read_write_roots: Vec<PathBuf>,
}

fn platform_diagnostics() -> PlatformDiagnostics {
    PlatformDiagnostics {
        runtime_os: std::env::consts::OS.to_string(),
        runtime_arch: std::env::consts::ARCH.to_string(),
        execution_os: std::env::consts::OS.to_string(),
        execution_arch: std::env::consts::ARCH.to_string(),
    }
}

fn diagnostics(engine_version: Option<String>) -> BackendDiagnostics {
    BackendDiagnostics {
        platform: Some(platform_diagnostics()),
        engine_version,
        extra: BTreeMap::new(),
    }
}

fn validate_direct_attach_path(path: &str) -> Result<PathBuf> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(RuntimeError::InvalidPath(
            "hostPath is required for direct_attach".to_string(),
        ));
    }
    let candidate = PathBuf::from(raw);
    if !candidate.is_absolute() {
        return Err(RuntimeError::InvalidPath(
            "hostPath must be an absolute path".to_string(),
        ));
    }
    let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
        RuntimeError::InvalidPath(format!("hostPath is not accessible: {error}"))
    })?;
    if !canonical.is_dir() {
        return Err(RuntimeError::InvalidPath(
            "hostPath must refer to a directory".to_string(),
        ));
    }
    Ok(canonical)
}

pub async fn probe_direct_attach(
    request: DirectAttachProbeRequest,
) -> Result<BackendCapabilitySnapshot> {
    if request.storage_mode != "direct_attach" {
        return Err(RuntimeError::InvalidPath(
            "direct attach probe requires storageMode=direct_attach".to_string(),
        ));
    }
    let _path = validate_direct_attach_path(&request.host_path)?;
    match request.execution_mode.as_str() {
        "windows-host" => probe_windows_host(),
        "windows-mxc" => probe_mxc().await,
        other => Err(RuntimeError::Unsupported {
            capability: "executionMode".to_string(),
            reason: format!("unsupported direct-attach execution mode {other:?}"),
        }),
    }
}

fn probe_windows_host() -> Result<BackendCapabilitySnapshot> {
    #[cfg(not(windows))]
    {
        return Ok(BackendCapabilitySnapshot::unavailable(
            "windows-host",
            "builtin",
            "stable",
            "windows-host",
            "UNSUPPORTED_PLATFORM",
            Some(diagnostics(None)),
        ));
    }

    #[cfg(windows)]
    {
        Ok(BackendCapabilitySnapshot::available(
            "windows-host",
            "builtin",
            "stable",
            "windows-host",
            Some(diagnostics(None)),
        ))
    }
}

pub async fn execute(request: ProcessRequest) -> Result<ProcessResult> {
    if request.contract_version != CONTRACT_VERSION {
        return Err(RuntimeError::Unsupported {
            capability: "process contract".to_string(),
            reason: format!("unsupported contractVersion {:?}", request.contract_version),
        });
    }
    if request.program.trim().is_empty() {
        return Err(RuntimeError::InvalidPath(
            "process program is required".to_string(),
        ));
    }
    if request.timeout_ms == 0 {
        return Err(RuntimeError::ProcessTimeout {
            detail: "process timeout must be greater than zero".to_string(),
        });
    }
    let cwd = request
        .cwd
        .as_ref()
        .ok_or_else(|| RuntimeError::InvalidPath("process cwd is required".to_string()))?;
    if !cwd.is_dir() {
        return Err(RuntimeError::InvalidPath(
            "process cwd must be an existing directory".to_string(),
        ));
    }
    if request.execution_mode == "windows-mxc" && !cwd_within_grants(cwd, &request.filesystem) {
        return Err(RuntimeError::Unsupported {
            capability: "cwd".to_string(),
            reason: "CWD_OUTSIDE_GRANT".to_string(),
        });
    }
    let capability = match request.execution_mode.as_str() {
        "windows-host" => probe_windows_host()?,
        "windows-mxc" => probe_mxc().await?,
        other => {
            return Err(RuntimeError::Unsupported {
                capability: "executionMode".to_string(),
                reason: format!("unsupported process execution mode {other:?}"),
            });
        }
    };
    if !capability.available {
        return Err(RuntimeError::Unsupported {
            capability: capability.backend_kind,
            reason: capability
                .reason
                .unwrap_or_else(|| "CAPABILITY_UNAVAILABLE".to_string()),
        });
    }
    if request
        .backend_kind
        .as_deref()
        .is_some_and(|kind| kind != capability.backend_kind)
    {
        return Err(RuntimeError::Unsupported {
            capability: "backendKind".to_string(),
            reason: "PROCESS_BACKEND_MISMATCH".to_string(),
        });
    }
    match request.execution_mode.as_str() {
        "windows-host" => execute_host(request).await,
        "windows-mxc" => execute_mxc(request).await,
        _ => unreachable!("execution mode was probed above"),
    }
}

fn cwd_within_grants(cwd: &Path, filesystem: &FilesystemPolicy) -> bool {
    let Ok(cwd) = std::fs::canonicalize(cwd) else {
        return false;
    };
    filesystem
        .read_only_roots
        .iter()
        .chain(filesystem.read_write_roots.iter())
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| {
            let cwd = cwd.to_string_lossy().to_ascii_lowercase();
            let root = root.to_string_lossy().to_ascii_lowercase();
            cwd == root || cwd.starts_with(&(root + "\\"))
        })
}

async fn execute_host(request: ProcessRequest) -> Result<ProcessResult> {
    #[cfg(not(windows))]
    {
        let _ = request;
        return Err(RuntimeError::Unsupported {
            capability: "windows-host".to_string(),
            reason: "UNSUPPORTED_PLATFORM".to_string(),
        });
    }

    #[cfg(windows)]
    {
        let mut command = tokio::process::Command::new(&request.program);
        command
            .args(&request.args)
            .current_dir(request.cwd.as_ref().expect("validated cwd"))
            .envs(&request.env)
            .kill_on_drop(true);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().map_err(RuntimeError::Io)?;
        let pid = child.id();
        let captured = match capture_capped(
            &mut child,
            request.timeout_ms,
            request.output_limit_bytes,
            "process",
        )
        .await
        {
            Ok(captured) => captured,
            Err(error) => {
                if let Some(pid) = pid
                    && matches!(error, RuntimeError::ProcessTimeout { .. })
                {
                    terminate_process_tree(pid).await?;
                }
                return Err(error);
            }
        };
        Ok(ProcessResult {
            exit_code: captured.exit_code,
            timed_out: false,
            stdout: captured.stdout,
            stderr: captured.stderr,
            stdout_truncated: captured.stdout_truncated,
            stderr_truncated: captured.stderr_truncated,
        })
    }
}

async fn execute_mxc(request: ProcessRequest) -> Result<ProcessResult> {
    #[cfg(not(windows))]
    {
        let _ = request;
        return Err(RuntimeError::Unsupported {
            capability: "windows-mxc".to_string(),
            reason: "UNSUPPORTED_PLATFORM".to_string(),
        });
    }

    #[cfg(windows)]
    {
        let executable =
            std::env::var("XIHE_MXC_EXECUTABLE").unwrap_or_else(|_| "wxc-exec.exe".to_string());
        let command_line = std::iter::once(request.program.clone())
            .chain(request.args.iter().cloned())
            .map(|part| quote_windows_argument(&part))
            .collect::<Vec<_>>()
            .join(" ");
        let cwd = mxc_path(request.cwd.as_ref().expect("validated cwd"));
        let mut process = serde_json::json!({
            "commandLine": command_line,
            "cwd": cwd,
            "timeout": request.timeout_ms
        });
        if !request.env.is_empty() {
            let mut environment = std::env::vars().collect::<BTreeMap<_, _>>();
            environment.extend(request.env.clone());
            process["env"] = serde_json::json!(
                environment
                    .iter()
                    .map(|(key, value)| format!("{key}={value}"))
                    .collect::<Vec<_>>()
            );
        }
        let config = serde_json::json!({
            "version": "0.8.0-alpha",
            "containment": "processcontainer",
            "process": process,
            "filesystem": {
                "readonlyPaths": request.filesystem.read_only_roots.iter().map(|path| mxc_path(path)).collect::<Vec<_>>(),
                "readwritePaths": request.filesystem.read_write_roots.iter().map(|path| mxc_path(path)).collect::<Vec<_>>()
            }
        });
        let config_path = std::env::temp_dir().join(format!(
            "xihe-mxc-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let config_bytes = serde_json::to_vec(&config)
            .map_err(|error| RuntimeError::Command(format!("serialize MXC policy: {error}")))?;
        tokio::fs::write(&config_path, config_bytes).await?;
        let mut child = tokio::process::Command::new(&executable)
            .arg(&config_path)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(RuntimeError::Io)?;
        let pid = child.id();
        let captured = match capture_capped(
            &mut child,
            request.timeout_ms,
            request.output_limit_bytes,
            "MXC process",
        )
        .await
        {
            Ok(captured) => captured,
            Err(error) => {
                if let Some(pid) = pid
                    && matches!(error, RuntimeError::ProcessTimeout { .. })
                {
                    terminate_process_tree(pid).await?;
                }
                let _ = tokio::fs::remove_file(&config_path).await;
                return Err(error);
            }
        };
        let _ = tokio::fs::remove_file(&config_path).await;
        Ok(ProcessResult {
            exit_code: captured.exit_code,
            timed_out: false,
            stdout: captured.stdout,
            stderr: captured.stderr,
            stdout_truncated: captured.stdout_truncated,
            stderr_truncated: captured.stderr_truncated,
        })
    }
}

struct CappedCapture {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

/// Waits for the child with a deadline while capturing both streams under a
/// per-stream cap; the remainder is drained (never buffered) and flagged.
async fn capture_capped(
    child: &mut tokio::process::Child,
    timeout_ms: u64,
    output_limit_bytes: Option<u64>,
    label: &str,
) -> Result<CappedCapture> {
    let cap = output_limit_bytes
        .unwrap_or(DEFAULT_OUTPUT_CAP_BYTES)
        .max(1024) as usize;
    let stdout_task = child
        .stdout
        .take()
        .map(|stream| tokio::spawn(read_capped(stream, cap)));
    let stderr_task = child
        .stderr
        .take()
        .map(|stream| tokio::spawn(read_capped(stream, cap)));
    let status = tokio::select! {
        result = child.wait() => result.map_err(RuntimeError::Io)?,
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            return Err(RuntimeError::ProcessTimeout {
                detail: format!("{label} exceeded {timeout_ms}ms"),
            });
        }
    };
    let (stdout, stdout_truncated) = match stdout_task {
        Some(task) => task.await.unwrap_or_default(),
        None => (Vec::new(), false),
    };
    let (stderr, stderr_truncated) = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => (Vec::new(), false),
    };
    Ok(CappedCapture {
        exit_code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        stdout_truncated,
        stderr_truncated,
    })
}

/// Reads up to `cap` bytes, then keeps draining so the child never blocks.
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    cap: usize,
) -> (Vec<u8>, bool) {
    use tokio::io::AsyncReadExt;

    let mut collected: Vec<u8> = Vec::with_capacity(cap.min(16 * 1024));
    let mut buffer = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let remaining = cap.saturating_sub(collected.len());
                if remaining == 0 {
                    truncated = true;
                    continue;
                }
                let take = read.min(remaining);
                collected.extend_from_slice(&buffer[..take]);
                if take < read || collected.len() >= cap {
                    truncated = true;
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "PLAN-0379: capped capture read failed");
                break;
            }
        }
    }
    (collected, truncated)
}

#[cfg(windows)]
async fn terminate_process_tree(pid: u32) -> Result<()> {
    let output = tokio::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .await
        .map_err(RuntimeError::Io)?;
    if !output.status.success()
        && !String::from_utf8_lossy(&output.stderr)
            .to_ascii_lowercase()
            .contains("not found")
    {
        return Err(RuntimeError::ProcessTreeCleanupFailed {
            detail: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(())
}

#[cfg(windows)]
fn mxc_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
}

#[cfg(windows)]
fn quote_windows_argument(value: &str) -> String {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

async fn probe_mxc() -> Result<BackendCapabilitySnapshot> {
    #[cfg(not(windows))]
    {
        return Ok(BackendCapabilitySnapshot::unavailable(
            "windows-mxc",
            "builtin",
            "experimental",
            "windows-mxc",
            "UNSUPPORTED_PLATFORM",
            Some(diagnostics(None)),
        ));
    }

    #[cfg(windows)]
    {
        let executable =
            std::env::var("XIHE_MXC_EXECUTABLE").unwrap_or_else(|_| "wxc-exec.exe".to_string());
        let output = match tokio::time::timeout(
            Duration::from_secs(3),
            tokio::process::Command::new(&executable)
                .arg("--probe")
                .output(),
        )
        .await
        {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                return Ok(BackendCapabilitySnapshot::unavailable(
                    "windows-mxc",
                    "builtin",
                    "experimental",
                    "windows-mxc",
                    format!("SANDBOX_PROBE_FAILED: {error}"),
                    Some(diagnostics(None)),
                ));
            }
            Err(_) => {
                return Ok(BackendCapabilitySnapshot::unavailable(
                    "windows-mxc",
                    "builtin",
                    "experimental",
                    "windows-mxc",
                    "SANDBOX_PROBE_FAILED: probe timed out",
                    Some(diagnostics(None)),
                ));
            }
        };

        if !output.status.success() {
            return Ok(BackendCapabilitySnapshot::unavailable(
                "windows-mxc",
                "builtin",
                "experimental",
                "windows-mxc",
                "SANDBOX_PROBE_FAILED",
                Some(diagnostics(None)),
            ));
        }
        let payload: serde_json::Value = match serde_json::from_slice(&output.stdout) {
            Ok(payload) => payload,
            Err(error) => {
                return Ok(BackendCapabilitySnapshot::unavailable(
                    "windows-mxc",
                    "builtin",
                    "experimental",
                    "windows-mxc",
                    format!("SANDBOX_PROBE_FAILED: invalid probe JSON: {error}"),
                    Some(diagnostics(None)),
                ));
            }
        };
        let engine_version = payload
            .get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        Ok(BackendCapabilitySnapshot::available(
            "windows-mxc",
            "builtin",
            "experimental",
            "windows-mxc",
            Some(diagnostics(engine_version)),
        ))
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::collections::BTreeMap;

    use super::{BackendCapabilitySnapshot, CONTRACT_VERSION, DirectAttachProbeRequest};

    #[test]
    fn capability_contract_has_stable_identity_and_available_reason() {
        let snapshot = BackendCapabilitySnapshot::unavailable(
            "windows-mxc",
            "builtin",
            "experimental",
            "windows-mxc",
            "SANDBOX_PROBE_FAILED",
            None,
        );
        assert_eq!(snapshot.contract_version, CONTRACT_VERSION);
        assert!(!snapshot.available);
        assert_eq!(snapshot.reason.as_deref(), Some("SANDBOX_PROBE_FAILED"));
    }

    #[test]
    fn direct_attach_probe_request_uses_camel_case_wire_fields() {
        let request = serde_json::from_value::<DirectAttachProbeRequest>(serde_json::json!({
            "storageMode": "direct_attach",
            "hostPath": "C:/workspace",
            "executionMode": "windows-host"
        }))
        .expect("probe request");
        assert_eq!(request.storage_mode, "direct_attach");
        assert_eq!(request.execution_mode, "windows-host");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_probe_accepts_an_existing_directory() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let request = DirectAttachProbeRequest {
            storage_mode: "direct_attach".to_string(),
            host_path: directory.path().to_string_lossy().into_owned(),
            execution_mode: "windows-host".to_string(),
        };
        let snapshot = super::probe_direct_attach(request)
            .await
            .expect("host probe");
        assert!(snapshot.available);
        assert_eq!(snapshot.backend_kind, "windows-host");
        assert_eq!(snapshot.execution_mode, "windows-host");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn host_probe_fails_closed_on_non_windows() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let snapshot = super::probe_direct_attach(DirectAttachProbeRequest {
            storage_mode: "direct_attach".to_string(),
            host_path: directory.path().to_string_lossy().into_owned(),
            execution_mode: "windows-host".to_string(),
        })
        .await
        .expect("host probe response");
        assert!(!snapshot.available);
        assert_eq!(snapshot.reason.as_deref(), Some("UNSUPPORTED_PLATFORM"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_execution_captures_process_output() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let result = super::execute(super::ProcessRequest {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: Some("windows-host".to_string()),
            backend_revision: Some("builtin".to_string()),
            execution_mode: "windows-host".to_string(),
            program: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), "echo xihe-process-guard".to_string()],
            cwd: Some(directory.path().to_path_buf()),
            env: BTreeMap::new(),
            filesystem: super::FilesystemPolicy::default(),
            timeout_ms: 5_000,
            shell: false,
            output_limit_bytes: None,
        })
        .await
        .expect("host execution");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("xihe-process-guard"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_timeout_terminates_the_process_tree() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let error = super::execute(super::ProcessRequest {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: Some("windows-host".to_string()),
            backend_revision: Some("builtin".to_string()),
            execution_mode: "windows-host".to_string(),
            program: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), "ping -n 20 127.0.0.1 > nul".to_string()],
            cwd: Some(directory.path().to_path_buf()),
            env: BTreeMap::new(),
            filesystem: super::FilesystemPolicy::default(),
            timeout_ms: 100,
            shell: false,
            output_limit_bytes: None,
        })
        .await
        .expect_err("long-running host process must time out");
        assert!(matches!(error, super::RuntimeError::ProcessTimeout { .. }));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn mxc_execution_captures_process_output() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let executable = std::env::var("XIHE_MXC_EXECUTABLE")
            .expect("XIHE_MXC_EXECUTABLE must point to the installed MXC binary");
        assert!(std::path::Path::new(&executable).is_file());
        let result = super::execute(super::ProcessRequest {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: Some("windows-mxc".to_string()),
            backend_revision: Some("builtin".to_string()),
            execution_mode: "windows-mxc".to_string(),
            program: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), "echo xihe-mxc-process-guard".to_string()],
            cwd: Some(directory.path().to_path_buf()),
            env: BTreeMap::new(),
            filesystem: super::FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![directory.path().to_path_buf()],
            },
            timeout_ms: 10_000,
            shell: false,
            output_limit_bytes: None,
        })
        .await
        .expect("MXC execution");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("xihe-mxc-process-guard"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn mxc_execution_passes_cwd_and_environment() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let executable = std::env::var("XIHE_MXC_EXECUTABLE")
            .expect("XIHE_MXC_EXECUTABLE must point to the installed MXC binary");
        assert!(std::path::Path::new(&executable).is_file());
        let mut env = BTreeMap::new();
        env.insert(
            "XIHE_MXC_ACCEPTANCE_ENV".to_string(),
            "boundary-env".to_string(),
        );
        let result = super::execute(super::ProcessRequest {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: Some("windows-mxc".to_string()),
            backend_revision: Some("builtin".to_string()),
            execution_mode: "windows-mxc".to_string(),
            program: "cmd.exe".to_string(),
            args: vec![
                "/C".to_string(),
                "echo %XIHE_MXC_ACCEPTANCE_ENV% && cd".to_string(),
            ],
            cwd: Some(directory.path().to_path_buf()),
            env,
            filesystem: super::FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![directory.path().to_path_buf()],
            },
            timeout_ms: 10_000,
            shell: false,
            output_limit_bytes: None,
        })
        .await
        .expect("MXC cwd/env execution");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("boundary-env"));
        let cwd_name = directory
            .path()
            .file_name()
            .expect("temporary directory name")
            .to_string_lossy()
            .to_ascii_lowercase();
        assert!(result.stdout.to_ascii_lowercase().contains(&cwd_name));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn mxc_timeout_terminates_the_wrapper_process_tree() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let error = super::execute(super::ProcessRequest {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: Some("windows-mxc".to_string()),
            backend_revision: Some("builtin".to_string()),
            execution_mode: "windows-mxc".to_string(),
            program: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), "ping -n 20 127.0.0.1 > nul".to_string()],
            cwd: Some(directory.path().to_path_buf()),
            env: BTreeMap::new(),
            filesystem: super::FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![directory.path().to_path_buf()],
            },
            timeout_ms: 100,
            shell: false,
            output_limit_bytes: None,
        })
        .await
        .expect_err("long-running MXC process must time out");
        assert!(matches!(error, super::RuntimeError::ProcessTimeout { .. }));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn mxc_execution_rejects_cwd_outside_granted_root() {
        let allowed = tempfile::tempdir().expect("allowed directory");
        let outside = tempfile::tempdir().expect("outside directory");
        let result = super::execute(super::ProcessRequest {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: Some("windows-mxc".to_string()),
            backend_revision: Some("builtin".to_string()),
            execution_mode: "windows-mxc".to_string(),
            program: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), "echo must-not-run".to_string()],
            cwd: Some(outside.path().to_path_buf()),
            env: BTreeMap::new(),
            filesystem: super::FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![allowed.path().to_path_buf()],
            },
            timeout_ms: 10_000,
            shell: false,
            output_limit_bytes: None,
        })
        .await
        .expect_err("MXC must reject cwd outside grants");
        assert!(
            matches!(result, super::RuntimeError::Unsupported { reason, .. } if reason == "CWD_OUTSIDE_GRANT")
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn host_execution_caps_output_and_flags_truncation() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let result = super::execute(super::ProcessRequest {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: Some("windows-host".to_string()),
            backend_revision: Some("builtin".to_string()),
            execution_mode: "windows-host".to_string(),
            program: "cmd.exe".to_string(),
            args: vec![
                "/C".to_string(),
                "for /L %i in (1,1,2000) do @echo 0123456789012345678901234567890123456789"
                    .to_string(),
            ],
            cwd: Some(directory.path().to_path_buf()),
            env: BTreeMap::new(),
            filesystem: super::FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![directory.path().to_path_buf()],
            },
            timeout_ms: 30_000,
            shell: false,
            output_limit_bytes: Some(4096),
        })
        .await
        .expect("host execution");
        assert!(result.stdout_truncated, "80 KB of output must be capped");
        assert!(result.stdout.len() <= 4096);
        assert!(!result.stderr_truncated);
    }
}
