//! PLAN-0338 slice model: restore + slice-blob + workspace-diff host API surface.
//!
//! Wires the restore engine ([`crate::checkpoint_revert`]) into the frozen Runtime
//! HTTP contract:
//!
//! - `revert/preview` is read-only: the git-native plan (restore/delete actions,
//!   type conflicts flagged, full counts) plus a bounded entry list with
//!   `truncated`; no lock is taken;
//! - `revert` executes per path, requires an explicit acknowledgement for every
//!   `type_conflict` path, fails fast with `CHECKPOINT_RESTORE_LOCKED` while
//!   another restore runs, and reports per-path outcomes plus the `suspects`
//!   written concurrently during the execution;
//! - `blob` serves one regular file of the slice tree as plain text (≤1 MiB);
//! - `git-status` projects the user repository's own porcelain status read-only
//!   (isolated env, no hooks) for the dual-diff separation (spec §6.4 / S4).
//!
//! The axum handlers in `main.rs` only map these outcomes to the frozen
//! Problem+JSON shapes; no control-plane or UI concept lives here.

use std::borrow::Cow;
use std::path::PathBuf;

use serde::Serialize;
use tracing::info;

use crate::checkpoint::CheckpointStorageMode;
use crate::checkpoint::{CheckpointError, WorkspaceGitStatus, validate_workspace_id};
use crate::checkpoint_api::{
    CheckpointService, REASON_GIT_FAILED, REASON_WORKSPACE_UNKNOWN, unavailable_reason,
};
use crate::checkpoint_revert::{
    MAX_BLOB_BYTES, NestedRepoAffected, RestoreAction, RestoreEntryState, RestoreError,
    RestoreItemOutcome, RestoreItemResult, RestorePreview, RestoreResult, RestoreResultCounts,
};
use crate::checkpoint_store::blob::read_blob;
use crate::checkpoint_store::manifest::Manifest;
use crate::checkpoint_store::refs;
use crate::checkpoint_store::restore_full::{
    self, FullRestoreError, FullRestoreOptions, FullRestoreState,
};
use crate::checkpoint_store::store::Store;

/// Preview entry cap: the counts always cover the full plan, `truncated` marks a
/// shortened `entries` list (response-size guard for very large plans).
pub const MAX_PREVIEW_ENTRIES: usize = 1000;

/// One entry of the restore preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreviewEntry {
    /// Workspace-relative path with forward slashes.
    pub path: String,
    /// `restore` (M/D) or `delete` (A).
    pub action: String,
    /// `execute` / `noop` / `type_conflict`.
    pub state: String,
    /// Frozen type-change reason (`TYPE_CHANGE`) when this entry is a conflict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Preview counts over the full plan: `restore`/`delete` count by action
/// (type-conflict entries included), `typeConflict` counts by state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreviewCounts {
    pub restore: usize,
    pub delete: usize,
    pub type_conflict: usize,
}

/// PLAN-0641 M3 (T4.3): one undeclared nested repository touched by a restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedRepoAffectedView {
    /// Workspace-relative POSIX path of the repository root.
    pub repo_path: String,
    /// `nested|gitdir|submodule|bare|symlink`.
    pub kind: String,
    /// The repository has uncommitted changes (blocks unless `force`).
    pub dirty: bool,
    /// Clean repository whose restored content differs from its HEAD tree.
    pub head_moved: bool,
}

fn nested_repo_views(affected: Vec<NestedRepoAffected>) -> Vec<NestedRepoAffectedView> {
    affected
        .into_iter()
        .map(|repo| NestedRepoAffectedView {
            repo_path: repo.repo_path,
            kind: repo.kind.to_string(),
            dirty: repo.dirty,
            head_moved: repo.head_moved,
        })
        .collect()
}

/// `POST .../checkpoints/revert/preview` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreviewOutcome {
    pub slice_ref: String,
    pub counts: RestorePreviewCounts,
    pub entries: Vec<RestorePreviewEntry>,
    /// `true` when `entries` was cut at [`MAX_PREVIEW_ENTRIES`].
    pub truncated: bool,
    /// PLAN-0641 M3 (T4.3): undeclared nested repos this revert touches.
    pub nested_repo_affected: Vec<NestedRepoAffectedView>,
}

/// One entry of the restore execution result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreExecuteEntry {
    pub path: String,
    /// `restored` / `deleted` / `failed` / `suspect`.
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Execution counts (suspects are listed separately on the response).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreExecuteCounts {
    pub restored: usize,
    pub deleted: usize,
    pub failed: usize,
}

/// `POST .../checkpoints/revert` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreExecuteOutcome {
    pub slice_ref: String,
    pub counts: RestoreExecuteCounts,
    pub entries: Vec<RestoreExecuteEntry>,
    pub duration_ms: u64,
    /// Executed paths that no longer match the target slice (concurrent write).
    pub suspects: Vec<String>,
    /// PLAN-0641 M3 (T4.3): undeclared nested repos this revert touched.
    pub nested_repo_affected: Vec<NestedRepoAffectedView>,
}

/// One blob read result; `content` is raw (text policy lives in the handler).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobOutcome {
    pub path: String,
    pub content: Vec<u8>,
}

/// `revert/preview` / `revert` failures mapped to 404 / 409 / 503.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreFailure {
    NotFound {
        detail: String,
    },
    TypeChangesUnacknowledged {
        paths: Vec<String>,
    },
    RestoreLocked,
    /// PLAN-0641 M3 (T4.2): dirty undeclared nested repos; `force` overrides.
    NestedRepoDirty {
        repos: Vec<String>,
    },
    /// PLAN-0641 M3 (T4.2): head-drifted repos missing from `acknowledgeNestedRepos`.
    NestedReposUnacknowledged {
        repos: Vec<String>,
    },
    Unavailable {
        reason: Cow<'static, str>,
        detail: String,
    },
}

/// Blob endpoint failures mapped to 400 / 404 / 413 / 503.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobFailure {
    NotFound {
        detail: String,
    },
    Invalid {
        detail: String,
    },
    TooLarge {
        path: String,
        size: u64,
        max: u64,
    },
    Unavailable {
        reason: Cow<'static, str>,
        detail: String,
    },
}

/// `git-status` failures mapped to 400 / 503.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitStatusFailure {
    Validation {
        detail: String,
    },
    Unavailable {
        reason: Cow<'static, str>,
        detail: String,
    },
}

impl CheckpointService {
    /// Read-only restore dry-run for one slice (no lock taken).
    pub async fn restore_preview(
        &self,
        workspace_id: &str,
        slice_ref: &str,
    ) -> Result<RestorePreviewOutcome, RestoreFailure> {
        self.restore_preview_for_root(workspace_id, None, slice_ref)
            .await
    }

    /// PLAN-0639 M8: preview the restore of a slice that belongs to **one declared
    /// root** (`rootId` absent = primary root, pre-M8 wire).
    pub async fn restore_preview_for_root(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
    ) -> Result<RestorePreviewOutcome, RestoreFailure> {
        self.restore_preview_for_root_path(workspace_id, root_id, slice_ref, None)
            .await
    }

    /// T2.2: optional literal path/subtree scope. Only the self/store adapter
    /// supports it; git mode keeps its legacy full-preview behavior.
    pub async fn restore_preview_for_root_path(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        path_prefix: Option<&str>,
    ) -> Result<RestorePreviewOutcome, RestoreFailure> {
        if self.engine().checkpoint_storage() == CheckpointStorageMode::Self_ {
            return self.self_restore_preview(workspace_id, root_id, slice_ref, path_prefix, &[]);
        }
        if path_prefix.is_some() {
            return Err(RestoreFailure::Unavailable {
                reason: "RESTORE_PATH_UNSUPPORTED".into(),
                detail: "path-scoped restore is available only in self mode".into(),
            });
        }
        let preview = self
            .engine()
            .restore_preview_for_root(workspace_id, root_id, slice_ref)
            .await
            .map_err(restore_failure)?;
        Ok(project_preview(preview))
    }

    /// T2.2 batch preview: literal paths, self/store adapter only.
    pub async fn restore_preview_for_root_paths(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        paths: &[String],
    ) -> Result<RestorePreviewOutcome, RestoreFailure> {
        if self.engine().checkpoint_storage() == CheckpointStorageMode::Self_ {
            return self.self_restore_preview(workspace_id, root_id, slice_ref, None, paths);
        }
        if !paths.is_empty() {
            return Err(RestoreFailure::Unavailable {
                reason: "RESTORE_PATH_UNSUPPORTED".into(),
                detail: "batch path restore is available only in self mode".into(),
            });
        }
        self.restore_preview_for_root(workspace_id, root_id, slice_ref)
            .await
    }

    /// Execute the restore of one slice.
    ///
    /// The engine holds the fail-fast restore lock for the execution only; every
    /// `type_conflict` entry must be acknowledged explicitly.
    pub async fn restore_execute(
        &self,
        workspace_id: &str,
        slice_ref: &str,
        acknowledge_type_changes: &[String],
    ) -> Result<RestoreExecuteOutcome, RestoreFailure> {
        self.restore_execute_for_root(
            workspace_id,
            None,
            slice_ref,
            acknowledge_type_changes,
            false,
            &[],
        )
        .await
    }

    /// PLAN-0639 M8: execute the restore of a slice of **one declared root**, so the
    /// shadow repo and work tree come from that root instead of the primary root.
    ///
    /// PLAN-0641 M3: `force` overrides the dirty-nested-repo gate;
    /// `acknowledge_nested_repos` must cover every head-drifted repo.
    pub async fn restore_execute_for_root(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        acknowledge_type_changes: &[String],
        force: bool,
        acknowledge_nested_repos: &[String],
    ) -> Result<RestoreExecuteOutcome, RestoreFailure> {
        self.restore_execute_for_root_path(
            workspace_id,
            root_id,
            slice_ref,
            acknowledge_type_changes,
            force,
            acknowledge_nested_repos,
            None,
        )
        .await
    }

    pub async fn restore_execute_for_root_path(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        acknowledge_type_changes: &[String],
        force: bool,
        acknowledge_nested_repos: &[String],
        path_prefix: Option<&str>,
    ) -> Result<RestoreExecuteOutcome, RestoreFailure> {
        if self.engine().checkpoint_storage() == CheckpointStorageMode::Self_ {
            return self.self_restore_execute(
                workspace_id,
                root_id,
                slice_ref,
                acknowledge_type_changes,
                path_prefix,
                &[],
            );
        }
        if path_prefix.is_some() {
            return Err(RestoreFailure::Unavailable {
                reason: "RESTORE_PATH_UNSUPPORTED".into(),
                detail: "path-scoped restore is available only in self mode".into(),
            });
        }
        let result = self
            .engine()
            .restore_execute_for_root(
                workspace_id,
                root_id,
                slice_ref,
                acknowledge_type_changes,
                force,
                acknowledge_nested_repos,
            )
            .await
            .map_err(restore_failure)?;
        info!(
            workspace_id,
            slice_ref,
            restored = result.counts.restored,
            deleted = result.counts.deleted,
            failed = result.counts.failed,
            suspects = result.suspects.len(),
            "checkpoint restore executed via host API"
        );
        Ok(project_execute(result))
    }

    /// T2.2 batch execute: literal paths, self/store adapter only.
    pub async fn restore_execute_for_root_paths(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        acknowledge_type_changes: &[String],
        force: bool,
        acknowledge_nested_repos: &[String],
        paths: &[String],
    ) -> Result<RestoreExecuteOutcome, RestoreFailure> {
        if self.engine().checkpoint_storage() == CheckpointStorageMode::Self_ {
            return self.self_restore_execute(
                workspace_id,
                root_id,
                slice_ref,
                acknowledge_type_changes,
                None,
                paths,
            );
        }
        if !paths.is_empty() {
            return Err(RestoreFailure::Unavailable {
                reason: "RESTORE_PATH_UNSUPPORTED".into(),
                detail: "batch path restore is available only in self mode".into(),
            });
        }
        self.restore_execute_for_root(
            workspace_id,
            root_id,
            slice_ref,
            acknowledge_type_changes,
            force,
            acknowledge_nested_repos,
        )
        .await
    }

    /// Read one regular file out of the slice tree.
    pub async fn slice_blob(
        &self,
        workspace_id: &str,
        slice_ref: &str,
        path: &str,
    ) -> Result<BlobOutcome, BlobFailure> {
        self.slice_blob_for_root(workspace_id, None, slice_ref, path)
            .await
    }

    /// PLAN-0639 M8: read one file out of a slice of **one declared root**.
    pub async fn slice_blob_for_root(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        path: &str,
    ) -> Result<BlobOutcome, BlobFailure> {
        if self.engine().checkpoint_storage() == CheckpointStorageMode::Self_ {
            return self.self_slice_blob(workspace_id, root_id, slice_ref, path);
        }
        let blob = self
            .engine()
            .slice_blob_for_root(workspace_id, root_id, slice_ref, path, MAX_BLOB_BYTES)
            .await
            .map_err(blob_failure)?;
        Ok(BlobOutcome {
            path: blob.path,
            content: blob.content,
        })
    }

    fn self_store(&self) -> Result<Store, RestoreFailure> {
        let root = self
            .engine()
            .store_root()
            .ok_or_else(|| RestoreFailure::Unavailable {
                reason: "STORE_NOT_INITIALIZED".into(),
                detail: "self mode has no store root".into(),
            })?;
        Store::open(root).map_err(|error| RestoreFailure::Unavailable {
            reason: "STORE_IO".into(),
            detail: error.to_string(),
        })
    }

    fn self_ref(
        &self,
        store: &Store,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
    ) -> Result<refs::RefRecord, RestoreFailure> {
        let root = root_id.unwrap_or(workspace_id);
        refs::read_ref(store, root, slice_ref)
            .map_err(|error| RestoreFailure::Unavailable {
                reason: "STORE_IO".into(),
                detail: error.to_string(),
            })?
            .ok_or_else(|| RestoreFailure::Unavailable {
                reason: "STORE_SLICE_UNMAPPED".into(),
                detail: format!("no store mapping for {slice_ref}"),
            })
    }

    fn self_work_tree(&self, record: &refs::RefRecord) -> Result<PathBuf, RestoreFailure> {
        self.engine()
            .work_tree_for_root(&record.root_id)
            .map_err(|error| RestoreFailure::Unavailable {
                reason: "STORE_IO".into(),
                detail: error.to_string(),
            })
    }

    fn self_restore_preview(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        path_prefix: Option<&str>,
        paths: &[String],
    ) -> Result<RestorePreviewOutcome, RestoreFailure> {
        let store = self.self_store()?;
        let record = self.self_ref(&store, workspace_id, root_id, slice_ref)?;
        let work_tree = self.self_work_tree(&record)?;
        let options = FullRestoreOptions {
            path_prefix: path_prefix.map(str::to_owned),
            paths: paths.to_vec(),
            ..FullRestoreOptions::default()
        };
        let preview = restore_full::preview_full(
            &store,
            &record.root_id,
            &record.store_slice_id,
            &work_tree,
            &options,
        )
        .map_err(Self::self_full_restore_failure)?;
        let mut entries = Vec::new();
        let mut counts = RestorePreviewCounts::default();
        for entry in &preview.entries {
            let action = match entry.action {
                restore_full::FullRestoreAction::Restore => RestoreAction::Restore,
                restore_full::FullRestoreAction::Delete => RestoreAction::Delete,
            };
            let state = match entry.state {
                FullRestoreState::Execute => RestoreEntryState::Execute,
                FullRestoreState::SkippedModified | FullRestoreState::AlreadyAbsent => {
                    RestoreEntryState::Noop
                }
            };
            match action {
                RestoreAction::Restore => counts.restore += 1,
                RestoreAction::Delete => counts.delete += 1,
            }
            entries.push(RestorePreviewEntry {
                path: entry.path.clone(),
                action: action.as_str().to_string(),
                state: match state {
                    RestoreEntryState::Execute => "execute",
                    RestoreEntryState::Noop => "noop",
                    RestoreEntryState::TypeConflict => "type_conflict",
                }
                .to_string(),
                reason: entry.detail.clone(),
            });
        }
        let truncated = entries.len() > MAX_PREVIEW_ENTRIES;
        entries.truncate(MAX_PREVIEW_ENTRIES);
        Ok(RestorePreviewOutcome {
            slice_ref: slice_ref.to_owned(),
            counts,
            entries,
            truncated,
            // Self/store previews never probe user repos (gates stay git-path-only in M3).
            nested_repo_affected: Vec::new(),
        })
    }

    fn self_restore_execute(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        _acknowledge_type_changes: &[String],
        path_prefix: Option<&str>,
        paths: &[String],
    ) -> Result<RestoreExecuteOutcome, RestoreFailure> {
        let store = self.self_store()?;
        let record = self.self_ref(&store, workspace_id, root_id, slice_ref)?;
        let work_tree = self.self_work_tree(&record)?;
        let options = FullRestoreOptions {
            path_prefix: path_prefix.map(str::to_owned),
            paths: paths.to_vec(),
            ..FullRestoreOptions::default()
        };
        let preview = restore_full::preview_full(
            &store,
            &record.root_id,
            &record.store_slice_id,
            &work_tree,
            &options,
        )
        .map_err(Self::self_full_restore_failure)?;
        let stats = if !paths.is_empty() {
            restore_full::restore_paths(
                &store,
                &record.root_id,
                &record.store_slice_id,
                &work_tree,
                paths,
                &options,
            )
        } else if let Some(prefix) = path_prefix {
            restore_full::restore_path(
                &store,
                &record.root_id,
                &record.store_slice_id,
                &work_tree,
                prefix,
                &options,
            )
        } else {
            restore_full::restore_full(
                &store,
                &record.root_id,
                &record.store_slice_id,
                &work_tree,
                &options,
            )
        }
        .map_err(Self::self_full_restore_failure)?;
        let mut entries = Vec::new();
        let mut suspects = Vec::new();
        for entry in preview.entries {
            let action = match entry.action {
                restore_full::FullRestoreAction::Restore => RestoreAction::Restore,
                restore_full::FullRestoreAction::Delete => RestoreAction::Delete,
            };
            let (outcome, reason) = match entry.state {
                FullRestoreState::Execute => match action {
                    RestoreAction::Restore => (RestoreItemOutcome::Restored, None),
                    RestoreAction::Delete => (RestoreItemOutcome::Deleted, None),
                },
                FullRestoreState::SkippedModified => {
                    suspects.push(entry.path.clone());
                    (RestoreItemOutcome::Suspect, entry.detail.clone())
                }
                FullRestoreState::AlreadyAbsent => {
                    (RestoreItemOutcome::Failed, entry.detail.clone())
                }
            };
            entries.push(RestoreItemResult {
                path: entry.path,
                action,
                outcome,
                reason,
            });
        }
        let result = RestoreResult {
            slice_ref: slice_ref.to_owned(),
            commit: record.git_tree.clone(),
            entries,
            counts: RestoreResultCounts {
                restored: stats.restored,
                deleted: stats.deleted,
                failed: stats.skipped_already_absent,
            },
            duration_ms: stats.duration_ms,
            suspects,
            nested_repo_affected: Vec::new(),
        };
        Ok(project_execute(result))
    }

    fn self_slice_blob(
        &self,
        workspace_id: &str,
        root_id: Option<&str>,
        slice_ref: &str,
        path: &str,
    ) -> Result<BlobOutcome, BlobFailure> {
        let store = self
            .self_store()
            .map_err(|failure| BlobFailure::Unavailable {
                reason: "STORE_NOT_INITIALIZED".into(),
                detail: format!("{failure:?}"),
            })?;
        let record = self
            .self_ref(&store, workspace_id, root_id, slice_ref)
            .map_err(|failure| BlobFailure::Unavailable {
                reason: "STORE_SLICE_UNMAPPED".into(),
                detail: format!("{failure:?}"),
            })?;
        let manifest_bytes = std::fs::read(store.manifest_path(&record.store_manifest_id))
            .map_err(|error| BlobFailure::NotFound {
                detail: error.to_string(),
            })?;
        let manifest = Manifest::parse_verified(&manifest_bytes, &record.store_manifest_id)
            .map_err(|error| BlobFailure::NotFound {
                detail: error.to_string(),
            })?;
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.path == path)
            .ok_or_else(|| BlobFailure::NotFound {
                detail: format!("path {path} is not present in the slice tree"),
            })?;
        if entry.size > MAX_BLOB_BYTES {
            return Err(BlobFailure::TooLarge {
                path: path.to_owned(),
                size: entry.size,
                max: MAX_BLOB_BYTES,
            });
        }
        let content = read_blob(store.root(), &entry.blob_hash).map_err(|error| {
            BlobFailure::Unavailable {
                reason: "RESTORE_BLOB_MISSING".into(),
                detail: error.to_string(),
            }
        })?;
        Ok(BlobOutcome {
            path: path.to_owned(),
            content,
        })
    }

    fn self_full_restore_failure(error: FullRestoreError) -> RestoreFailure {
        match error {
            FullRestoreError::SliceMissing(_) => RestoreFailure::NotFound {
                detail: "store slice is missing".into(),
            },
            FullRestoreError::UnsafePath(path) | FullRestoreError::SymlinkUnsupported(path) => {
                RestoreFailure::Unavailable {
                    reason: "RESTORE_UNSAFE_PATH".into(),
                    detail: path,
                }
            }
            FullRestoreError::RestoreIncomplete(_) => RestoreFailure::Unavailable {
                reason: "RESTORE_INCOMPLETE".into(),
                detail: "another restore is incomplete; rerun with resume".into(),
            },
            FullRestoreError::MarkerCorrupt(detail) => RestoreFailure::Unavailable {
                reason: "RESTORE_MARKER_CORRUPT".into(),
                detail,
            },
            FullRestoreError::TypeConflict { path, detail: _ } => {
                RestoreFailure::TypeChangesUnacknowledged { paths: vec![path] }
            }
            other => RestoreFailure::Unavailable {
                reason: "RESTORE_VERIFY_FAILED".into(),
                detail: other.to_string(),
            },
        }
    }

    /// Read-only user-repository `git status` (dual-diff "待提交" side).
    pub async fn git_status(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceGitStatus, GitStatusFailure> {
        validate_workspace_id(workspace_id).map_err(|error| GitStatusFailure::Validation {
            detail: error.to_string(),
        })?;
        match self.engine().workspace_git_status(workspace_id).await {
            Ok(status) => Ok(status),
            Err(CheckpointError::GitUnavailable(detail)) => {
                let capability = self.engine().probe().await;
                Err(GitStatusFailure::Unavailable {
                    reason: unavailable_reason(&capability.version).into(),
                    detail,
                })
            }
            Err(CheckpointError::InvalidIdentifier { detail, .. }) => {
                Err(GitStatusFailure::Validation { detail })
            }
            Err(CheckpointError::WorkspaceMissing(detail)) => Err(GitStatusFailure::Unavailable {
                reason: REASON_WORKSPACE_UNKNOWN.into(),
                detail,
            }),
            Err(other) => Err(GitStatusFailure::Unavailable {
                reason: REASON_GIT_FAILED.into(),
                detail: other.to_string(),
            }),
        }
    }

    /// PLAN-0340: branch + short HEAD only (L1b).
    pub async fn git_facts(
        &self,
        workspace_id: &str,
    ) -> Result<crate::checkpoint::WorkspaceGitFacts, GitStatusFailure> {
        validate_workspace_id(workspace_id).map_err(|error| GitStatusFailure::Validation {
            detail: error.to_string(),
        })?;
        match self.engine().workspace_git_facts(workspace_id).await {
            Ok(facts) => Ok(facts),
            Err(CheckpointError::GitUnavailable(detail)) => {
                let capability = self.engine().probe().await;
                Err(GitStatusFailure::Unavailable {
                    reason: unavailable_reason(&capability.version).into(),
                    detail,
                })
            }
            Err(CheckpointError::InvalidIdentifier { detail, .. }) => {
                Err(GitStatusFailure::Validation { detail })
            }
            Err(CheckpointError::WorkspaceMissing(detail)) => Err(GitStatusFailure::Unavailable {
                reason: REASON_WORKSPACE_UNKNOWN.into(),
                detail,
            }),
            Err(other) => Err(GitStatusFailure::Unavailable {
                reason: REASON_GIT_FAILED.into(),
                detail: other.to_string(),
            }),
        }
    }
}

/// Project the engine dry-run into the frozen preview wire shape.
fn project_preview(preview: RestorePreview) -> RestorePreviewOutcome {
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in &preview.entries {
        if entries.len() >= MAX_PREVIEW_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(RestorePreviewEntry {
            path: entry.path.clone(),
            action: entry.action.as_str().to_string(),
            state: entry.state.as_str().to_string(),
            reason: entry.reason.clone(),
        });
    }
    RestorePreviewOutcome {
        slice_ref: preview.slice_ref,
        counts: RestorePreviewCounts {
            restore: preview.counts.restore,
            delete: preview.counts.delete,
            type_conflict: preview.counts.type_conflict,
        },
        entries,
        truncated,
        nested_repo_affected: nested_repo_views(preview.nested_repo_affected),
    }
}

/// Project the engine execution result into the frozen execute wire shape.
fn project_execute(result: RestoreResult) -> RestoreExecuteOutcome {
    RestoreExecuteOutcome {
        slice_ref: result.slice_ref,
        counts: RestoreExecuteCounts {
            restored: result.counts.restored,
            deleted: result.counts.deleted,
            failed: result.counts.failed,
        },
        entries: result
            .entries
            .into_iter()
            .map(|item| RestoreExecuteEntry {
                path: item.path,
                outcome: outcome_wire(item.outcome),
                reason: item.reason,
            })
            .collect(),
        duration_ms: result.duration_ms,
        suspects: result.suspects,
        nested_repo_affected: nested_repo_views(result.nested_repo_affected),
    }
}

fn outcome_wire(outcome: RestoreItemOutcome) -> String {
    match outcome {
        RestoreItemOutcome::Restored => "restored",
        RestoreItemOutcome::Deleted => "deleted",
        RestoreItemOutcome::Failed => "failed",
        RestoreItemOutcome::Suspect => "suspect",
    }
    .to_string()
}

fn restore_failure(error: RestoreError) -> RestoreFailure {
    match error {
        RestoreError::SliceNotFound(detail) => RestoreFailure::NotFound {
            detail: format!("no checkpoint slice for {detail}"),
        },
        RestoreError::TypeChangesUnacknowledged { paths } => {
            RestoreFailure::TypeChangesUnacknowledged { paths }
        }
        RestoreError::NestedRepoDirty { repos } => RestoreFailure::NestedRepoDirty { repos },
        RestoreError::NestedReposUnacknowledged { repos } => {
            RestoreFailure::NestedReposUnacknowledged { repos }
        }
        RestoreError::RestoreLocked => RestoreFailure::RestoreLocked,
        RestoreError::Unavailable { reason, detail } => RestoreFailure::Unavailable {
            reason: reason.into(),
            detail,
        },
        other => RestoreFailure::Unavailable {
            reason: REASON_GIT_FAILED.into(),
            detail: other.to_string(),
        },
    }
}

fn blob_failure(error: RestoreError) -> BlobFailure {
    match error {
        RestoreError::SliceNotFound(detail) => BlobFailure::NotFound {
            detail: format!("no checkpoint slice for {detail}"),
        },
        RestoreError::PathNotFound { path } => BlobFailure::NotFound {
            detail: format!("path {path} is not present in the slice tree"),
        },
        RestoreError::InvalidRequest { detail } => BlobFailure::Invalid { detail },
        RestoreError::BlobTooLarge { path, size, max } => BlobFailure::TooLarge { path, size, max },
        RestoreError::Unavailable { reason, detail } => BlobFailure::Unavailable {
            reason: reason.into(),
            detail,
        },
        other => BlobFailure::Unavailable {
            reason: REASON_GIT_FAILED.into(),
            detail: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_revert::{
        RestoreAction, RestoreEntryState, RestoreItemResult,
        RestorePreviewCounts as EnginePreviewCounts, RestoreResultCounts,
    };

    fn preview_with(entries: Vec<crate::checkpoint_revert::RestorePreviewEntry>) -> RestorePreview {
        let counts = EnginePreviewCounts {
            restore: entries
                .iter()
                .filter(|entry| entry.action == RestoreAction::Restore)
                .count(),
            delete: entries
                .iter()
                .filter(|entry| entry.action == RestoreAction::Delete)
                .count(),
            type_conflict: entries
                .iter()
                .filter(|entry| entry.state == RestoreEntryState::TypeConflict)
                .count(),
        };
        RestorePreview {
            slice_ref: "refs/xihe/slices/1-abc".to_string(),
            commit: "abc".to_string(),
            entries,
            counts,
        }
    }

    fn entry(
        path: &str,
        action: RestoreAction,
        state: RestoreEntryState,
    ) -> crate::checkpoint_revert::RestorePreviewEntry {
        crate::checkpoint_revert::RestorePreviewEntry {
            path: path.to_string(),
            action,
            state,
            reason: (state == RestoreEntryState::TypeConflict).then(|| "TYPE_CHANGE".to_string()),
        }
    }

    #[tokio::test]
    async fn self_read_paths_use_store_adapter_for_preview_restore_and_blob() {
        use crate::checkpoint_store::capture::capture_root;
        use crate::checkpoint_store::refs::{self, RefRecord};
        use crate::checkpoint_store::store::Store;

        let temp = tempfile::tempdir().expect("tempdir");
        let host = temp.path().join("host");
        let work = host.join("ws-1");
        std::fs::create_dir_all(&work).expect("work");
        std::fs::write(work.join("a.txt"), "store-a").expect("a");
        std::fs::write(work.join("b.txt"), "store-b").expect("b");
        let store_root = temp.path().join("store");
        let store = Store::init(&store_root).expect("store");
        let capture = capture_root(&store, &work, "ws-1", None, None).expect("capture");
        let slice_ref = "refs/xihe/slices/self-read";
        refs::write_ref(
            &store,
            &RefRecord {
                v: 1,
                root_id: "ws-1".into(),
                git_ref: slice_ref.into(),
                git_tree: "0".repeat(40),
                store_slice_id: capture.slice_id.clone(),
                store_manifest_id: capture.manifest_id.clone(),
                source: "capture".into(),
                created_at_ms: 0,
            },
        )
        .expect("ref");
        let service = CheckpointService::new(&host)
            .with_checkpoint_storage(CheckpointStorageMode::Self_, &store_root)
            .expect("self service");
        std::fs::write(work.join("a.txt"), "changed").expect("mutate");
        let preview = service
            .restore_preview_for_root("ws-1", None, slice_ref)
            .await
            .expect("preview");
        assert_eq!(preview.counts.restore, 2);
        assert_eq!(preview.counts.delete, 0);
        assert!(preview.entries.iter().any(|entry| entry.path == "a.txt"));
        let blob = service
            .slice_blob_for_root("ws-1", None, slice_ref, "a.txt")
            .await
            .expect("blob");
        assert_eq!(blob.content, b"store-a");
        let executed = service
            .restore_execute_for_root("ws-1", None, slice_ref, &[])
            .await
            .expect("restore");
        assert_eq!(executed.counts.restored, 2);
        assert_eq!(
            std::fs::read_to_string(work.join("a.txt")).expect("a"),
            "store-a"
        );
        std::fs::write(work.join("a.txt"), "changed-again").expect("mutate a");
        std::fs::write(work.join("b.txt"), "changed-b").expect("mutate b");
        let scoped = service
            .restore_execute_for_root_path("ws-1", None, slice_ref, &[], Some("a.txt"))
            .await
            .expect("path restore");
        assert_eq!(scoped.counts.restored, 1);
        assert_eq!(
            std::fs::read_to_string(work.join("a.txt")).expect("a"),
            "store-a"
        );
        assert_eq!(
            std::fs::read_to_string(work.join("b.txt")).expect("b"),
            "changed-b",
            "path-scoped restore must not touch b.txt"
        );
        let paths = vec!["a.txt".to_string(), "b.txt".to_string()];
        let batch_preview = service
            .restore_preview_for_root_paths("ws-1", None, slice_ref, &paths)
            .await
            .expect("batch preview");
        assert_eq!(batch_preview.counts.restore, 2);
        let batch = service
            .restore_execute_for_root_paths("ws-1", None, slice_ref, &[], &paths)
            .await
            .expect("batch restore");
        assert_eq!(batch.counts.restored, 2);
        assert_eq!(
            std::fs::read_to_string(work.join("b.txt")).expect("b"),
            "store-b"
        );
    }

    #[test]
    fn restore_preview_projection_maps_actions_states_and_truncation() {
        let outcome = project_preview(preview_with(vec![
            entry("a.txt", RestoreAction::Restore, RestoreEntryState::Execute),
            entry("b.txt", RestoreAction::Delete, RestoreEntryState::Execute),
            entry("p", RestoreAction::Restore, RestoreEntryState::TypeConflict),
        ]));
        assert_eq!(outcome.slice_ref, "refs/xihe/slices/1-abc");
        assert_eq!(
            outcome.counts,
            RestorePreviewCounts {
                restore: 2,
                delete: 1,
                type_conflict: 1,
            }
        );
        assert_eq!(outcome.entries[0].action, "restore");
        assert_eq!(outcome.entries[0].state, "execute");
        assert_eq!(outcome.entries[0].reason, None);
        assert_eq!(outcome.entries[1].action, "delete");
        assert_eq!(outcome.entries[2].state, "type_conflict");
        assert_eq!(outcome.entries[2].reason.as_deref(), Some("TYPE_CHANGE"));
        assert!(!outcome.truncated);

        let items: Vec<_> = (0..=MAX_PREVIEW_ENTRIES)
            .map(|index| {
                entry(
                    &format!("file-{index:05}.txt"),
                    RestoreAction::Restore,
                    RestoreEntryState::Execute,
                )
            })
            .collect();
        let total = items.len();
        let truncated = project_preview(preview_with(items));
        assert!(
            truncated.truncated,
            "overflowing entry lists must be flagged"
        );
        assert_eq!(truncated.entries.len(), MAX_PREVIEW_ENTRIES);
        assert_eq!(
            truncated.counts.restore, total,
            "counts cover the full plan"
        );
    }

    #[test]
    fn restore_execute_projection_maps_counts_outcomes_and_suspects() {
        let result = RestoreResult {
            slice_ref: "refs/xihe/slices/1-abc".to_string(),
            commit: "abc".to_string(),
            entries: vec![
                RestoreItemResult {
                    path: "a.txt".to_string(),
                    action: RestoreAction::Restore,
                    outcome: RestoreItemOutcome::Restored,
                    reason: None,
                },
                RestoreItemResult {
                    path: "b.txt".to_string(),
                    action: RestoreAction::Delete,
                    outcome: RestoreItemOutcome::Suspect,
                    reason: None,
                },
                RestoreItemResult {
                    path: "c.txt".to_string(),
                    action: RestoreAction::Restore,
                    outcome: RestoreItemOutcome::Failed,
                    reason: Some("io detail".to_string()),
                },
            ],
            counts: RestoreResultCounts {
                restored: 1,
                deleted: 0,
                failed: 1,
            },
            duration_ms: 12,
            suspects: vec!["b.txt".to_string()],
        };
        let outcome = project_execute(result);
        assert_eq!(outcome.slice_ref, "refs/xihe/slices/1-abc");
        assert_eq!(
            outcome.counts,
            RestoreExecuteCounts {
                restored: 1,
                deleted: 0,
                failed: 1,
            }
        );
        assert_eq!(outcome.entries[0].outcome, "restored");
        assert_eq!(outcome.entries[0].reason, None);
        assert_eq!(outcome.entries[1].outcome, "suspect");
        assert_eq!(outcome.entries[2].outcome, "failed");
        assert_eq!(outcome.entries[2].reason.as_deref(), Some("io detail"));
        assert_eq!(outcome.duration_ms, 12);
        assert_eq!(outcome.suspects, vec!["b.txt".to_string()]);
    }

    #[test]
    fn failure_mapping_projects_engine_errors_to_frozen_codes() {
        assert_eq!(
            restore_failure(RestoreError::SliceNotFound(
                "refs/xihe/slices/1-a".to_string()
            )),
            RestoreFailure::NotFound {
                detail: "no checkpoint slice for refs/xihe/slices/1-a".to_string()
            }
        );
        assert!(matches!(
            restore_failure(RestoreError::TypeChangesUnacknowledged {
                paths: vec!["p".to_string()]
            }),
            RestoreFailure::TypeChangesUnacknowledged { paths } if paths == vec!["p".to_string()]
        ));
        assert_eq!(
            restore_failure(RestoreError::RestoreLocked),
            RestoreFailure::RestoreLocked
        );
        assert!(matches!(
            restore_failure(RestoreError::Failed("boom".to_string())),
            RestoreFailure::Unavailable {
                reason: Cow::Borrowed(REASON_GIT_FAILED),
                ..
            }
        ));
        assert_eq!(
            blob_failure(RestoreError::PathNotFound {
                path: "a.txt".to_string()
            }),
            BlobFailure::NotFound {
                detail: "path a.txt is not present in the slice tree".to_string()
            }
        );
        assert_eq!(
            blob_failure(RestoreError::BlobTooLarge {
                path: "big.bin".to_string(),
                size: 10,
                max: 5,
            }),
            BlobFailure::TooLarge {
                path: "big.bin".to_string(),
                size: 10,
                max: 5,
            }
        );
    }
}
