use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    #[serde(default)]
    pub import_id: Option<String>,
    pub source_path: String,
    #[serde(default)]
    pub exclude_rules: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStatus {
    pub import_id: String,
    pub workspace_id: String,
    pub status: String,
    pub files_scanned: u64,
    pub files_copied: u64,
    pub files_skipped: u64,
    pub bytes_copied: u64,
    pub bytes_skipped: u64,
    pub current_path: Option<String>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDirectoryEntry {
    pub name: String,
    pub kind: String,
    pub readable: bool,
    pub size: u64,
    /// R44 / task-981：该目录自身是否带 `.git`（目录或文件）。UI 只读这个布尔值渲染徽标。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub git_repo: bool,
    /// 只在 `git_repo = true` 时给出：`.git` 目录 ⇒ `repo`，`.git` 文件（worktree/submodule
    /// 指针）⇒ `worktree`；无 `.git` ⇒ `null`。`nested` 是 wire 预留值，当前列举接口不产出。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_kind: Option<SourceGitKind>,
}

/// Runtime 目录列举里的 git 标记分类；wire 值与 957 的 UI 契约一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceGitKind {
    Repo,
    Worktree,
    /// 预留：调用方已知该条目属于某个父仓时用它表达「嵌套仓」；列举接口按卡面 §2
    /// 只做路径级判定，不推断祖先，因此当前不会返回它。
    #[allow(dead_code)]
    Nested,
}

/// 只读判断 `<entry>/.git` 的形态：目录 ⇒ repo，文件 ⇒ worktree，缺失/不可读 ⇒ null。
///
/// 失败（权限不足、符号链接目标不可解析等）一律降级为「不是 git 仓」并记 debug 日志，
/// 绝不让整次目录列举失败；也不执行任何 git 命令，只读文件系统元数据。
fn detect_source_git_kind(entry_path: &Path) -> (bool, Option<SourceGitKind>) {
    let git_marker = entry_path.join(".git");
    let metadata = match fs::symlink_metadata(&git_marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (false, None),
        Err(error) => {
            tracing::debug!(
                path = %entry_path.display(),
                %error,
                "source directory git probe failed; reporting null"
            );
            return (false, None);
        }
    };
    let file_type = metadata.file_type();
    if file_type.is_dir() {
        return (true, Some(SourceGitKind::Repo));
    }
    if file_type.is_file() {
        return (true, Some(SourceGitKind::Worktree));
    }
    if file_type.is_symlink() {
        // 符号链接不跟随失败不影响列举；只有能跟到实体且是目录/文件时才算 git 标记。
        return match fs::metadata(&git_marker) {
            Ok(target) if target.is_dir() => (true, Some(SourceGitKind::Repo)),
            Ok(target) if target.is_file() => (true, Some(SourceGitKind::Worktree)),
            Ok(_) => (false, None),
            Err(error) => {
                tracing::debug!(
                    path = %entry_path.display(),
                    %error,
                    "source directory git symlink probe failed; reporting null"
                );
                (false, None)
            }
        };
    }
    (false, None)
}

pub fn list_source_directory(path: &str) -> Result<Vec<SourceDirectoryEntry>, String> {
    let directory = canonical_source(path)?;
    if !directory.is_dir() {
        return Err("source path is not a directory".to_string());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("source directory cannot be listed: {error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let file_type = if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        };
        let (git_repo, git_kind) = if metadata.is_dir() {
            detect_source_git_kind(entry.path().as_path())
        } else {
            (false, None)
        };
        entries.push(SourceDirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: file_type.to_string(),
            readable: metadata.permissions().readonly() || fs::File::open(entry.path()).is_ok(),
            size: metadata.len(),
            git_repo,
            git_kind,
        });
    }
    entries.sort_by(|left, right| left.kind.cmp(&right.kind).then(left.name.cmp(&right.name)));
    Ok(entries)
}

#[derive(Clone)]
pub struct ImportManager {
    jobs: Arc<Mutex<HashMap<String, Arc<Job>>>>,
}

struct Job {
    status: Mutex<ImportStatus>,
    cancel: AtomicBool,
}

impl ImportManager {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(
        &self,
        workspace_id: String,
        host_root: PathBuf,
        request: ImportRequest,
    ) -> Result<ImportStatus, String> {
        let source = canonical_source(&request.source_path)?;
        if !source.is_dir() {
            return Err("source path is not a directory".to_string());
        }
        let target = host_root.join(&workspace_id);
        if target.exists() {
            let entries = fs::read_dir(&target).map_err(|error| {
                format!("target workspace directory cannot be inspected: {error}")
            })?;
            let mut unexpected = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_runtime_managed_entry(&name) {
                    unexpected.push(name);
                }
            }
            if !unexpected.is_empty() {
                return Err("target workspace directory is not empty".to_string());
            }
        }
        let import_id = request
            .import_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let job = Arc::new(Job {
            status: Mutex::new(ImportStatus {
                import_id: import_id.clone(),
                workspace_id: workspace_id.clone(),
                status: "running".to_string(),
                files_scanned: 0,
                files_copied: 0,
                files_skipped: 0,
                bytes_copied: 0,
                bytes_skipped: 0,
                current_path: None,
                error_code: None,
                error_detail: None,
            }),
            cancel: AtomicBool::new(false),
        });
        self.jobs.lock().await.insert(import_id, job.clone());
        let worker_job = job.clone();
        tokio::task::spawn_blocking(move || {
            let result = copy_tree(&source, &target, &request.exclude_rules, &worker_job);
            let runtime = tokio::runtime::Handle::current();
            runtime.block_on(async move {
                let mut status = worker_job.status.lock().await;
                match result {
                    Ok(()) => status.status = "completed".to_string(),
                    Err((code, detail)) => {
                        status.status = if code == "IMPORT_CANCELLED" {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .to_string();
                        status.error_code = Some(code);
                        status.error_detail = Some(detail);
                        let _ = fs::remove_dir_all(&target);
                    }
                }
            });
        });
        Ok(job.status.lock().await.clone())
    }

    pub async fn get(&self, import_id: &str) -> Option<ImportStatus> {
        let jobs = self.jobs.lock().await;
        let job = jobs.get(import_id)?.clone();
        Some(job.status.lock().await.clone())
    }

    pub async fn cancel(&self, import_id: &str) -> Option<ImportStatus> {
        let jobs = self.jobs.lock().await;
        let job = jobs.get(import_id)?.clone();
        job.cancel.store(true, Ordering::Release);
        Some(job.status.lock().await.clone())
    }
}

fn copy_tree(
    source: &Path,
    target: &Path,
    excludes: &[String],
    job: &Job,
) -> Result<(), (String, String)> {
    fs::create_dir_all(target)
        .map_err(|error| ("IMPORT_TARGET_CREATE_FAILED".to_string(), error.to_string()))?;
    for entry in WalkDir::new(source).follow_links(false) {
        if job.cancel.load(Ordering::Acquire) {
            return Err((
                "IMPORT_CANCELLED".to_string(),
                "import cancelled".to_string(),
            ));
        }
        let entry = entry.map_err(|error| ("IMPORT_SCAN_FAILED".to_string(), error.to_string()))?;
        let relative = entry.path().strip_prefix(source).unwrap_or(entry.path());
        if relative.as_os_str().is_empty() {
            continue;
        }
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        let ignored = excludes
            .iter()
            .any(|rule| relative_text == *rule || relative_text.starts_with(&format!("{rule}/")));
        let metadata = entry
            .metadata()
            .map_err(|error| ("IMPORT_SCAN_FAILED".to_string(), error.to_string()))?;
        if metadata.is_file() {
            let mut status = job.status.blocking_lock();
            status.files_scanned += 1;
        }
        if ignored {
            let mut status = job.status.blocking_lock();
            status.files_skipped += u64::from(metadata.is_file());
            status.bytes_skipped += metadata.len();
            continue;
        }
        if metadata.file_type().is_symlink() {
            let mut status = job.status.blocking_lock();
            status.files_skipped += 1;
            continue;
        }
        let destination = target.join(relative);
        if metadata.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| ("IMPORT_COPY_FAILED".to_string(), error.to_string()))?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| ("IMPORT_COPY_FAILED".to_string(), error.to_string()))?;
        }
        fs::copy(entry.path(), &destination)
            .map_err(|error| ("IMPORT_COPY_FAILED".to_string(), error.to_string()))?;
        let mut status = job.status.blocking_lock();
        status.files_copied += 1;
        status.bytes_copied += metadata.len();
        status.current_path = Some(relative_text);
    }
    Ok(())
}

fn canonical_source(path: &str) -> Result<PathBuf, String> {
    if path.contains('\0') || path.starts_with(r"\\.\") || path.starts_with("//./") {
        return Err("source path uses an unsupported device namespace".to_string());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("source path is not readable: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("source path must not be a symlink or reparse link".to_string());
    }
    fs::canonicalize(path).map_err(|error| format!("source path is not readable: {error}"))
}

fn is_runtime_managed_entry(name: &str) -> bool {
    matches!(
        name,
        ".xihe-sentinel"
            | ".xihe-container-runtime.log"
            | ".xihe-container-runtime.pid"
            | "logs"
            | "AGENTS.md"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::tempdir;

    #[tokio::test]
    async fn imports_files_and_applies_excludes() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target_root = root.path().join("target-root");
        fs::create_dir_all(source.join("src")).unwrap();
        fs::create_dir_all(source.join("node_modules")).unwrap();
        fs::create_dir_all(source.join(".git")).unwrap();
        fs::write(source.join("src/main.ts"), "export const value = 1;\n").unwrap();
        fs::write(source.join("node_modules/ignored.js"), "ignored\n").unwrap();
        fs::write(
            source.join(".git/config"),
            "[core]\n\trepositoryformatversion = 0\n",
        )
        .unwrap();

        let manager = ImportManager::new();
        let started = manager
            .start(
                "ws-1".to_string(),
                target_root.clone(),
                ImportRequest {
                    import_id: None,
                    source_path: source.to_string_lossy().to_string(),
                    exclude_rules: vec!["node_modules".to_string()],
                },
            )
            .await
            .unwrap();
        assert_eq!(started.status, "running");

        let status = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let current = manager.get(&started.import_id).await.unwrap();
                if current.status != "running" {
                    break current;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert_eq!(status.status, "completed");
        assert!(target_root.join("ws-1/src/main.ts").exists());
        assert!(target_root.join("ws-1/.git/config").exists());
        assert!(!target_root.join("ws-1/node_modules/ignored.js").exists());
        // Three files are scanned; `node_modules` is the only excluded rule, so
        // it is skipped and the remaining two (including `.git/config`, which is
        // imported as-is so the workspace keeps its git history) are copied.
        assert_eq!(status.files_scanned, 3);
        assert_eq!(status.files_skipped, 1);
        assert_eq!(status.files_copied, 2);
        assert!(status.bytes_copied > 0);
        assert!(status.bytes_skipped > 0);
    }

    #[test]
    fn lists_source_directory_entries_without_following_workspace_semantics() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("dir")).unwrap();
        fs::write(root.path().join("file.txt"), "text").unwrap();
        let entries = list_source_directory(root.path().to_str().unwrap()).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["dir", "file.txt"]
        );
        assert_eq!(entries[0].kind, "directory");
        assert_eq!(entries[1].kind, "file");
    }

    #[test]
    fn lists_source_directory_marks_git_directory_as_repo() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("repo").join(".git")).unwrap();
        fs::create_dir(root.path().join("plain")).unwrap();
        let entries = list_source_directory(root.path().to_str().unwrap()).unwrap();
        let repo = entries
            .iter()
            .find(|entry| entry.name == "repo")
            .expect("repo entry");
        assert!(repo.git_repo, ".git directory must set gitRepo");
        assert_eq!(repo.git_kind, Some(SourceGitKind::Repo));

        let plain = entries
            .iter()
            .find(|entry| entry.name == "plain")
            .expect("plain entry");
        assert!(!plain.git_repo);
        assert_eq!(plain.git_kind, None);
        // Wire names must match the 957 UI contract exactly.
        let json = serde_json::to_value(repo).expect("serialize");
        assert_eq!(json["gitRepo"], serde_json::json!(true));
        assert_eq!(json["gitKind"], serde_json::json!("repo"));
        let plain_json = serde_json::to_value(plain).expect("serialize");
        assert!(plain_json.get("gitRepo").is_none());
        assert!(plain_json.get("gitKind").is_none());
    }

    #[test]
    fn lists_source_directory_marks_git_file_as_worktree() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("wt")).unwrap();
        fs::write(
            root.path().join("wt").join(".git"),
            "gitdir: /parent/.git/worktrees/wt\n",
        )
        .unwrap();
        let entries = list_source_directory(root.path().to_str().unwrap()).unwrap();
        let worktree = entries
            .iter()
            .find(|entry| entry.name == "wt")
            .expect("worktree entry");
        assert!(worktree.git_repo, ".git file must set gitRepo");
        assert_eq!(worktree.git_kind, Some(SourceGitKind::Worktree));
        let json = serde_json::to_value(worktree).expect("serialize");
        assert_eq!(json["gitKind"], serde_json::json!("worktree"));
    }

    /// 反证②的正面形态：`.git` 元数据不可解析时降级为 null，列举本身必须成功。
    #[test]
    fn lists_source_directory_survives_unresolvable_git_marker() {
        let root = tempdir().unwrap();
        let entry = root.path().join("weird");
        fs::create_dir_all(&entry).unwrap();
        let marker = entry.join(".git");
        #[cfg(unix)]
        std::os::unix::fs::symlink("/nonexistent/target", &marker).expect("dangling symlink");
        #[cfg(windows)]
        {
            if let Err(error) =
                std::os::windows::fs::symlink_file(entry.join("missing-target"), &marker)
            {
                eprintln!("symlink fixture unavailable on this host: {error}");
                return;
            }
        }
        let entries = list_source_directory(root.path().to_str().unwrap()).unwrap();
        let weird = entries
            .iter()
            .find(|listed| listed.name == "weird")
            .expect("weird entry survives listing");
        assert!(!weird.git_repo);
        assert_eq!(weird.git_kind, None);
    }

    /// 真实目录夹具：由 runner 通过 `XIHE_SOURCE_GIT_PROBE_DIR` 传入（只读），未设置则跳过。
    /// 不把机器路径写进测试，符合「路径相对 one 根书写」的约束。
    #[test]
    fn probes_real_git_directory_when_fixture_env_provided() {
        let Ok(directory) = std::env::var("XIHE_SOURCE_GIT_PROBE_DIR") else {
            return;
        };
        let entries = list_source_directory(&directory).expect("list real directory");
        let repo = entries
            .iter()
            .find(|entry| entry.git_repo)
            .expect("real fixture must contain at least one git-marked directory");
        eprintln!(
            "REAL_GIT_PROBE {}",
            serde_json::to_string(repo).expect("serialize probe")
        );
        assert!(repo.git_kind.is_some());
    }

    #[tokio::test]
    async fn cancelled_import_removes_partial_target() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target_root = root.path().join("target-root");
        fs::create_dir_all(&source).unwrap();
        for index in 0..1000 {
            fs::write(source.join(format!("file-{index}.txt")), "data").unwrap();
        }
        let manager = ImportManager::new();
        let started = manager
            .start(
                "ws-cancel".to_string(),
                target_root.clone(),
                ImportRequest {
                    import_id: None,
                    source_path: source.to_string_lossy().to_string(),
                    exclude_rules: Vec::new(),
                },
            )
            .await
            .unwrap();
        manager.cancel(&started.import_id).await.unwrap();
        let status = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let current = manager.get(&started.import_id).await.unwrap();
                if current.status != "running" {
                    break current;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(status.status, "cancelled");
        assert!(!target_root.join("ws-cancel").exists());
    }
}
