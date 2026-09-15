//! Host-side shadow-git checkpoint engine (PLAN-0328 M2 W1).
//!
//! Operating model (spec `snapshot-rollback.md` §6, decisions #13/#14/#40/#43):
//!
//! - the shadow repository lives at `<hostRoot>/.xihe-shadow/<workspaceId>.git`,
//!   outside the workspace and never bind-mounted into the sandbox;
//! - `GIT_DIR` is the shadow and `core.worktree` points at `<hostRoot>/<workspaceId>`,
//!   so the user's own `.git` is never read or written;
//! - every git call runs with an isolated environment (`GIT_CONFIG_GLOBAL` /
//!   `GIT_CONFIG_SYSTEM` pointed at the OS null device, `--no-optional-locks`) and a
//!   per-run `GIT_INDEX_FILE`, so no user config, hook or lock is involved;
//! - checkpoints are plumbing only: `add -A` → `write-tree` → `commit-tree` →
//!   `refs/xihe/<runId>/{base,end}`; worktree, user index and user branches stay
//!   untouched.
//!
//! Rollback itself (M3) is out of scope for this module; it consumes the refs and
//! change lists produced here.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use thiserror::Error;
use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::error::RuntimeError;
use crate::storage;

/// Directory under `hostRoot` that holds all shadow repositories.
pub const SHADOW_DIR_NAME: &str = ".xihe-shadow";

/// Minimum usable host git version (spec §6.0).
pub const MIN_GIT_VERSION: (u32, u32) = (2, 20);

/// Default retention: keep the newest N sealed runs per workspace (decision #10).
pub const DEFAULT_RETENTION_MAX_RUNS: usize = 50;

/// Default retention: delete sealed runs older than this (decision #10).
pub const DEFAULT_RETENTION_TTL_DAYS: u64 = 30;

/// Default size cap for untracked files entering the snapshot (decision #14).
pub const DEFAULT_MAX_UNTRACKED_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Explicit exclusion patterns beyond the workspace `.gitignore` (decision #14).
///
/// Credential material must never enter the shadow object store; generated and
/// Runtime-infrastructure paths are excluded so checkpoints stay noise-free.
pub const STATIC_EXCLUDE_PATTERNS: &[&str] = &[
    "*.pem",
    "*.key",
    "*.p12",
    ".npmrc",
    ".netrc",
    "id_rsa*",
    "node_modules/",
    "dist/",
    "build/",
    ".cache/",
    ".tmp/",
    ".env",
    ".xihe-snapshots/",
    ".xihe-sentinel",
    ".xihe-probe-writable",
    ".xihe-container-runtime.log",
    ".xihe-container-runtime.pid",
    ".xihe-bridge-*.pid",
    ".xihe-shadow/",
];

const BOOTSTRAP_MARKER: &str = ".xihe-bootstrapped";
const PROBE_RETRY_BACKOFF: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const GIT_CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RUN_ID_LEN: usize = 128;
const MAX_DYNAMIC_EXCLUDES: usize = 4096;
const LOCK_MAP_PRUNE_THRESHOLD: usize = 1024;

#[derive(Debug, Error)]
pub enum CheckpointError {
    #[error("host git is unavailable for checkpointing: {0}")]
    GitUnavailable(String),

    #[error("invalid {kind} {value:?}: {detail}")]
    InvalidIdentifier {
        kind: &'static str,
        value: String,
        detail: String,
    },

    #[error("workspace directory does not exist: {0}")]
    WorkspaceMissing(String),

    #[error("shadow checkpoint run not found: {0}")]
    RunNotFound(String),

    #[error("shadow checkpoint run is not sealed: {0}")]
    NotSealed(String),

    #[error("git command failed [{command}]: {detail}")]
    GitCommand { command: String, detail: String },

    #[error("checkpoint io error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<CheckpointError> for RuntimeError {
    fn from(error: CheckpointError) -> Self {
        match error {
            CheckpointError::Io(io) => RuntimeError::Io(io),
            other => RuntimeError::Command(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, CheckpointError>;

/// Structured host-git capability result (spec §6.0; never panics).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitCapability {
    pub available: bool,
    pub version: Option<String>,
    pub detail: String,
}

/// One entry of a checkpoint change set (`git diff --name-status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangedFile {
    /// Raw git status, e.g. `M`, `A`, `D`, `R100`; the first character is the class.
    pub status: String,
    /// Workspace-relative path with forward slashes (destination for renames).
    pub path: String,
    /// Source path for renames/copies.
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BaseOutcome {
    pub base_commit: String,
    /// `false` when an existing `refs/xihe/<runId>/base` was returned (idempotent hit).
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SealOutcome {
    pub base_commit: String,
    pub end_commit: String,
    pub changed_files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RetentionReport {
    /// Sealed runs deleted oldest-first.
    pub deleted_runs: Vec<String>,
    pub kept_sealed: usize,
    /// Unsealed runs are never deleted by retention.
    pub kept_unsealed: usize,
    pub gc_ran: bool,
}

struct GitOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Default)]
struct ProbeCache {
    capability: Option<GitCapability>,
    checked_at: Option<Instant>,
}

#[derive(Debug, Clone)]
struct ShadowRef {
    run_id: String,
    kind: String,
    epoch: i64,
}

/// Shadow-git checkpoint engine for one host root.
///
/// All operations serialize per workspace through an in-process mutex map. PLAN-0328
/// M2 W2 replaces/augments that seam with the workspace mutation lease (decision #8);
/// see `lock_workspace`.
pub struct ShadowGit {
    host_root: PathBuf,
    git_binary: String,
    locks: StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    probe_cache: StdMutex<ProbeCache>,
    max_untracked_file_bytes: u64,
    call_timeout: Duration,
}

impl ShadowGit {
    pub fn new(host_root: impl Into<PathBuf>) -> Self {
        Self {
            host_root: host_root.into(),
            git_binary: "git".to_string(),
            locks: StdMutex::new(HashMap::new()),
            probe_cache: StdMutex::new(ProbeCache::default()),
            max_untracked_file_bytes: DEFAULT_MAX_UNTRACKED_FILE_BYTES,
            call_timeout: GIT_CALL_TIMEOUT,
        }
    }

    pub fn with_git_binary(mut self, git_binary: impl Into<String>) -> Self {
        self.git_binary = git_binary.into();
        self
    }

    pub fn with_max_untracked_file_bytes(mut self, max_bytes: u64) -> Self {
        self.max_untracked_file_bytes = max_bytes;
        self
    }

    pub fn with_call_timeout(mut self, timeout: Duration) -> Self {
        self.call_timeout = timeout;
        self
    }

    pub fn host_root(&self) -> &Path {
        &self.host_root
    }

    /// `<hostRoot>/.xihe-shadow/<workspaceId>.git`.
    pub fn shadow_git_dir(&self, workspace_id: &str) -> Result<PathBuf> {
        validate_workspace_id(workspace_id)?;
        Ok(self
            .host_root
            .join(SHADOW_DIR_NAME)
            .join(format!("{workspace_id}.git")))
    }

    /// `<hostRoot>/<workspaceId>` (same layout as `storage::resolve_host_path`).
    pub fn work_tree(&self, workspace_id: &str) -> Result<PathBuf> {
        validate_workspace_id(workspace_id)?;
        Ok(self.host_root.join(workspace_id))
    }

    /// Cached host-git probe (`git --version` ≥ 2.20). Failures are retried after a
    /// backoff; the result is a structured value and never panics, even when git is
    /// missing entirely.
    pub async fn probe(&self) -> GitCapability {
        {
            let cache = self
                .probe_cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(capability) = &cache.capability {
                if capability.available {
                    return capability.clone();
                }
                if cache
                    .checked_at
                    .is_some_and(|at| at.elapsed() < PROBE_RETRY_BACKOFF)
                {
                    return capability.clone();
                }
            }
        }
        let capability = self.run_probe().await;
        let mut cache = self
            .probe_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        cache.capability = Some(capability.clone());
        cache.checked_at = Some(Instant::now());
        capability
    }

    /// Create the run base checkpoint. Idempotent per run: an existing
    /// `refs/xihe/<runId>/base` is returned unchanged.
    pub async fn create_base(
        &self,
        workspace_id: &str,
        run_id: &str,
        actor: &str,
        call_id: &str,
    ) -> Result<BaseOutcome> {
        validate_run_id(run_id)?;
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        let _guard = self.lock_workspace(workspace_id).await;
        self.require_git().await?;
        if !work_tree.is_dir() {
            return Err(CheckpointError::WorkspaceMissing(normalize_path_for_git(
                &work_tree,
            )));
        }
        self.ensure_initialized(&shadow, &work_tree).await?;

        let env = self.isolated_env(&shadow, &work_tree, None);
        let base_ref = format!("refs/xihe/{run_id}/base");
        if let Some(existing) = self.rev_parse(&env, &base_ref).await? {
            return Ok(BaseOutcome {
                base_commit: existing,
                created: false,
            });
        }

        let index = phase_index_path(&shadow, run_id, "base");
        remove_file_if_exists(&index).await?;
        self.stage_phase(&shadow, &work_tree, run_id, "base", &index, None)
            .await?;
        let index_env = self.isolated_env(&shadow, &work_tree, Some(&index));
        let tree = self.write_tree(&index_env).await?;
        let message = base_message(run_id, actor, call_id);
        let base_commit = self.commit_tree(&env, &tree, None, &message).await?;
        self.update_ref(&env, &base_ref, &base_commit).await?;
        info!(
            workspace_id,
            run_id,
            base_commit = %base_commit,
            "shadow checkpoint base created"
        );
        Ok(BaseOutcome {
            base_commit,
            created: true,
        })
    }

    /// Seal the run: snapshot the end tree, commit it on top of the base and record
    /// `refs/xihe/<runId>/end`. Idempotent: an existing `end` ref is returned with its
    /// recomputed change set.
    pub async fn seal(&self, workspace_id: &str, run_id: &str) -> Result<SealOutcome> {
        validate_run_id(run_id)?;
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        let _guard = self.lock_workspace(workspace_id).await;
        self.require_git().await?;
        if !shadow.is_dir() {
            return Err(CheckpointError::RunNotFound(run_id.to_string()));
        }

        let env = self.isolated_env(&shadow, &work_tree, None);
        let base_ref = format!("refs/xihe/{run_id}/base");
        let end_ref = format!("refs/xihe/{run_id}/end");
        let base_commit = self
            .rev_parse(&env, &base_ref)
            .await?
            .ok_or_else(|| CheckpointError::RunNotFound(run_id.to_string()))?;
        if let Some(end_commit) = self.rev_parse(&env, &end_ref).await? {
            let changed_files = self
                .changed_files_for(&env, &base_commit, &end_commit)
                .await?;
            return Ok(SealOutcome {
                base_commit,
                end_commit,
                changed_files,
            });
        }

        let base_index = phase_index_path(&shadow, run_id, "base");
        let reference_index = base_index.is_file().then_some(base_index.as_path());
        let end_index = phase_index_path(&shadow, run_id, "end");
        remove_file_if_exists(&end_index).await?;
        self.stage_phase(
            &shadow,
            &work_tree,
            run_id,
            "end",
            &end_index,
            reference_index,
        )
        .await?;
        let end_env = self.isolated_env(&shadow, &work_tree, Some(&end_index));
        let tree = self.write_tree(&end_env).await?;
        let message = format!("run/{run_id} end\n");
        let end_commit = self
            .commit_tree(&env, &tree, Some(&base_commit), &message)
            .await?;
        self.update_ref(&env, &end_ref, &end_commit).await?;
        let changed_files = self
            .changed_files_for(&env, &base_commit, &end_commit)
            .await?;
        self.cleanup_run_scratch(&shadow, run_id).await;
        info!(
            workspace_id,
            run_id,
            base_commit = %base_commit,
            end_commit = %end_commit,
            changed = changed_files.len(),
            "shadow checkpoint sealed"
        );
        Ok(SealOutcome {
            base_commit,
            end_commit,
            changed_files,
        })
    }

    /// Current `(base, end)` commit ids of one run; `None` when the ref is absent.
    ///
    /// PLAN-0328 M2 W2: read-only projection for the status endpoint. The engine
    /// stays the only writer of these refs.
    pub async fn run_refs(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<(Option<String>, Option<String>)> {
        validate_run_id(run_id)?;
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        let _guard = self.lock_workspace(workspace_id).await;
        if !shadow.is_dir() {
            return Ok((None, None));
        }
        self.require_git().await?;
        let env = self.isolated_env(&shadow, &work_tree, None);
        let base = self
            .rev_parse(&env, &format!("refs/xihe/{run_id}/base"))
            .await?;
        let end = self
            .rev_parse(&env, &format!("refs/xihe/{run_id}/end"))
            .await?;
        Ok((base, end))
    }

    /// Change set of a sealed run. Unsealed runs are reported explicitly instead of
    /// pretending to have an empty diff.
    pub async fn changed_files(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<Vec<ChangedFile>> {
        validate_run_id(run_id)?;
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        let _guard = self.lock_workspace(workspace_id).await;
        self.require_git().await?;
        if !shadow.is_dir() {
            return Err(CheckpointError::RunNotFound(run_id.to_string()));
        }
        let env = self.isolated_env(&shadow, &work_tree, None);
        let base_commit = self
            .rev_parse(&env, &format!("refs/xihe/{run_id}/base"))
            .await?
            .ok_or_else(|| CheckpointError::RunNotFound(run_id.to_string()))?;
        let end_commit = self
            .rev_parse(&env, &format!("refs/xihe/{run_id}/end"))
            .await?
            .ok_or_else(|| CheckpointError::NotSealed(run_id.to_string()))?;
        self.changed_files_for(&env, &base_commit, &end_commit)
            .await
    }

    /// Delete the refs and scratch files of one run. Returns the ref names removed.
    pub async fn drop_refs(&self, workspace_id: &str, run_id: &str) -> Result<Vec<String>> {
        validate_run_id(run_id)?;
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        let _guard = self.lock_workspace(workspace_id).await;
        self.require_git().await?;
        if !shadow.is_dir() {
            return Ok(Vec::new());
        }
        let env = self.isolated_env(&shadow, &work_tree, None);
        let mut dropped = Vec::new();
        for suffix in ["base", "end"] {
            let name = format!("refs/xihe/{run_id}/{suffix}");
            if self.rev_parse(&env, &name).await?.is_some() {
                self.run_git_checked(&["update-ref", "-d", &name], &env, None, self.call_timeout)
                    .await?;
                dropped.push(name);
            }
        }
        self.cleanup_run_scratch(&shadow, run_id).await;
        Ok(dropped)
    }

    /// Retention (decision #10): delete sealed runs oldest-first beyond `max_runs` or
    /// older than `ttl_days`, then `reflog expire` + `gc --prune=now`.
    ///
    /// Unsealed runs (`base` without `end`) are never deleted. Runs with identical
    /// timestamps are ordered by run id so oldest-first deletion stays deterministic.
    pub async fn retention_gc(
        &self,
        workspace_id: &str,
        max_runs: usize,
        ttl_days: u64,
    ) -> Result<RetentionReport> {
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        let _guard = self.lock_workspace(workspace_id).await;
        self.require_git().await?;
        let mut report = RetentionReport::default();
        if !shadow.is_dir() {
            return Ok(report);
        }
        let env = self.isolated_env(&shadow, &work_tree, None);
        let stdout = self
            .run_git_checked(
                &[
                    "for-each-ref",
                    "--format=%(refname)\t%(creatordate:raw)",
                    "refs/xihe/",
                ],
                &env,
                None,
                self.call_timeout,
            )
            .await?;
        let refs = parse_xihe_refs(&stdout);

        let base_runs: HashSet<&str> = refs
            .iter()
            .filter(|row| row.kind == "base")
            .map(|row| row.run_id.as_str())
            .collect();
        let mut sealed: Vec<(String, i64)> = refs
            .iter()
            .filter(|row| row.kind == "end" && base_runs.contains(row.run_id.as_str()))
            .map(|row| (row.run_id.clone(), row.epoch))
            .collect();
        sealed.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        let ttl_seconds = i64::try_from(ttl_days.saturating_mul(86_400)).unwrap_or(i64::MAX);
        let expired_before = now.saturating_sub(ttl_seconds);
        let excess = sealed.len().saturating_sub(max_runs);

        for (index, (run_id, epoch)) in sealed.iter().enumerate() {
            if index < excess || *epoch <= expired_before {
                report.deleted_runs.push(run_id.clone());
            } else {
                report.kept_sealed += 1;
            }
        }
        report.kept_unsealed = base_runs
            .iter()
            .filter(|run_id| {
                !refs
                    .iter()
                    .any(|row| row.kind == "end" && row.run_id == **run_id)
            })
            .count();

        for run_id in &report.deleted_runs {
            for suffix in ["base", "end"] {
                let name = format!("refs/xihe/{run_id}/{suffix}");
                self.run_git_checked(&["update-ref", "-d", &name], &env, None, self.call_timeout)
                    .await?;
            }
            self.cleanup_run_scratch(&shadow, run_id).await;
        }
        if !report.deleted_runs.is_empty() {
            self.run_git_checked(
                &["reflog", "expire", "--expire=now", "--all"],
                &env,
                None,
                self.call_timeout,
            )
            .await?;
            self.run_git_checked(
                &["gc", "--prune=now", "--quiet"],
                &env,
                None,
                self.call_timeout,
            )
            .await?;
            report.gc_ran = true;
        }
        info!(
            workspace_id,
            deleted = report.deleted_runs.len(),
            kept_sealed = report.kept_sealed,
            kept_unsealed = report.kept_unsealed,
            "shadow checkpoint retention completed"
        );
        Ok(report)
    }

    /// Per-workspace serialization seam: one writer per workspace (decision #8).
    ///
    /// PLAN-0328 M2 W2 replaces the body with the workspace mutation lease; every
    /// engine operation already acquires this lock for its full duration.
    async fn lock_workspace(&self, workspace_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().unwrap_or_else(PoisonError::into_inner);
            if locks.len() > LOCK_MAP_PRUNE_THRESHOLD {
                locks.retain(|_, value| Arc::strong_count(value) > 1);
            }
            locks
                .entry(workspace_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    async fn require_git(&self) -> Result<()> {
        let capability = self.probe().await;
        if capability.available {
            Ok(())
        } else {
            Err(CheckpointError::GitUnavailable(capability.detail))
        }
    }

    async fn run_probe(&self) -> GitCapability {
        let env = self.null_config_env();
        match self
            .run_git(&["--version"], &env, None, PROBE_TIMEOUT)
            .await
        {
            Ok(output) if output.status.success() => {
                let version_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                match parse_git_version(&version_text) {
                    Some(version) if version >= MIN_GIT_VERSION => GitCapability {
                        available: true,
                        version: Some(version_text),
                        detail: "host git is available".to_string(),
                    },
                    Some(version) => GitCapability {
                        available: false,
                        version: Some(version_text),
                        detail: format!(
                            "host git {}.{} is below the required {}.{}",
                            version.0, version.1, MIN_GIT_VERSION.0, MIN_GIT_VERSION.1
                        ),
                    },
                    None => GitCapability {
                        available: false,
                        version: Some(version_text.clone()),
                        detail: format!("could not parse `git --version` output {version_text:?}"),
                    },
                }
            }
            Ok(output) => GitCapability {
                available: false,
                version: None,
                detail: format!(
                    "`git --version` exited with {:?}: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            },
            Err(error) => GitCapability {
                available: false,
                version: None,
                detail: error.to_string(),
            },
        }
    }

    async fn ensure_initialized(&self, shadow: &Path, work_tree: &Path) -> Result<()> {
        if shadow.join(BOOTSTRAP_MARKER).is_file() {
            return Ok(());
        }
        tokio::fs::create_dir_all(shadow.join("empty-hooks")).await?;
        let shadow_display = normalize_path_for_git(shadow);
        self.run_git_checked(
            &[
                "-c",
                "advice.defaultBranchName=false",
                "init",
                "--bare",
                &shadow_display,
            ],
            &self.null_config_env(),
            None,
            self.call_timeout,
        )
        .await?;

        let env = self.isolated_env(shadow, work_tree, None);
        let configs = [
            ("core.worktree", normalize_path_for_git(work_tree)),
            ("core.bare", "false".to_string()),
            ("core.autocrlf", "false".to_string()),
            ("core.filemode", "false".to_string()),
            ("core.symlinks", "true".to_string()),
            (
                "core.hooksPath",
                normalize_path_for_git(&shadow.join("empty-hooks")),
            ),
            ("gc.auto", "0".to_string()),
            ("commit.gpgsign", "false".to_string()),
            ("user.name", "xihe-checkpoint".to_string()),
            ("user.email", "checkpoint@xihe.local".to_string()),
            (
                "core.excludesFile",
                normalize_path_for_git(&shadow.join("exclude")),
            ),
        ];
        for (key, value) in configs {
            self.run_git_checked(&["config", key, &value], &env, None, self.call_timeout)
                .await?;
        }
        self.write_static_excludes(shadow).await?;
        tokio::fs::write(shadow.join(BOOTSTRAP_MARKER), b"bootstrapped\n").await?;
        info!(shadow = %shadow.display(), "shadow git repository bootstrapped");
        Ok(())
    }

    async fn write_static_excludes(&self, shadow: &Path) -> Result<()> {
        let mut content =
            String::from("# Xihe shadow checkpoint excludes (PLAN-0328 decision #14)\n");
        for pattern in STATIC_EXCLUDE_PATTERNS {
            content.push_str(pattern);
            content.push('\n');
        }
        tokio::fs::write(shadow.join("exclude"), content).await?;
        Ok(())
    }

    async fn write_phase_excludes(
        &self,
        shadow: &Path,
        run_id: &str,
        phase: &str,
        dynamic: &[String],
    ) -> Result<PathBuf> {
        let mut content = String::from("# Xihe shadow checkpoint excludes (static + per-run)\n");
        for pattern in STATIC_EXCLUDE_PATTERNS {
            content.push_str(pattern);
            content.push('\n');
        }
        for relative in dynamic {
            content.push_str(&gitignore_literal(relative));
            content.push('\n');
        }
        let path = phase_excludes_path(shadow, run_id, phase);
        tokio::fs::write(&path, content).await?;
        Ok(path)
    }

    async fn collect_oversized_untracked(
        &self,
        shadow: &Path,
        work_tree: &Path,
        reference_index: Option<&Path>,
    ) -> Result<Vec<String>> {
        let env = self.isolated_env(shadow, work_tree, reference_index);
        let stdout = self
            .run_git_checked(
                &["ls-files", "--others", "--exclude-standard", "-z"],
                &env,
                Some(work_tree),
                self.call_timeout,
            )
            .await?;
        let mut oversized = Vec::new();
        for raw in stdout.split(|byte| *byte == 0) {
            if raw.is_empty() {
                continue;
            }
            let relative = String::from_utf8_lossy(raw).into_owned();
            if relative.ends_with('/') {
                continue;
            }
            let absolute = work_tree.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            let Ok(metadata) = std::fs::symlink_metadata(&absolute) else {
                continue;
            };
            if metadata.is_file() && metadata.len() > self.max_untracked_file_bytes {
                if oversized.len() >= MAX_DYNAMIC_EXCLUDES {
                    warn!(
                        work_tree = %work_tree.display(),
                        cap = MAX_DYNAMIC_EXCLUDES,
                        "oversized untracked file cap reached; remaining oversized files stay included"
                    );
                    break;
                }
                oversized.push(relative);
            }
        }
        Ok(oversized)
    }

    async fn stage_phase(
        &self,
        shadow: &Path,
        work_tree: &Path,
        run_id: &str,
        phase: &str,
        index: &Path,
        reference_index: Option<&Path>,
    ) -> Result<()> {
        let dynamic = self
            .collect_oversized_untracked(shadow, work_tree, reference_index)
            .await?;
        let excludes = self
            .write_phase_excludes(shadow, run_id, phase, &dynamic)
            .await?;
        let env = self.isolated_env(shadow, work_tree, Some(index));
        let config = format!("core.excludesFile={}", normalize_path_for_git(&excludes));
        self.run_git_checked(
            &["-c", &config, "add", "-A"],
            &env,
            Some(work_tree),
            self.call_timeout,
        )
        .await?;
        Ok(())
    }

    async fn write_tree(&self, env: &[(String, String)]) -> Result<String> {
        let stdout = self
            .run_git_checked(&["write-tree"], env, None, self.call_timeout)
            .await?;
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    }

    async fn commit_tree(
        &self,
        env: &[(String, String)],
        tree: &str,
        parent: Option<&str>,
        message: &str,
    ) -> Result<String> {
        let mut args = vec!["commit-tree", tree];
        if let Some(parent) = parent {
            args.push("-p");
            args.push(parent);
        }
        args.push("-m");
        args.push(message);
        let stdout = self
            .run_git_checked(&args, env, None, self.call_timeout)
            .await?;
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    }

    async fn update_ref(&self, env: &[(String, String)], name: &str, commit: &str) -> Result<()> {
        self.run_git_checked(&["update-ref", name, commit], env, None, self.call_timeout)
            .await?;
        Ok(())
    }

    async fn rev_parse(&self, env: &[(String, String)], reference: &str) -> Result<Option<String>> {
        let output = self
            .run_git(
                &["rev-parse", "--verify", "--quiet", reference],
                env,
                None,
                self.call_timeout,
            )
            .await?;
        if !output.status.success() {
            return Ok(None);
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!value.is_empty()).then_some(value))
    }

    async fn changed_files_for(
        &self,
        env: &[(String, String)],
        base_commit: &str,
        end_commit: &str,
    ) -> Result<Vec<ChangedFile>> {
        let stdout = self
            .run_git_checked(
                &["diff", "--name-status", "-z", "-M", base_commit, end_commit],
                env,
                None,
                self.call_timeout,
            )
            .await?;
        parse_name_status_z(&stdout)
    }

    async fn cleanup_run_scratch(&self, shadow: &Path, run_id: &str) {
        for phase in ["base", "end"] {
            for path in [
                phase_index_path(shadow, run_id, phase),
                phase_excludes_path(shadow, run_id, phase),
            ] {
                if let Err(error) = tokio::fs::remove_file(&path).await
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    debug!(
                        path = %path.display(),
                        %error,
                        "failed to remove shadow checkpoint scratch file"
                    );
                }
            }
        }
    }

    fn null_config_env(&self) -> Vec<(String, String)> {
        let mut env = platform_env();
        env.push(("GIT_CONFIG_GLOBAL".to_string(), null_device().to_string()));
        env.push(("GIT_CONFIG_SYSTEM".to_string(), null_device().to_string()));
        env
    }

    fn isolated_env(
        &self,
        shadow: &Path,
        work_tree: &Path,
        index: Option<&Path>,
    ) -> Vec<(String, String)> {
        let mut env = self.null_config_env();
        env.push(("GIT_DIR".to_string(), normalize_path_for_git(shadow)));
        env.push((
            "GIT_WORK_TREE".to_string(),
            normalize_path_for_git(work_tree),
        ));
        env.push(("GIT_ATTR_NOSYSTEM".to_string(), "1".to_string()));
        env.push(("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()));
        env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
        if let Some(index) = index {
            env.push(("GIT_INDEX_FILE".to_string(), normalize_path_for_git(index)));
        }
        env
    }

    async fn run_git(
        &self,
        args: &[&str],
        envs: &[(String, String)],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<GitOutput> {
        let mut command = Command::new(&self.git_binary);
        command.arg("--no-optional-locks");
        command.args(args);
        command.env_clear();
        for (key, value) in envs {
            command.env(key, value);
        }
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(true);
        let child = command.spawn().map_err(|error| {
            CheckpointError::GitUnavailable(format!(
                "failed to spawn git ({}): {error}",
                self.git_binary
            ))
        })?;
        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(result) => result?,
            Err(_) => {
                return Err(CheckpointError::GitCommand {
                    command: args.join(" "),
                    detail: format!("timed out after {timeout:?}"),
                });
            }
        };
        Ok(GitOutput {
            status: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    async fn run_git_checked(
        &self,
        args: &[&str],
        envs: &[(String, String)],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<Vec<u8>> {
        let output = self.run_git(args, envs, cwd, timeout).await?;
        if !output.status.success() {
            return Err(CheckpointError::GitCommand {
                command: args.join(" "),
                detail: format!(
                    "exit code {:?}: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            });
        }
        if !output.stderr.is_empty() {
            debug!(
                command = %args.join(" "),
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "git stderr"
            );
        }
        Ok(output.stdout)
    }
}

/// Validate a workspace id against the storage-ref contract (W2 API surface).
pub fn validate_workspace_id(workspace_id: &str) -> Result<()> {
    if storage::is_valid_storage_ref(workspace_id) {
        Ok(())
    } else {
        Err(CheckpointError::InvalidIdentifier {
            kind: "workspace id",
            value: workspace_id.to_string(),
            detail:
                "must match ^[A-Za-z0-9_-]{1,64}$ (same contract as WorkspaceStorage storageRef)"
                    .to_string(),
        })
    }
}

/// Validate a run id as a safe single git ref component (W2 API surface).
pub fn validate_run_id(run_id: &str) -> Result<()> {
    let safe = !run_id.is_empty()
        && run_id.len() <= MAX_RUN_ID_LEN
        && !run_id.contains("..")
        && !run_id.starts_with('.')
        && !run_id.ends_with('.')
        && !run_id.ends_with(".lock")
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if safe {
        Ok(())
    } else {
        Err(CheckpointError::InvalidIdentifier {
            kind: "run id",
            value: run_id.to_string(),
            detail: format!("must be a safe single ref component (1..={MAX_RUN_ID_LEN} chars)"),
        })
    }
}

fn parse_git_version(output: &str) -> Option<(u32, u32)> {
    let after = output.trim().strip_prefix("git version ")?;
    let numbers: Vec<&str> = after.split_whitespace().next()?.split('.').collect();
    let major = numbers.first()?.parse::<u32>().ok()?;
    let minor = numbers.get(1)?.parse::<u32>().ok()?;
    Some((major, minor))
}

fn parse_name_status_z(bytes: &[u8]) -> Result<Vec<ChangedFile>> {
    let tokens: Vec<String> = bytes
        .split(|byte| *byte == 0)
        .filter(|token| !token.is_empty())
        .map(|token| String::from_utf8_lossy(token).into_owned())
        .collect();
    let mut changed = Vec::new();
    let mut cursor = 0;
    while cursor < tokens.len() {
        let status = tokens[cursor].clone();
        cursor += 1;
        let class = status.chars().next().unwrap_or('?');
        if class == 'R' || class == 'C' {
            let old_path = tokens.get(cursor).cloned();
            let path = tokens.get(cursor + 1).cloned();
            match (old_path, path) {
                (Some(old_path), Some(path)) => {
                    changed.push(ChangedFile {
                        status,
                        path,
                        old_path: Some(old_path),
                    });
                }
                _ => {
                    return Err(CheckpointError::GitCommand {
                        command: "git diff --name-status".to_string(),
                        detail: format!("truncated rename entry in {status:?}"),
                    });
                }
            }
            cursor += 2;
        } else {
            match tokens.get(cursor) {
                Some(path) => changed.push(ChangedFile {
                    status,
                    path: path.clone(),
                    old_path: None,
                }),
                None => {
                    return Err(CheckpointError::GitCommand {
                        command: "git diff --name-status".to_string(),
                        detail: format!("truncated entry in {status:?}"),
                    });
                }
            }
            cursor += 1;
        }
    }
    Ok(changed)
}

fn parse_xihe_refs(stdout: &[u8]) -> Vec<ShadowRef> {
    let mut refs = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        let (name, date) = line.split_once('\t').unwrap_or((line, ""));
        let Some(rest) = name.strip_prefix("refs/xihe/") else {
            continue;
        };
        let Some((run_id, kind)) = rest.rsplit_once('/') else {
            continue;
        };
        if run_id.is_empty() || run_id.contains('/') || kind.is_empty() {
            continue;
        }
        let epoch = date
            .split_whitespace()
            .next()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(i64::MAX);
        refs.push(ShadowRef {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            epoch,
        });
    }
    refs
}

fn base_message(run_id: &str, actor: &str, call_id: &str) -> String {
    format!(
        "run/{run_id} base\n\nactor: {}\ncallId: {}\n",
        sanitize_message_field(actor),
        sanitize_message_field(call_id)
    )
}

fn sanitize_message_field(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    sanitized.chars().take(200).collect()
}

fn phase_index_path(shadow: &Path, run_id: &str, phase: &str) -> PathBuf {
    shadow.join(format!("index.{run_id}.{phase}"))
}

fn phase_excludes_path(shadow: &Path, run_id: &str, phase: &str) -> PathBuf {
    shadow.join(format!("exclude.{run_id}.{phase}"))
}

/// gitignore line that matches exactly one workspace-relative path.
fn gitignore_literal(relative: &str) -> String {
    let mut pattern = String::from("/");
    for c in relative.chars() {
        match c {
            '\\' | '*' | '?' | '[' | ']' | '!' | '#' => {
                pattern.push('\\');
                pattern.push(c);
            }
            _ => pattern.push(c),
        }
    }
    pattern
}

fn normalize_path_for_git(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    stripped.replace('\\', "/")
}

fn null_device() -> &'static str {
    #[cfg(windows)]
    {
        "NUL"
    }
    #[cfg(not(windows))]
    {
        "/dev/null"
    }
}

fn platform_env() -> Vec<(String, String)> {
    const KEYS: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SystemDrive",
        "windir",
        "COMSPEC",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "LANG",
    ];
    KEYS.iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| (key.to_string(), value))
        })
        .collect()
}

async fn remove_file_if_exists(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn checkpoint_parse_git_version_accepts_platform_suffixes() {
        assert_eq!(
            parse_git_version("git version 2.55.0.windows.2"),
            Some((2, 55))
        );
        assert_eq!(parse_git_version("git version 2.20.1"), Some((2, 20)));
        assert_eq!(
            parse_git_version("git version 2.39.3 (Apple Git-145)"),
            Some((2, 39))
        );
        assert_eq!(parse_git_version("git version 3.0"), Some((3, 0)));
        assert_eq!(parse_git_version("not git"), None);
        assert_eq!(parse_git_version("git version"), None);
        assert_eq!(parse_git_version("git version abc.def"), None);
    }

    #[test]
    fn checkpoint_parse_name_status_z_covers_modify_add_delete_rename() {
        let bytes =
            b"M\0modified.txt\0A\0added.txt\0D\0deleted.txt\0R100\0old.txt\0new.txt\0".to_vec();
        let changed = parse_name_status_z(&bytes).expect("parse");
        assert_eq!(changed.len(), 4);
        assert_eq!(changed[0].status, "M");
        assert_eq!(changed[0].path, "modified.txt");
        assert_eq!(changed[0].old_path, None);
        assert_eq!(changed[1].status, "A");
        assert_eq!(changed[1].path, "added.txt");
        assert_eq!(changed[2].status, "D");
        assert_eq!(changed[2].path, "deleted.txt");
        assert_eq!(changed[3].status, "R100");
        assert_eq!(changed[3].old_path.as_deref(), Some("old.txt"));
        assert_eq!(changed[3].path, "new.txt");
        assert_eq!(parse_name_status_z(b"").expect("empty"), Vec::new());
    }

    #[test]
    fn checkpoint_parse_name_status_z_rejects_truncated_rename() {
        let error = parse_name_status_z(b"R100\0only-one.txt\0").expect_err("truncated");
        assert!(error.to_string().contains("truncated"));
    }

    #[test]
    fn checkpoint_gitignore_literal_is_anchored_and_escaped() {
        assert_eq!(gitignore_literal("dir/file.bin"), "/dir/file.bin");
        assert_eq!(gitignore_literal("a[1]*?.txt"), "/a\\[1\\]\\*\\?.txt");
    }

    #[test]
    fn checkpoint_parse_xihe_refs_skips_unknown_kinds_and_handles_bad_dates() {
        let raw = b"refs/xihe/run-1/base\t1700000000 +0000\n\
                    refs/xihe/run-1/rollback/1700000001\t1700000001 +0000\n\
                    refs/xihe/run-1/end\t1700000002 +0000\n\
                    refs/xihe/run-2/end\tnonsense\n\
                    refs/heads/main\t1700000003 +0000\n";
        let refs = parse_xihe_refs(raw);
        let rows: Vec<(&str, &str, i64)> = refs
            .iter()
            .map(|row| (row.run_id.as_str(), row.kind.as_str(), row.epoch))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("run-1", "base", 1_700_000_000),
                ("run-1", "end", 1_700_000_002),
                ("run-2", "end", i64::MAX),
            ]
        );
    }

    #[test]
    fn checkpoint_rejects_invalid_identifiers() {
        assert!(validate_run_id("0192abcd-1234-7abc-9def-0123456789ab").is_ok());
        assert!(validate_run_id("run.2026-09-15_01").is_ok());
        let mut bad_run_ids = vec![
            String::new(),
            "../evil".to_string(),
            "..".to_string(),
            ".hidden".to_string(),
            "trailing.".to_string(),
            "branch.lock".to_string(),
            "a/b".to_string(),
            "a b".to_string(),
            "a~b".to_string(),
            "a^b".to_string(),
            "a:b".to_string(),
        ];
        bad_run_ids.push("x".repeat(MAX_RUN_ID_LEN + 1));
        for bad in bad_run_ids {
            assert!(
                validate_run_id(&bad).is_err(),
                "run id {bad:?} must be rejected"
            );
        }

        assert!(validate_workspace_id("ws1").is_ok());
        for bad in ["", ".xihe-shadow", "a/b", "a.b", "has space"] {
            assert!(
                validate_workspace_id(bad).is_err(),
                "workspace id {bad:?} must be rejected"
            );
        }
    }

    #[tokio::test]
    async fn checkpoint_probe_reports_unavailable_without_panic() {
        let temp = TempDir::new().expect("tempdir");
        let engine = ShadowGit::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let capability = engine.probe().await;
        assert!(!capability.available);
        assert!(capability.version.is_none());
        assert!(!capability.detail.is_empty());
        assert_eq!(engine.probe().await, capability);
    }

    #[tokio::test]
    async fn checkpoint_ops_fail_explicitly_without_git() {
        let temp = TempDir::new().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("ws1")).expect("workspace");
        let engine = ShadowGit::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let error = engine
            .create_base("ws1", "run-1", "tester", "call-1")
            .await
            .expect_err("create_base must fail without git");
        assert!(matches!(error, CheckpointError::GitUnavailable(_)));
        let error = engine
            .seal("ws1", "run-1")
            .await
            .expect_err("seal must fail without git");
        assert!(matches!(error, CheckpointError::GitUnavailable(_)));
    }

    #[tokio::test]
    async fn checkpoint_invalid_run_id_fails_before_any_git_work() {
        let temp = TempDir::new().expect("tempdir");
        let engine = ShadowGit::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let error = engine
            .create_base("ws1", "../escape", "tester", "call")
            .await
            .expect_err("invalid run id must fail");
        assert!(matches!(
            error,
            CheckpointError::InvalidIdentifier { kind: "run id", .. }
        ));
    }

    #[tokio::test]
    async fn checkpoint_smoke_creates_idempotent_base_and_seals_clean_run() {
        let temp = TempDir::new().expect("tempdir");
        let engine = ShadowGit::new(temp.path());
        let capability = engine.probe().await;
        if !capability.available {
            eprintln!("checkpoint smoke skipped: {}", capability.detail);
            return;
        }
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(workspace.join("src")).expect("workspace");
        std::fs::write(workspace.join("src/main.txt"), "hello\n").expect("fixture file");

        let first = engine
            .create_base("ws1", "run-smoke", "tester", "call-1")
            .await
            .expect("create base");
        assert!(first.created);
        let second = engine
            .create_base("ws1", "run-smoke", "tester", "call-1")
            .await
            .expect("idempotent create base");
        assert!(!second.created);
        assert_eq!(first.base_commit, second.base_commit);

        let sealed = engine.seal("ws1", "run-smoke").await.expect("seal");
        assert!(
            sealed.changed_files.is_empty(),
            "clean run must not report changes: {:?}",
            sealed.changed_files
        );
        let files = engine
            .changed_files("ws1", "run-smoke")
            .await
            .expect("changed files");
        assert!(files.is_empty());

        let unsealed = engine
            .changed_files("ws1", "run-other")
            .await
            .expect_err("unknown run must fail");
        assert!(matches!(unsealed, CheckpointError::RunNotFound(_)));
    }
}
