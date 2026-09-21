//! Windows Process Job engine (PLAN-0393).
//!
//! Backend-neutral job ownership: every job runs inside its own Windows Job
//! Object (kill-on-close), output is captured into bounded files under the
//! Runtime state dir, and timeout / cancel / cleanup report explicit results.
//!
//! Contract: `plans/PLAN-0393-XH-windows-process-job-engine/spec/windows-process-job-engine.md`.
//! The engine returns PLAN-0390 types directly and never invents synonyms.
//!
//! The only `unsafe` code lives in the `sys` submodule.

#[cfg(windows)]
#[path = "win.rs"]
mod sys;
#[cfg(not(windows))]
#[path = "stub.rs"]
mod sys;

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::process_guard::FilesystemPolicy;

/// Per-stream stored-byte cap (decision #17: aligned with the container path).
pub const STREAM_CAP_BYTES: u64 = 1024 * 1024;
/// Default `read_output` limit (CP default: 64 KiB).
pub const READ_DEFAULT_LIMIT: usize = 65_536;
/// Maximum `read_output` limit (CP cap: 1 MiB).
pub const READ_MAX_LIMIT: usize = 1_048_576;
/// Terminal jobs keep their output for this long before the reaper removes it.
pub const OUTPUT_TTL: Duration = Duration::from_secs(15 * 60);
/// How long cancel waits for the job object to drain before reporting
/// `unconfirmed`.
pub const CANCEL_CONFIRM_TIMEOUT: Duration = Duration::from_secs(3);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(25);

const CLEANUP_NOT_STARTED: &str = "not_started";

/// Engine error surface. `code()` gives the PLAN-0390 error code that the HTTP
/// layer projects upward; `ENGINE_*` names never leave the Runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobEngineError {
    /// Backend has no launcher for this execution mode (no downgrade).
    LaunchPending(String),
    /// Sandbox policy failure, process creation failure or platform mismatch.
    Unavailable(String),
    /// `cwd` / writable path outside the authorized grants (fail-closed).
    InvalidPath(String),
    /// Unknown job id (handle lost after a Runtime restart).
    NotFound,
    /// Output files were reclaimed or are unreadable.
    OutputMissing(String),
    /// Operation not supported on this platform.
    Unsupported(String),
}

impl JobEngineError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::LaunchPending(_) => "PROCESS_BACKEND_LAUNCH_PENDING",
            Self::Unavailable(_) | Self::InvalidPath(_) | Self::OutputMissing(_) => {
                "RUNTIME_UNAVAILABLE"
            }
            Self::Unsupported(_) => "RUNTIME_UNAVAILABLE",
            Self::NotFound => "JOB_NOT_FOUND",
        }
    }

    pub fn reason(&self) -> String {
        match self {
            Self::LaunchPending(reason)
            | Self::Unavailable(reason)
            | Self::InvalidPath(reason)
            | Self::OutputMissing(reason)
            | Self::Unsupported(reason) => reason.clone(),
            Self::NotFound => "job handle not found".to_string(),
        }
    }
}

impl std::fmt::Display for JobEngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.reason())
    }
}

impl std::error::Error for JobEngineError {}

/// Launch plan produced by a backend adapter (PLAN-0394/0395).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlan {
    pub backend_kind: String,
    #[serde(default)]
    pub backend_revision: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// `0` means no deadline (matches the container job convention).
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub shell: bool,
    #[serde(default)]
    pub grants: FilesystemPolicy,
    /// Sandbox policy artifact produced by the adapter; the engine only passes
    /// it to the program, it never parses it.
    #[serde(default)]
    pub policy_artifact: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobHandle {
    pub opaque_handle_id: String,
    pub backend_kind: String,
    pub backend_revision: String,
    pub runtime_boot_id: String,
    pub job_id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    TimedOut,
    Cancelled,
    Unknown,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::TimedOut => "timed_out",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::TimedOut | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub status: JobStatus,
    pub exit_code: Option<i32>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub truncated: bool,
    pub cleanup_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub stream: String,
    pub offset: usize,
    pub next_offset: usize,
    pub size_bytes: usize,
    pub truncated: bool,
    pub data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelOutcome {
    Cancelled,
    NotFound,
    Unconfirmed,
    AlreadyTerminal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub outcome: CancelOutcome,
    pub status: JobStatus,
    pub changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupOutcome {
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub outcome: CleanupOutcome,
    pub reason: Option<String>,
    pub processes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

impl OutputStream {
    pub fn parse(value: &str) -> Result<Self, JobEngineError> {
        match value {
            "stdout" => Ok(Self::Stdout),
            "stderr" => Ok(Self::Stderr),
            other => Err(JobEngineError::InvalidPath(format!(
                "unsupported output stream {other:?}"
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CleanupState {
    NotStarted,
    Running,
    Completed,
    Failed,
}

impl CleanupState {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotStarted => CLEANUP_NOT_STARTED,
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug)]
struct JobState {
    status: JobStatus,
    exit_code: Option<i32>,
    started_at: SystemTime,
    finished_at: Option<SystemTime>,
    cleanup: CleanupState,
}

struct OutputPaths {
    dir: PathBuf,
    stdout: PathBuf,
    stderr: PathBuf,
}

impl OutputPaths {
    fn for_job(root: &Path, job_id: &str) -> Self {
        let dir = root.join(sanitize_job_id(job_id));
        Self {
            stdout: dir.join("stdout.log"),
            stderr: dir.join("stderr.log"),
            dir,
        }
    }

    fn for_stream(&self, stream: OutputStream) -> &Path {
        match stream {
            OutputStream::Stdout => &self.stdout,
            OutputStream::Stderr => &self.stderr,
        }
    }
}

#[derive(Default)]
struct OutputCounters {
    bytes: AtomicU64,
    truncated: AtomicBool,
}

struct JobEntry {
    job_id: String,
    handle: JobHandle,
    job_object: Arc<sys::JobObject>,
    child: Mutex<Option<Child>>,
    state: Mutex<JobState>,
    outputs: OutputPaths,
    stdout: OutputCounters,
    stderr: OutputCounters,
    cancel_requested: AtomicBool,
}

impl JobEntry {
    fn snapshot(&self) -> JobSnapshot {
        let state = self.state.lock().expect("job state poisoned");
        let stdout_bytes = self.stdout.bytes.load(Ordering::Relaxed);
        let stderr_bytes = self.stderr.bytes.load(Ordering::Relaxed);
        let truncated = self.stdout.truncated.load(Ordering::Relaxed)
            || self.stderr.truncated.load(Ordering::Relaxed);
        JobSnapshot {
            status: state.status,
            exit_code: state.exit_code,
            started_at: Some(iso8601(state.started_at)),
            finished_at: state.finished_at.map(iso8601),
            stdout_bytes,
            stderr_bytes,
            truncated,
            cleanup_status: state.cleanup.as_str().to_string(),
        }
    }

    /// Records a terminal state; the first terminal write wins so cancel and
    /// timeout cannot be overwritten by the exit watcher.
    fn finish(&self, status: JobStatus, exit_code: Option<i32>) {
        let mut state = self.state.lock().expect("job state poisoned");
        if state.status.is_terminal() {
            if state.exit_code.is_none() {
                state.exit_code = exit_code;
            }
            return;
        }
        state.status = status;
        if exit_code.is_some() {
            state.exit_code = exit_code;
        }
        state.finished_at = Some(SystemTime::now());
    }
}

/// The engine owns every job handle of one Runtime process.
pub struct JobEngine {
    boot_id: String,
    output_root: PathBuf,
    jobs: Mutex<HashMap<String, Arc<JobEntry>>>,
}

impl JobEngine {
    pub fn new(boot_id: impl Into<String>, output_root: PathBuf) -> Self {
        Self {
            boot_id: boot_id.into(),
            output_root,
            jobs: Mutex::new(HashMap::new()),
        }
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    pub fn output_root(&self) -> &Path {
        &self.output_root
    }

    pub fn active_count(&self) -> usize {
        self.jobs.lock().expect("job table poisoned").len()
    }

    fn get_entry(&self, job_id: &str) -> Option<Arc<JobEntry>> {
        self.jobs
            .lock()
            .expect("job table poisoned")
            .get(job_id)
            .cloned()
    }

    /// Starts a job. Re-starts with the same `job_id` are idempotent and return
    /// the existing handle (decision #20).
    pub fn start(&self, job_id: &str, plan: LaunchPlan) -> Result<JobHandle, JobEngineError> {
        if let Some(existing) = self.get_entry(job_id) {
            return Ok(existing.handle.clone());
        }

        #[cfg(windows)]
        {
            self.start_windows(job_id, plan)
        }

        #[cfg(not(windows))]
        {
            let _ = (job_id, plan);
            Err(JobEngineError::Unsupported(
                "windows process job engine requires windows".to_string(),
            ))
        }
    }

    /// Output directory that this job id maps to. Adapters write backend
    /// artifacts (for example the MXC policy) here so the existing cleanup,
    /// TTL and orphan reaping paths remove them without extra logic.
    pub fn output_dir(&self, job_id: &str) -> PathBuf {
        OutputPaths::for_job(&self.output_root, job_id).dir
    }

    pub fn handle(&self, job_id: &str) -> Result<JobHandle, JobEngineError> {
        self.get_entry(job_id)
            .map(|entry| entry.handle.clone())
            .ok_or(JobEngineError::NotFound)
    }

    /// PIDs still owned by the job object (internal diagnostics; the HTTP layer
    /// must never project these upward).
    pub fn job_pids(&self, job_id: &str) -> Result<Vec<u32>, JobEngineError> {
        let entry = self.get_entry(job_id).ok_or(JobEngineError::NotFound)?;
        entry.job_object.pids().map_err(|error| {
            JobEngineError::Unavailable(format!("job pid query failed (os error {error})"))
        })
    }

    pub fn snapshot(&self, job_id: &str) -> Result<JobSnapshot, JobEngineError> {
        self.get_entry(job_id)
            .map(|entry| entry.snapshot())
            .ok_or(JobEngineError::NotFound)
    }

    /// Bounded, cursor-based output read (`offset` is a byte cursor, `limit`
    /// defaults to 64 KiB and is capped at 1 MiB).
    pub fn read_output(
        &self,
        job_id: &str,
        stream: &str,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<OutputChunk, JobEngineError> {
        let stream = OutputStream::parse(stream)?;
        let entry = self.get_entry(job_id).ok_or(JobEngineError::NotFound)?;
        read_output_file(entry.outputs.for_stream(stream), stream, offset, limit)
    }

    /// Terminates the job tree and reports whether termination was confirmed.
    pub fn cancel(&self, job_id: &str) -> Result<CancelResult, JobEngineError> {
        let entry = self.get_entry(job_id).ok_or(JobEngineError::NotFound)?;
        let status = entry.snapshot().status;
        if status.is_terminal() {
            return Ok(CancelResult {
                outcome: CancelOutcome::AlreadyTerminal,
                status,
                changed: false,
            });
        }
        entry.cancel_requested.store(true, Ordering::SeqCst);
        let report = terminate_and_confirm(&entry);
        if report.taskkill_fallback {
            tracing::warn!(
                job_id = %job_id,
                confirmed = report.confirmed,
                "PLAN-0393: cancel went through the recorded taskkill fallback"
            );
        }
        if report.confirmed {
            entry.finish(JobStatus::Cancelled, None);
            reap_child(&entry);
            Ok(CancelResult {
                outcome: CancelOutcome::Cancelled,
                status: JobStatus::Cancelled,
                changed: true,
            })
        } else {
            Ok(CancelResult {
                outcome: CancelOutcome::Unconfirmed,
                status: entry.snapshot().status,
                changed: false,
            })
        }
    }

    /// Reclaims one job: terminates it when needed, then removes its output
    /// directory and registry entry.
    pub fn cleanup(&self, job_id: &str) -> Result<CleanupResult, JobEngineError> {
        let entry = self.get_entry(job_id).ok_or(JobEngineError::NotFound)?;
        Ok(self.cleanup_entry(job_id, &entry))
    }

    /// Removes terminal jobs whose output outlived [`OUTPUT_TTL`].
    pub fn reap_expired(&self) -> usize {
        let expired: Vec<String> = self
            .jobs
            .lock()
            .expect("job table poisoned")
            .iter()
            .filter_map(|(job_id, entry)| {
                let state = entry.state.lock().expect("job state poisoned");
                let finished = state.finished_at?;
                if !state.status.is_terminal() {
                    return None;
                }
                match SystemTime::now().duration_since(finished) {
                    Ok(age) if age >= OUTPUT_TTL => Some(job_id.clone()),
                    _ => None,
                }
            })
            .collect();
        let mut reclaimed = 0;
        for job_id in expired {
            if let Some(entry) = self.get_entry(&job_id)
                && let CleanupOutcome::Completed = self.cleanup_entry(&job_id, &entry).outcome
            {
                reclaimed += 1;
            }
        }
        reclaimed
    }

    /// Startup hygiene: removes output directories that no live handle owns
    /// (the previous Runtime process is gone, so they are unreachable).
    pub fn reap_orphan_output_dirs(&self) -> usize {
        let known: Vec<String> = self
            .jobs
            .lock()
            .expect("job table poisoned")
            .keys()
            .map(|job_id| sanitize_job_id(job_id))
            .collect();
        let mut removed = 0;
        let Ok(entries) = fs::read_dir(&self.output_root) else {
            return 0;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if known.contains(&name) {
                continue;
            }
            if entry.path().is_dir() {
                match fs::remove_dir_all(entry.path()) {
                    Ok(()) => removed += 1,
                    Err(error) => tracing::warn!(
                        job_output_dir = %entry.path().display(),
                        error = %error,
                        "PLAN-0393: failed to remove orphan job output dir"
                    ),
                }
            }
        }
        removed
    }

    /// Terminates every job still owned by this engine (Runtime shutdown).
    pub fn shutdown_all(&self) -> usize {
        let entries: Vec<Arc<JobEntry>> = self
            .jobs
            .lock()
            .expect("job table poisoned")
            .values()
            .cloned()
            .collect();
        for entry in &entries {
            entry.cancel_requested.store(true, Ordering::SeqCst);
            let _ = terminate_and_confirm(entry);
            reap_child(entry);
        }
        entries.len()
    }

    fn cleanup_entry(&self, job_id: &str, entry: &Arc<JobEntry>) -> CleanupResult {
        {
            let mut state = entry.state.lock().expect("job state poisoned");
            state.cleanup = CleanupState::Running;
        }
        let mut reclaimed = 0;
        if !entry.snapshot().status.is_terminal() {
            entry.cancel_requested.store(true, Ordering::SeqCst);
            let report = terminate_and_confirm(entry);
            reclaimed = report.reclaimed;
            if !report.confirmed {
                let mut state = entry.state.lock().expect("job state poisoned");
                state.cleanup = CleanupState::Failed;
                return CleanupResult {
                    outcome: CleanupOutcome::Failed,
                    reason: Some("process tree termination was not confirmed".to_string()),
                    processes: reclaimed,
                };
            }
            entry.finish(JobStatus::Cancelled, None);
            reap_child(entry);
        }
        let removal = if entry.outputs.dir.exists() {
            fs::remove_dir_all(&entry.outputs.dir)
        } else {
            Ok(())
        };
        match removal {
            Ok(()) => {
                {
                    let mut state = entry.state.lock().expect("job state poisoned");
                    state.cleanup = CleanupState::Completed;
                }
                self.jobs.lock().expect("job table poisoned").remove(job_id);
                CleanupResult {
                    outcome: CleanupOutcome::Completed,
                    reason: None,
                    processes: reclaimed,
                }
            }
            Err(error) => {
                tracing::warn!(
                    job_id = %job_id,
                    error = %error,
                    "PLAN-0393: job output directory removal failed"
                );
                let mut state = entry.state.lock().expect("job state poisoned");
                state.cleanup = CleanupState::Failed;
                CleanupResult {
                    outcome: CleanupOutcome::Failed,
                    reason: Some(format!("output removal failed: {error}")),
                    processes: reclaimed,
                }
            }
        }
    }

    #[cfg(windows)]
    fn start_windows(&self, job_id: &str, plan: LaunchPlan) -> Result<JobHandle, JobEngineError> {
        use std::os::windows::io::AsRawHandle;

        let cwd = validate_cwd(&plan)?;
        let mut command = build_command(&plan);
        command
            .current_dir(&cwd)
            .envs(&plan.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(sys::CREATE_SUSPENDED_FLAG);
        }
        let mut child = command.spawn().map_err(|error| {
            JobEngineError::Unavailable(format!("process creation failed: {error}"))
        })?;

        let job_object = match sys::JobObject::create_kill_on_close() {
            Ok(job) => Arc::new(job),
            Err(error) => {
                let _ = child.kill();
                return Err(JobEngineError::Unavailable(format!(
                    "job object creation failed (os error {error})"
                )));
            }
        };
        if let Err(error) = job_object.assign(child.as_raw_handle()) {
            let _ = child.kill();
            return Err(JobEngineError::Unavailable(format!(
                "assign to job object failed (os error {error}); refusing to run outside the job"
            )));
        }
        let pid = child.id();
        if let Err(error) = sys::resume_main_thread(pid) {
            let _ = job_object.terminate(1);
            let _ = child.kill();
            return Err(JobEngineError::Unavailable(format!(
                "resume failed (os error {error})"
            )));
        }

        let outputs = OutputPaths::for_job(&self.output_root, job_id);
        if let Err(error) = fs::create_dir_all(&outputs.dir) {
            let _ = job_object.terminate(1);
            let _ = child.kill();
            return Err(JobEngineError::Unavailable(format!(
                "job output dir creation failed: {error}"
            )));
        }

        let entry = Arc::new(JobEntry {
            job_id: job_id.to_string(),
            handle: JobHandle {
                opaque_handle_id: uuid::Uuid::new_v4().to_string(),
                backend_kind: plan.backend_kind.clone(),
                backend_revision: plan.backend_revision.clone(),
                runtime_boot_id: self.boot_id.clone(),
                job_id: job_id.to_string(),
                started_at: iso8601(SystemTime::now()),
            },
            job_object: Arc::clone(&job_object),
            child: Mutex::new(Some(child)),
            state: Mutex::new(JobState {
                status: JobStatus::Running,
                exit_code: None,
                started_at: SystemTime::now(),
                finished_at: None,
                cleanup: CleanupState::NotStarted,
            }),
            outputs,
            stdout: OutputCounters::default(),
            stderr: OutputCounters::default(),
            cancel_requested: AtomicBool::new(false),
        });

        if let Some(stdout) = entry
            .child
            .lock()
            .expect("job child poisoned")
            .as_mut()
            .and_then(|child| child.stdout.take())
        {
            spawn_pump(
                stdout,
                entry.outputs.stdout.clone(),
                Arc::clone(&entry),
                OutputStream::Stdout,
            );
        }
        if let Some(stderr) = entry
            .child
            .lock()
            .expect("job child poisoned")
            .as_mut()
            .and_then(|child| child.stderr.take())
        {
            spawn_pump(
                stderr,
                entry.outputs.stderr.clone(),
                Arc::clone(&entry),
                OutputStream::Stderr,
            );
        }

        self.jobs
            .lock()
            .expect("job table poisoned")
            .insert(job_id.to_string(), Arc::clone(&entry));
        spawn_watcher(Arc::clone(&entry), plan.timeout_ms);
        Ok(entry.handle.clone())
    }
}

impl Drop for JobEngine {
    fn drop(&mut self) {
        let _ = self.shutdown_all();
    }
}

#[cfg(windows)]
fn spawn_pump<R: Read + Send + 'static>(
    reader: R,
    path: PathBuf,
    entry: Arc<JobEntry>,
    stream: OutputStream,
) {
    let _ = std::thread::Builder::new()
        .name(format!("job-pump-{}", stream.as_str()))
        .spawn(move || {
            let counters = match stream {
                OutputStream::Stdout => &entry.stdout,
                OutputStream::Stderr => &entry.stderr,
            };
            pump_stream(reader, &path, counters);
        });
}

#[cfg(windows)]
fn spawn_watcher(entry: Arc<JobEntry>, timeout_ms: u64) {
    let handle = entry
        .child
        .lock()
        .expect("job child poisoned")
        .as_ref()
        .map(|child| {
            use std::os::windows::io::AsRawHandle;
            child.as_raw_handle() as isize
        });
    let Some(process) = handle else {
        return;
    };
    let deadline = if timeout_ms == 0 {
        None
    } else {
        Some(timeout_ms)
    };
    let _ = std::thread::Builder::new()
        .name(format!("job-watch-{}", entry.job_id))
        .spawn(move || {
            let wait = sys::wait_for_exit(process, deadline);
            match wait {
                sys::WAIT_TIMEOUT => {
                    if let Err(error) = entry.job_object.terminate(1) {
                        tracing::warn!(
                            job_id = %entry.job_id,
                            error = %error,
                            "PLAN-0393: timeout terminate failed"
                        );
                    }
                    let code = reap_child(&entry);
                    entry.finish(JobStatus::TimedOut, code);
                }
                sys::WAIT_OBJECT_0 => {
                    let code = reap_child(&entry);
                    let status = if entry.cancel_requested.load(Ordering::SeqCst) {
                        JobStatus::Cancelled
                    } else if code == Some(0) {
                        JobStatus::Succeeded
                    } else {
                        JobStatus::Failed
                    };
                    entry.finish(status, code);
                }
                other => {
                    tracing::warn!(
                        job_id = %entry.job_id,
                        wait_result = other,
                        "PLAN-0393: unexpected process wait result"
                    );
                    entry.finish(JobStatus::Failed, None);
                }
            }
        });
}

/// Waits (bounded by the cancel timeout) until the job object reports no
/// process; records a `taskkill` fallback when the default path fails.
struct TerminateReport {
    confirmed: bool,
    reclaimed: u32,
    taskkill_fallback: bool,
}

fn terminate_and_confirm(entry: &Arc<JobEntry>) -> TerminateReport {
    let before = entry.job_object.pids().unwrap_or_default();
    let default_ok = entry.job_object.terminate(1).is_ok();
    let mut fallback = !default_ok;
    if fallback {
        taskkill_tree(entry);
    }
    let mut confirmed = wait_until_empty(entry, CANCEL_CONFIRM_TIMEOUT);
    if !confirmed {
        // The default path did not clear the tree: record the fallback and try
        // once more before reporting `unconfirmed`.
        if !fallback {
            fallback = true;
            taskkill_tree(entry);
        }
        confirmed = wait_until_empty(entry, CANCEL_CONFIRM_TIMEOUT);
    }
    if fallback {
        tracing::warn!(
            job_id = %entry.job_id,
            confirmed,
            "PLAN-0393: cancel used the recorded taskkill fallback"
        );
    }
    TerminateReport {
        confirmed,
        reclaimed: before.len() as u32,
        taskkill_fallback: fallback,
    }
}

fn wait_until_empty(entry: &Arc<JobEntry>, timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    loop {
        match entry.job_object.pids() {
            Ok(pids) if pids.is_empty() => return true,
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(
                    job_id = %entry.job_id,
                    error = %error,
                    "PLAN-0393: job object pid query failed while confirming cancel"
                );
            }
        }
        if started.elapsed() >= timeout {
            if let Ok(active) = entry.job_object.active_processes() {
                tracing::warn!(
                    job_id = %entry.job_id,
                    active,
                    "PLAN-0393: job tree still active after the cancel window"
                );
            }
            return false;
        }
        std::thread::sleep(CANCEL_POLL_INTERVAL);
    }
}

fn taskkill_tree(entry: &Arc<JobEntry>) {
    let pid = entry
        .child
        .lock()
        .expect("job child poisoned")
        .as_ref()
        .map(|child| child.id());
    let Some(pid) = pid else {
        return;
    };
    let result = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match result {
        Ok(status) if status.success() => {}
        Ok(status) => tracing::warn!(
            job_id = %entry.job_id,
            code = status.code().unwrap_or(-1),
            "PLAN-0393: taskkill fallback did not report success"
        ),
        Err(error) => tracing::warn!(
            job_id = %entry.job_id,
            error = %error,
            "PLAN-0393: taskkill fallback could not be spawned"
        ),
    }
}

fn reap_child(entry: &Arc<JobEntry>) -> Option<i32> {
    let mut guard = entry.child.lock().expect("job child poisoned");
    let Some(child) = guard.as_mut() else {
        return entry.state.lock().expect("job state poisoned").exit_code;
    };
    match child.wait() {
        Ok(status) => status.code(),
        Err(error) => {
            tracing::warn!(
                job_id = %entry.job_id,
                error = %error,
                "PLAN-0393: child reap failed"
            );
            None
        }
    }
}

fn build_command(plan: &LaunchPlan) -> Command {
    if plan.shell {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(&plan.program).args(&plan.args);
        command
    } else {
        let mut command = Command::new(&plan.program);
        command.args(&plan.args);
        command
    }
}

/// The `cwd` must resolve inside the authorized grants; anything else fails
/// closed (spec invariant #2).
fn validate_cwd(plan: &LaunchPlan) -> Result<PathBuf, JobEngineError> {
    let candidate = match plan.cwd.clone() {
        Some(path) if !path.as_os_str().is_empty() => path,
        _ => plan
            .grants
            .read_write_roots
            .first()
            .cloned()
            .ok_or_else(|| {
                JobEngineError::InvalidPath(
                    "launch plan has no cwd and no writable grant".to_string(),
                )
            })?,
    };
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| JobEngineError::InvalidPath(format!("cwd is not accessible: {error}")))?;
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.extend(plan.grants.read_write_roots.iter().cloned());
    roots.extend(plan.grants.read_only_roots.iter().cloned());
    let normalized = normalize_path(&canonical);
    let allowed = roots.iter().any(|root| {
        fs::canonicalize(root)
            .map(|canonical_root| path_is_within(&normalized, &normalize_path(&canonical_root)))
            .unwrap_or(false)
    });
    if allowed {
        Ok(canonical)
    } else {
        Err(JobEngineError::InvalidPath(format!(
            "cwd {} is outside the authorized grants",
            canonical.display()
        )))
    }
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn path_is_within(candidate: &str, root: &str) -> bool {
    if candidate == root {
        return true;
    }
    candidate
        .strip_prefix(root)
        .map(|rest| rest.starts_with('\\'))
        .unwrap_or(false)
}

fn sanitize_job_id(job_id: &str) -> String {
    let mut sanitized: String = job_id
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == '-' || value == '_' {
                value
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    if sanitized.is_empty() {
        sanitized.push_str("job");
    }
    sanitized
}

fn iso8601(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Captures a stream into `path`, keeping at most [`STREAM_CAP_BYTES`] and
/// draining the rest so the child never blocks on a full pipe.
fn pump_stream<R: Read>(mut reader: R, path: &Path, counters: &OutputCounters) {
    let mut file = match OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => file,
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "PLAN-0393: job output file open failed; draining stream instead"
            );
            drain(&mut reader);
            counters.truncated.store(true, Ordering::Relaxed);
            return;
        }
    };
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let stored = counters.bytes.load(Ordering::Relaxed);
                if stored < STREAM_CAP_BYTES {
                    let remaining = STREAM_CAP_BYTES - stored;
                    let write_len = (read as u64).min(remaining) as usize;
                    if let Err(error) = file.write_all(&buffer[..write_len]) {
                        tracing::warn!(
                            path = %path.display(),
                            error = %error,
                            "PLAN-0393: job output write failed"
                        );
                        counters.truncated.store(true, Ordering::Relaxed);
                        drain(&mut reader);
                        break;
                    }
                    counters
                        .bytes
                        .fetch_add(write_len as u64, Ordering::Relaxed);
                    if write_len < read
                        || counters.bytes.load(Ordering::Relaxed) >= STREAM_CAP_BYTES
                    {
                        counters.truncated.store(true, Ordering::Relaxed);
                    }
                } else {
                    counters.truncated.store(true, Ordering::Relaxed);
                }
            }
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "PLAN-0393: job output read failed"
                );
                break;
            }
        }
    }
    let _ = file.flush();
}

fn drain<R: Read>(reader: &mut R) {
    let mut buffer = [0u8; 16 * 1024];
    while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 {
            break;
        }
    }
}

fn read_output_file(
    path: &Path,
    stream: OutputStream,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<OutputChunk, JobEngineError> {
    let metadata = fs::metadata(path).map_err(|error| {
        JobEngineError::OutputMissing(format!("job output is not available: {error}"))
    })?;
    let length = metadata.len() as usize;
    let start = offset.unwrap_or(0).min(length);
    let limit = limit.unwrap_or(READ_DEFAULT_LIMIT).min(READ_MAX_LIMIT);
    let mut file = File::open(path).map_err(|error| {
        JobEngineError::OutputMissing(format!("job output is not readable: {error}"))
    })?;
    file.seek(SeekFrom::Start(start as u64)).map_err(|error| {
        JobEngineError::OutputMissing(format!("job output seek failed: {error}"))
    })?;
    let mut buffer = vec![0u8; limit];
    let mut filled = 0usize;
    while filled < limit {
        let read = file.read(&mut buffer[filled..]).map_err(|error| {
            JobEngineError::OutputMissing(format!("job output read failed: {error}"))
        })?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    // Never split a multi-byte rune at either edge of the chunk.
    let mut begin = 0usize;
    while begin < filled && begin < 4 && !is_boundary_byte(buffer[begin]) {
        begin += 1;
    }
    let end = begin + complete_utf8_len(&buffer[begin..filled]);
    let data = String::from_utf8_lossy(&buffer[begin..end]).into_owned();
    let size_bytes = end - begin;
    Ok(OutputChunk {
        stream: stream.as_str().to_string(),
        offset: start,
        next_offset: start + end,
        size_bytes,
        truncated: length as u64 >= STREAM_CAP_BYTES,
        data,
    })
}

/// Longest prefix length that ends on a UTF-8 rune boundary.
fn complete_utf8_len(bytes: &[u8]) -> usize {
    let mut index = bytes.len();
    let mut inspected = 0usize;
    while inspected < 4 && index > 0 {
        let byte = bytes[index - 1];
        if is_boundary_byte(byte) {
            let expected = utf8_rune_len(byte);
            let available = bytes.len() - (index - 1);
            return if available >= expected {
                bytes.len()
            } else {
                index - 1
            };
        }
        index -= 1;
        inspected += 1;
    }
    bytes.len()
}

fn utf8_rune_len(lead: u8) -> usize {
    if lead & 0x80 == 0 {
        1
    } else if lead & 0xE0 == 0xC0 {
        2
    } else if lead & 0xF0 == 0xE0 {
        3
    } else if lead & 0xF8 == 0xF0 {
        4
    } else {
        1
    }
}

fn is_boundary_byte(byte: u8) -> bool {
    (byte & 0xC0) != 0x80
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join("xihe-job-engine-tests")
            .join(format!("{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    #[test]
    fn sanitize_job_id_removes_path_separators() {
        assert_eq!(sanitize_job_id("a/b\\c:d"), "a_b_c_d");
        assert_eq!(sanitize_job_id(""), "job");
    }

    #[test]
    fn path_is_within_requires_a_directory_boundary() {
        assert!(path_is_within("h:\\ws\\sub", "h:\\ws"));
        assert!(path_is_within("h:\\ws", "h:\\ws"));
        assert!(!path_is_within("h:\\wss", "h:\\ws"));
        assert!(!path_is_within("h:\\other", "h:\\ws"));
    }

    #[test]
    fn pump_stream_caps_output_and_drains_the_reader() {
        let root = temp_root("pump-cap");
        let path = root.join("stdout.log");
        let counters = OutputCounters::default();
        let payload = vec![b'a'; (STREAM_CAP_BYTES as usize) + 4096];
        pump_stream(Cursor::new(payload), &path, &counters);
        let stored = fs::metadata(&path).expect("file").len();
        assert_eq!(stored, STREAM_CAP_BYTES);
        assert_eq!(counters.bytes.load(Ordering::Relaxed), STREAM_CAP_BYTES);
        assert!(counters.truncated.load(Ordering::Relaxed));
    }

    #[test]
    fn pump_stream_keeps_short_output_verbatim() {
        let root = temp_root("pump-short");
        let path = root.join("stdout.log");
        let counters = OutputCounters::default();
        pump_stream(Cursor::new(b"hello".to_vec()), &path, &counters);
        assert_eq!(fs::read(&path).expect("file"), b"hello");
        assert!(!counters.truncated.load(Ordering::Relaxed));
    }

    #[test]
    fn read_output_file_marks_truncated_at_the_boundary() {
        // fixture output-truncated-boundary: 2 MiB produced, 1 MiB read.
        let root = temp_root("read-boundary");
        let path = root.join("stdout.log");
        let file = File::create(&path).expect("file");
        file.set_len(2 * 1024 * 1024).expect("set len");
        let chunk =
            read_output_file(&path, OutputStream::Stdout, Some(0), Some(READ_MAX_LIMIT)).unwrap();
        assert!(chunk.truncated);
        assert_eq!(chunk.next_offset - chunk.offset, READ_MAX_LIMIT);
        assert_eq!(chunk.stream, "stdout");
    }

    #[test]
    fn read_output_file_cursor_is_monotonic() {
        let root = temp_root("read-monotonic");
        let path = root.join("stdout.log");
        fs::write(&path, "abcdefghij").expect("write");
        let first = read_output_file(&path, OutputStream::Stdout, Some(0), Some(4)).unwrap();
        let second = read_output_file(
            &path,
            OutputStream::Stdout,
            Some(first.next_offset),
            Some(4),
        )
        .unwrap();
        assert!(second.next_offset >= first.next_offset);
        assert!(second.offset >= first.offset);
        assert_eq!(format!("{}{}", first.data, second.data), "abcdefgh");
    }

    #[test]
    fn read_output_file_does_not_split_multibyte_runes() {
        let root = temp_root("read-runes");
        let path = root.join("stdout.log");
        // "中中" is 6 bytes; reading 4 bytes must stop at a rune boundary.
        fs::write(&path, "中中").expect("write");
        let chunk = read_output_file(&path, OutputStream::Stdout, Some(0), Some(4)).unwrap();
        assert_eq!(chunk.size_bytes, 3);
        assert_eq!(chunk.data, "中");
        assert_eq!(chunk.next_offset, 3);
    }

    #[test]
    fn snapshot_serialization_has_no_transport_detail_keys() {
        let root = temp_root("keys");
        let engine = JobEngine::new("boot", root);
        let snapshot = JobSnapshot {
            status: JobStatus::Running,
            exit_code: None,
            started_at: None,
            finished_at: None,
            stdout_bytes: 0,
            stderr_bytes: 0,
            truncated: false,
            cleanup_status: CLEANUP_NOT_STARTED.to_string(),
        };
        let value = serde_json::to_value(&snapshot).expect("serialize");
        let object = value.as_object().expect("object");
        for forbidden in [
            "pid",
            "wrapperPid",
            "policyPath",
            "containerPath",
            "containerId",
            "networkMode",
            "sandboxUrl",
        ] {
            assert!(!object.contains_key(forbidden), "leaked key {forbidden}");
        }
        assert_eq!(engine.active_count(), 0);
    }

    #[cfg(windows)]
    mod windows_processes {
        use super::*;

        fn plan_for(arguments: &[&str], timeout_ms: u64) -> LaunchPlan {
            let root = std::env::temp_dir();
            LaunchPlan {
                backend_kind: "windows-host".to_string(),
                backend_revision: "test".to_string(),
                program: "cmd".to_string(),
                args: arguments.iter().map(|value| value.to_string()).collect(),
                cwd: Some(root.clone()),
                env: BTreeMap::new(),
                timeout_ms,
                shell: false,
                grants: FilesystemPolicy {
                    read_only_roots: Vec::new(),
                    read_write_roots: vec![root],
                },
                policy_artifact: None,
            }
        }

        fn wait_terminal(engine: &JobEngine, job_id: &str) -> JobSnapshot {
            let started = std::time::Instant::now();
            loop {
                let snapshot = engine.snapshot(job_id).expect("snapshot");
                if snapshot.status.is_terminal() {
                    return snapshot;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(20),
                    "job {job_id} did not reach a terminal state"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        #[test]
        fn start_captures_output_and_exit_code() {
            let engine = JobEngine::new("boot-test", temp_root("start"));
            let job_id = uuid::Uuid::new_v4().to_string();
            let handle = engine
                .start(&job_id, plan_for(&["/C", "echo hello & exit 3"], 0))
                .expect("start");
            assert!(!handle.opaque_handle_id.is_empty());
            assert_eq!(handle.runtime_boot_id, "boot-test");
            let snapshot = wait_terminal(&engine, &job_id);
            assert_eq!(snapshot.status, JobStatus::Failed);
            assert_eq!(snapshot.exit_code, Some(3));
            let chunk = engine
                .read_output(&job_id, "stdout", Some(0), None)
                .expect("output");
            assert!(chunk.data.contains("hello"));
            let cleanup = engine.cleanup(&job_id).expect("cleanup");
            assert_eq!(cleanup.outcome, CleanupOutcome::Completed);
            assert!(!engine.output_root().join(sanitize_job_id(&job_id)).exists());
        }

        #[test]
        fn reachable_handle_reports_running_and_succeeded() {
            let engine = JobEngine::new("boot-test", temp_root("success"));
            let job_id = uuid::Uuid::new_v4().to_string();
            engine
                .start(&job_id, plan_for(&["/C", "exit 0"], 0))
                .expect("start");
            let snapshot = wait_terminal(&engine, &job_id);
            assert_eq!(snapshot.status, JobStatus::Succeeded);
            assert_eq!(snapshot.exit_code, Some(0));
            let cleanup = engine.cleanup(&job_id).expect("cleanup");
            assert_eq!(cleanup.outcome, CleanupOutcome::Completed);
        }

        #[test]
        fn duplicate_start_is_idempotent() {
            let engine = JobEngine::new("boot-test", temp_root("idempotent"));
            let job_id = uuid::Uuid::new_v4().to_string();
            let first = engine
                .start(&job_id, plan_for(&["/C", "ping -n 3 127.0.0.1 > nul"], 0))
                .expect("start");
            let second = engine
                .start(&job_id, plan_for(&["/C", "exit 0"], 0))
                .expect("start again");
            assert_eq!(first.opaque_handle_id, second.opaque_handle_id);
            let cancel = engine.cancel(&job_id).expect("cancel");
            assert_eq!(cancel.outcome, CancelOutcome::Cancelled);
            assert!(cancel.changed);
            engine.cleanup(&job_id).expect("cleanup");
        }

        #[test]
        fn cancel_after_terminal_is_already_terminal() {
            let engine = JobEngine::new("boot-test", temp_root("terminal"));
            let job_id = uuid::Uuid::new_v4().to_string();
            engine
                .start(&job_id, plan_for(&["/C", "exit 0"], 0))
                .expect("start");
            wait_terminal(&engine, &job_id);
            let cancel = engine.cancel(&job_id).expect("cancel");
            assert_eq!(cancel.outcome, CancelOutcome::AlreadyTerminal);
            assert!(!cancel.changed);
            engine.cleanup(&job_id).expect("cleanup");
        }

        #[test]
        fn cancel_missing_handle_is_not_found() {
            let engine = JobEngine::new("boot-test", temp_root("missing"));
            match engine.cancel("missing-job") {
                Err(JobEngineError::NotFound) => {}
                other => panic!("expected not found, got {other:?}"),
            }
        }

        #[test]
        fn timeout_maps_to_timed_out() {
            let engine = JobEngine::new("boot-test", temp_root("timeout"));
            let job_id = uuid::Uuid::new_v4().to_string();
            engine
                .start(
                    &job_id,
                    plan_for(&["/C", "ping -n 30 127.0.0.1 > nul"], 400),
                )
                .expect("start");
            let snapshot = wait_terminal(&engine, &job_id);
            assert_eq!(snapshot.status, JobStatus::TimedOut);
            engine.cleanup(&job_id).expect("cleanup");
        }

        #[test]
        fn cwd_through_a_directory_link_escape_fails_closed() {
            // A junction/symlink inside the workspace must not let a job run
            // outside the grants: the engine canonicalizes before comparing.
            let root = temp_root("link-escape");
            let outside = temp_root("link-outside");
            let link = root.join("escape");
            let linked = {
                #[cfg(windows)]
                {
                    let status = std::process::Command::new("cmd")
                        .args([
                            "/C",
                            "mklink",
                            "/J",
                            &link.to_string_lossy(),
                            &outside.to_string_lossy(),
                        ])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                    status.map(|value| value.success()).unwrap_or(false)
                }
                #[cfg(not(windows))]
                {
                    std::os::unix::fs::symlink(&outside, &link).is_ok()
                }
            };
            assert!(linked, "could not create the escape link");
            let engine = JobEngine::new("boot-test", temp_root("link-escape-jobs"));
            let job_id = uuid::Uuid::new_v4().to_string();
            let mut plan = plan_for(&["/C", "exit 0"], 0);
            plan.cwd = Some(link.clone());
            plan.grants = FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![root.clone()],
            };
            match engine.start(&job_id, plan) {
                Err(JobEngineError::InvalidPath(_)) => {}
                other => panic!("expected fail-closed for a linked cwd, got {other:?}"),
            }
            assert_eq!(engine.active_count(), 0);
            let _ = fs::remove_dir(&link);
        }

        #[test]
        fn cwd_outside_grants_fails_closed() {
            let engine = JobEngine::new("boot-test", temp_root("grant"));
            let job_id = uuid::Uuid::new_v4().to_string();
            let mut plan = plan_for(&["/C", "exit 0"], 0);
            plan.grants = FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![std::env::temp_dir().join("definitely-not-this-tree")],
            };
            match engine.start(&job_id, plan) {
                Err(JobEngineError::InvalidPath(_)) => {}
                other => panic!("expected fail-closed, got {other:?}"),
            }
            assert_eq!(engine.active_count(), 0);
        }

        #[test]
        fn reap_expired_removes_output_dirs() {
            let engine = JobEngine::new("boot-test", temp_root("reap"));
            let job_id = uuid::Uuid::new_v4().to_string();
            engine
                .start(&job_id, plan_for(&["/C", "exit 0"], 0))
                .expect("start");
            wait_terminal(&engine, &job_id);
            let dir = engine.output_root().join(sanitize_job_id(&job_id));
            assert!(dir.exists());
            // Freshly finished jobs stay until the TTL elapses.
            assert_eq!(engine.reap_expired(), 0);
            assert_eq!(engine.reap_orphan_output_dirs(), 0);
            engine.cleanup(&job_id).expect("cleanup");
            assert!(!dir.exists());
        }

        #[test]
        fn orphan_output_dirs_are_reclaimed() {
            let root = temp_root("orphan");
            let orphan = root.join("dead-job");
            fs::create_dir_all(&orphan).expect("orphan dir");
            let engine = JobEngine::new("boot-test", root);
            assert_eq!(engine.reap_orphan_output_dirs(), 1);
            assert!(!orphan.exists());
        }
    }
}
