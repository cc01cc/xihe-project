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
        entries.push(SourceDirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: file_type.to_string(),
            readable: metadata.permissions().readonly() || fs::File::open(entry.path()).is_ok(),
            size: metadata.len(),
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
        fs::write(source.join("src/main.ts"), "export const value = 1;\n").unwrap();
        fs::write(source.join("node_modules/ignored.js"), "ignored\n").unwrap();

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
        assert!(!target_root.join("ws-1/node_modules/ignored.js").exists());
        assert_eq!(status.files_copied, 1);
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
