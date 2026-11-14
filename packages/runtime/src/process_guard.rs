//! PLAN-0379 v1 process backend contract and Windows capability probing.
//!
//! The probe is deliberately separate from process launch. Every launch repeats
//! the probe so a stale CP preflight cannot bypass Runtime's fail-closed gate.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
#[cfg(windows)]
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

/// What MXC's `--probe` says about the isolation tier it would select.
///
/// task-545: the probe already reports `tier` / `needsDaclAugmentation` /
/// `warnings`, but the Runtime only read `version` out of it, so a silent
/// downgrade T1 BaseContainer -> T3 AppContainer+DACL was invisible. Tier names
/// come from MXC's own enforcement-tier table (T1 `base-container`, T2
/// `appcontainer-bfs`, T3 `appcontainer`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MxcProbeReadout {
    pub tier: Option<String>,
    pub needs_dacl_augmentation: bool,
    pub warnings: Vec<String>,
}

impl MxcProbeReadout {
    pub fn from_probe_payload(payload: &serde_json::Value) -> Self {
        Self {
            tier: payload
                .get("tier")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            needs_dacl_augmentation: payload
                .get("needsDaclAugmentation")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            warnings: payload
                .get("warnings")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// True when the probe reports the strongest tier (T1 BaseContainer). Any
    /// other answer means the policy will be enforced by a weaker mechanism.
    pub fn is_strongest_tier(&self) -> bool {
        self.tier.as_deref() == Some("base-container")
    }

    /// Why the tier is not the strongest one, for logging (no policy change).
    pub fn degradation_reason(&self) -> Option<String> {
        if self.is_strongest_tier() {
            return None;
        }
        let tier = self.tier.as_deref().unwrap_or("unknown");
        Some(if self.needs_dacl_augmentation {
            format!("isolation tier {tier} (appcontainer + host DACL mutation)")
        } else {
            format!("isolation tier {tier}")
        })
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
                    // BL-606: cleanup runs exactly when the child misbehaved, so the cleanup leg
                    // fails exactly when we most need the original error. Propagating it (`?`)
                    // replaced `ProcessTimeout` with `ProcessTreeCleanupFailed`, which flips the
                    // caller's retry/idempotency decision on a run whose child may still be alive.
                    // Keep the original error; log the cleanup failure instead of promoting it.
                    if let Err(cleanup_error) = terminate_process_tree(pid).await {
                        tracing::warn!(
                            pid,
                            error = %cleanup_error,
                            original = %error,
                            "process tree cleanup failed after timeout; keeping the original error"
                        );
                    }
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
        // PLAN-0394: the same builder serves one-shot and job paths.
        let cwd = request.cwd.clone().expect("validated cwd");
        let config = build_mxc_policy(&MxcPolicyRequest {
            program: request.program.clone(),
            args: request.args.clone(),
            cwd,
            env: request.env.clone(),
            timeout_ms: request.timeout_ms,
            read_only_roots: request.filesystem.read_only_roots.clone(),
            read_write_roots: request.filesystem.read_write_roots.clone(),
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
                    // BL-606: cleanup runs exactly when the child misbehaved, so the cleanup leg
                    // fails exactly when we most need the original error. Propagating it (`?`)
                    // replaced `ProcessTimeout` with `ProcessTreeCleanupFailed`, which flips the
                    // caller's retry/idempotency decision on a run whose child may still be alive.
                    // Keep the original error; log the cleanup failure instead of promoting it.
                    if let Err(cleanup_error) = terminate_process_tree(pid).await {
                        tracing::warn!(
                            pid,
                            error = %cleanup_error,
                            original = %error,
                            "process tree cleanup failed after timeout; keeping the original error"
                        );
                    }
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

#[cfg_attr(not(windows), allow(dead_code))]
struct CappedCapture {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
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

#[cfg_attr(not(windows), allow(dead_code))]
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

/// Inputs for the shared MXC policy builder (PLAN-0394 decision #5): both the
/// one-shot path and the job adapter must generate the same field set.
pub struct MxcPolicyRequest {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub read_only_roots: Vec<PathBuf>,
    pub read_write_roots: Vec<PathBuf>,
}

/// Builds the MXC v0.8 policy for one process.
///
/// Field set is the M0-verified minimum (`internal/A03-xihe/docs/evidence/
/// 2026-09-19-mxc-process-sandbox/chrome-run.json` + 0393 probe3): a missing
/// `readonlyPaths` entry for the program directory makes real programs die with
/// `0xC0000142` before Rust could report anything.
/// Environment variables a sandboxed child needs to initialize on Windows.
///
/// task-544: this list is the **only** bridge between the Runtime's own
/// process environment and the sandbox. The previous implementation merged
/// `std::env::vars()` whenever the caller supplied any variable, which handed
/// the child every CP/agent/provider secret the Runtime had loaded.
pub const SANDBOX_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "Path",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PROCESSOR_ARCHITECTURE",
];

/// Builds the sandbox environment: allowlisted host variables plus the caller's
/// explicit variables. Nothing else from the Runtime's environment crosses.
pub fn sandbox_env(extra: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut environment = SANDBOX_ENV_ALLOWLIST
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| ((*key).to_string(), value))
        })
        .collect::<BTreeMap<_, _>>();
    environment.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    environment
}

pub fn build_mxc_policy(request: &MxcPolicyRequest) -> serde_json::Value {
    let command_line = std::iter::once(request.program.clone())
        .chain(request.args.iter().cloned())
        .map(|part| quote_windows_argument(&part))
        .collect::<Vec<_>>()
        .join(" ");
    let mut process = serde_json::json!({
        "commandLine": command_line,
        "cwd": mxc_path(&request.cwd),
        // MXC requires a numeric timeout; the engine owns the real deadline.
        "timeout": if request.timeout_ms == 0 {
            MXC_UNBOUNDED_TIMEOUT_MS
        } else {
            request.timeout_ms
        },
    });
    if !request.env.is_empty() {
        let environment = sandbox_env(&request.env);
        process["env"] = serde_json::json!(
            environment
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
        );
    }
    let mut readonly: Vec<String> = request
        .read_only_roots
        .iter()
        .map(|path| mxc_path(path))
        .collect();
    // The program's own directory must stay readable, otherwise the sandboxed
    // process cannot initialize its DLLs.
    if let Some(program_dir) = Path::new(&request.program).parent()
        && !program_dir.as_os_str().is_empty()
    {
        let program_dir = mxc_path(program_dir);
        if !readonly.contains(&program_dir) {
            readonly.push(program_dir);
        }
    }
    serde_json::json!({
        "version": "0.8.0-alpha",
        "containment": "processcontainer",
        "process": process,
        "filesystem": {
            "readonlyPaths": readonly,
            "readwritePaths": request
                .read_write_roots
                .iter()
                .map(|path| mxc_path(path))
                .collect::<Vec<_>>(),
        },
        "fallback": { "allowDaclMutation": true },
        "network": {
            "egress": { "default": "allow" },
            "ingress": { "default": "allow", "hostLoopback": "allow" }
        },
        "processContainer": {
            "capabilities": ["internetClient", "privateNetworkClientServer"]
        },
        "ui": { "disable": false }
    })
}

/// MXC policy `process.timeout` when the caller asks for no deadline.
const MXC_UNBOUNDED_TIMEOUT_MS: u64 = 86_400_000;

/// BL-606 regression seam (compiled into **test builds on Windows only**).
///
/// Why a seam and not a `taskkill` shim: the shim worked by placing a file next to the executable so
/// `CreateProcess` resolved it first (search-order #1). That ties the fixture to the build directory
/// and breaks on another machine -- it stays an investigation tool (`inject-cleanup-failure.ps1`),
/// never a test fixture. `cfg(test)` also means the production binaries do not contain this code at
/// all (it is not "compiled but disabled").
///
/// Anti-crosstalk: `take()` is one-shot and the guard clears the slot on drop (also on panic), so a
/// concurrently running test that reaches this seam can only ever observe "no injection".
#[cfg(all(test, windows))]
mod test_seam {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, PoisonError};

    use super::RuntimeError;

    static INJECTED: Mutex<Option<RuntimeError>> = Mutex::new(None);
    static TAKEN: AtomicUsize = AtomicUsize::new(0);

    /// Clears the slot when the test ends, so leakage is bounded to a single test.
    pub(super) struct Injection;

    impl Drop for Injection {
        fn drop(&mut self) {
            *INJECTED.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
    }

    pub(super) fn inject(error: RuntimeError) -> Injection {
        *INJECTED.lock().unwrap_or_else(PoisonError::into_inner) = Some(error);
        Injection
    }

    /// Consumes the injected error; `None` afterwards, so at most one caller can be affected.
    pub(super) fn take() -> Option<RuntimeError> {
        let injected = INJECTED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if injected.is_some() {
            TAKEN.fetch_add(1, Ordering::SeqCst);
        }
        injected
    }

    /// How many injections actually fired. A test asserting "the original error survived" must also
    /// assert this is exactly 1 -- an un-fired seam would otherwise read as green (the BL-363
    /// `terminate=0` lesson: "did not reach it" and "reached it and it worked" look identical).
    pub(super) fn take_count() -> usize {
        TAKEN.load(Ordering::SeqCst)
    }
}

/// 按 PID 杀掉整棵进程树（Windows `taskkill /T /F`）。
///
/// `pub(crate)`：T2.4a 的插件 runner（`crate::plugin::runner`）拿它做崩溃回收，
/// 保证"进程树整棵杀"只有这一份实现，不在第二个地方再写一次 `taskkill` 口径。
#[cfg(windows)]
pub(crate) async fn terminate_process_tree(pid: u32) -> Result<()> {
    #[cfg(test)]
    if let Some(injected) = test_seam::take() {
        return Err(injected);
    }
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

fn mxc_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
}

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
        // task-545: record which isolation tier MXC would actually enforce. This
        // is a log field on purpose — DEV-031/AGENTS keeps the MXC tier out of
        // API responses, and the value must not be inferred from the policy.
        let readout = MxcProbeReadout::from_probe_payload(&payload);
        tracing::info!(
            backend = "windows-mxc",
            isolation_tier = readout.tier.as_deref().unwrap_or("unknown"),
            needs_dacl_augmentation = readout.needs_dacl_augmentation,
            probe_warnings = readout.warnings.len(),
            "mxc probe: isolation tier resolved"
        );
        if let Some(reason) = readout.degradation_reason() {
            tracing::warn!(
                backend = "windows-mxc",
                isolation_tier = readout.tier.as_deref().unwrap_or("unknown"),
                needs_dacl_augmentation = readout.needs_dacl_augmentation,
                "mxc probe: isolation below T1 base-container: {reason}"
            );
        }
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
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::{BackendCapabilitySnapshot, CONTRACT_VERSION, DirectAttachProbeRequest};

    /// Every MXC case below is `#[ignore]`d on purpose (BL-568/task-46): it needs the host binary,
    /// and silently *returning* from the test reported "passed" for a boundary nobody measured.
    /// `#[ignore]` shows up in the test summary; this helper turns a missing env var into one
    /// actionable message instead of a confusing "backend unavailable" deep inside `execute`.
    #[cfg(windows)]
    fn mxc_executable_for_test() -> std::path::PathBuf {
        std::env::var_os("XIHE_MXC_EXECUTABLE")
            .map(std::path::PathBuf::from)
            .filter(|candidate| candidate.is_file())
            .unwrap_or_else(|| {
                panic!(
                    "MXC boundary cases need XIHE_MXC_EXECUTABLE pointing at the installed wxc-exec.exe; \
                     run `mise run test:runtime:lib:ignored:mxc` with it set (see the mxc-windows-sandbox-ops skill)"
                )
            })
    }

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

    /// BL-606 regression: a failed `terminate_process_tree` must not replace the timeout error.
    ///
    /// Two-directional judgement (task-29 card): green on patch B, red on the unfixed code
    /// (`terminate_process_tree(pid).await?` => the caller sees `ProcessTreeCleanupFailed`).
    /// The seam-consumption assertion is not decoration: a seam that never fired would make the
    /// "original error survived" assertion pass for the wrong reason, which is exactly the trap
    /// BL-363's `terminate=0` run fell into.
    #[cfg(windows)]
    #[tokio::test]
    async fn cleanup_failure_keeps_the_timeout_error() {
        let directory = tempfile::tempdir().expect("temporary workspace directory");
        let _injection = super::test_seam::inject(super::RuntimeError::ProcessTreeCleanupFailed {
            detail: "injected by the BL-606 cleanup seam".to_string(),
        });
        let error = super::execute(super::ProcessRequest {
            contract_version: CONTRACT_VERSION.to_string(),
            backend_kind: Some("windows-host".to_string()),
            backend_revision: Some("builtin".to_string()),
            execution_mode: "windows-host".to_string(),
            program: "cmd.exe".to_string(),
            // Short on purpose: the injected seam skips the real `taskkill`, so this child is
            // *not* killed and would keep its stdout pipe open for as long as it runs. `ping -n 3`
            // (~2 s) still exceeds the 100 ms deadline but keeps the test at seconds, not 20 s.
            args: vec!["/C".to_string(), "ping -n 3 127.0.0.1 > nul".to_string()],
            cwd: Some(directory.path().to_path_buf()),
            env: BTreeMap::new(),
            filesystem: super::FilesystemPolicy::default(),
            timeout_ms: 100,
            shell: false,
            output_limit_bytes: None,
        })
        .await
        .expect_err("long-running host process must time out");
        assert_eq!(
            super::test_seam::take_count(),
            1,
            "the cleanup seam never fired, so the injection did not take effect and this run proves nothing"
        );
        assert!(
            matches!(error, super::RuntimeError::ProcessTimeout { .. }),
            "cleanup failure replaced the original error: {error:?}"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "needs host MXC (XIHE_MXC_EXECUTABLE); run `mise run test:runtime:lib:ignored:mxc`"]
    async fn mxc_execution_captures_process_output() {
        let _executable = mxc_executable_for_test();
        let directory = tempfile::tempdir().expect("temporary workspace directory");
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
    #[ignore = "needs host MXC (XIHE_MXC_EXECUTABLE); run `mise run test:runtime:lib:ignored:mxc`"]
    async fn mxc_execution_passes_cwd_and_environment() {
        let _executable = mxc_executable_for_test();
        let directory = tempfile::tempdir().expect("temporary workspace directory");
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
    #[ignore = "needs host MXC (XIHE_MXC_EXECUTABLE); run `mise run test:runtime:lib:ignored:mxc`"]
    async fn mxc_timeout_terminates_the_wrapper_process_tree() {
        let _executable = mxc_executable_for_test();
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
    #[ignore = "needs host MXC (XIHE_MXC_EXECUTABLE); run `mise run test:runtime:lib:ignored:mxc`"]
    async fn mxc_execution_rejects_cwd_outside_granted_root() {
        let _executable = mxc_executable_for_test();
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

    #[test]
    fn mxc_policy_carries_the_verified_field_set() {
        let policy = super::build_mxc_policy(&super::MxcPolicyRequest {
            program: r"C:\tools\node\node.exe".to_string(),
            args: vec!["-e".to_string(), "console.log(1)".to_string()],
            cwd: PathBuf::from(r"C:\ws"),
            env: BTreeMap::new(),
            timeout_ms: 0,
            read_only_roots: Vec::new(),
            read_write_roots: vec![PathBuf::from(r"C:\ws")],
        });
        assert_eq!(policy["containment"], "processcontainer");
        assert_eq!(policy["process"]["timeout"], 86_400_000u64);
        assert!(
            policy["process"]["commandLine"]
                .as_str()
                .unwrap_or_default()
                .contains("node.exe")
        );
        let readonly = policy["filesystem"]["readonlyPaths"]
            .as_array()
            .expect("readonlyPaths");
        assert!(
            readonly
                .iter()
                .any(|value| value.as_str().unwrap_or_default().ends_with("node")),
            "the program directory must be readable: {readonly:?}"
        );
        assert_eq!(policy["fallback"]["allowDaclMutation"], true);
        let capabilities = policy["processContainer"]["capabilities"]
            .as_array()
            .expect("capabilities");
        assert!(capabilities.iter().any(|value| value == "internetClient"));
        assert_eq!(policy["network"]["egress"]["default"], "allow");
        assert_eq!(policy["network"]["ingress"]["hostLoopback"], "allow");
        assert_eq!(policy["ui"]["disable"], false);
    }

    /// task-544: a caller-supplied variable must not open the door to the
    /// Runtime's own environment. Only allowlisted system variables and the
    /// caller's own keys may appear in the policy.
    /// task-545: the tier MXC actually selected must be readable from its own
    /// probe payload, and a downgrade must be distinguishable from the top tier.
    #[test]
    fn mxc_probe_readout_surfaces_the_selected_isolation_tier() {
        let strongest = super::MxcProbeReadout::from_probe_payload(&serde_json::json!({
            "tier": "base-container",
            "needsDaclAugmentation": false,
            "warnings": [],
            "probes": { "baseContainerApiPresent": true }
        }));
        assert_eq!(strongest.tier.as_deref(), Some("base-container"));
        assert!(!strongest.needs_dacl_augmentation);
        assert!(strongest.is_strongest_tier());
        assert!(strongest.degradation_reason().is_none());

        let downgraded = super::MxcProbeReadout::from_probe_payload(&serde_json::json!({
            "tier": "appcontainer",
            "needsDaclAugmentation": true,
            "warnings": ["processmodel.dll missing"],
        }));
        assert_eq!(downgraded.tier.as_deref(), Some("appcontainer"));
        assert!(downgraded.needs_dacl_augmentation);
        assert!(!downgraded.is_strongest_tier());
        let reason = downgraded.degradation_reason().unwrap_or_default();
        assert!(reason.contains("appcontainer"), "{reason}");
        assert!(reason.contains("DACL"), "{reason}");
        assert_eq!(downgraded.warnings.len(), 1);

        let unknown = super::MxcProbeReadout::from_probe_payload(&serde_json::json!({}));
        assert!(unknown.tier.is_none());
        assert!(!unknown.is_strongest_tier());
        assert_eq!(
            unknown.degradation_reason().as_deref(),
            Some("isolation tier unknown")
        );
    }

    #[test]
    fn mxc_policy_env_is_limited_to_the_sandbox_allowlist() {
        let mut caller_env = BTreeMap::new();
        caller_env.insert("XH_CALLER_MARKER".to_string(), "1".to_string());
        let policy = super::build_mxc_policy(&super::MxcPolicyRequest {
            program: r"C:\tools\node\node.exe".to_string(),
            args: Vec::new(),
            cwd: PathBuf::from(r"C:\ws"),
            env: caller_env,
            timeout_ms: 1_000,
            read_only_roots: Vec::new(),
            read_write_roots: vec![PathBuf::from(r"C:\ws")],
        });
        let names = policy["process"]["env"]
            .as_array()
            .expect("caller env must produce a policy env block")
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
            names.iter().any(|name| name == "XH_CALLER_MARKER"),
            "the caller's own variable must survive: {names:?}"
        );
        let unexpected = names
            .iter()
            .filter(|name| {
                name.as_str() != "XH_CALLER_MARKER"
                    && !super::SANDBOX_ENV_ALLOWLIST.contains(&name.as_str())
            })
            .collect::<Vec<_>>();
        assert!(
            unexpected.is_empty(),
            "no host variable outside the sandbox allowlist may cross: {unexpected:?}"
        );
        let sensitive = names
            .iter()
            .filter(|name| {
                let upper = name.to_ascii_uppercase();
                ["KEY", "TOKEN", "SECRET", "PASSWORD", "DSN", "CREDENTIAL"]
                    .iter()
                    .any(|needle| upper.contains(needle))
            })
            .collect::<Vec<_>>();
        assert!(
            sensitive.is_empty(),
            "policy env must not carry credential-shaped names: {sensitive:?}"
        );
    }

    #[test]
    fn mxc_policy_keeps_the_requested_timeout() {
        let policy = super::build_mxc_policy(&super::MxcPolicyRequest {
            program: "wxc-exec.exe".to_string(),
            args: Vec::new(),
            cwd: PathBuf::from(r"C:\ws"),
            env: BTreeMap::new(),
            timeout_ms: 12_345,
            read_only_roots: Vec::new(),
            read_write_roots: vec![PathBuf::from(r"C:\ws")],
        });
        assert_eq!(policy["process"]["timeout"], 12_345u64);
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
