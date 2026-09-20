use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use notify::event::EventKind;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;

use crate::ws_file_handler::{report_workspace_event, report_workspace_snapshot_required};

const EVENT_BUFFER: usize = 256;

/// Host filesystem event adapters, one bounded watcher per materialized
/// Workspace. CP remains the sequence authority; Runtime only emits relative
/// path/change hints and never sends host paths.
#[derive(Clone, Default)]
pub(crate) struct WorkspaceEventWatchers {
    handles: Arc<Mutex<HashMap<String, WatchHandle>>>,
}

struct WatchHandle {
    _watcher: RecommendedWatcher,
    watch_task: JoinHandle<()>,
    publish_task: JoinHandle<()>,
}

struct PendingEvent {
    workspace_id: String,
    path: Option<String>,
    change_type: Option<&'static str>,
    snapshot_required: bool,
}

impl WorkspaceEventWatchers {
    pub(crate) async fn ensure(
        &self,
        workspace_id: &str,
        workspace_path: &str,
    ) -> Result<(), String> {
        let mut handles = self.handles.lock().await;
        if handles.contains_key(workspace_id) {
            return Ok(());
        }
        let raw_root = PathBuf::from(workspace_path);
        if workspace_path.trim().is_empty() || !raw_root.is_absolute() {
            return Err("WATCHER_ROOT_INVALID".to_string());
        }
        let root = std::fs::canonicalize(&raw_root)
            .map_err(|_| "WATCHER_ROOT_CANONICALIZE_FAILED".to_string())?;
        if !root.is_dir() {
            return Err("WATCHER_ROOT_NOT_DIRECTORY".to_string());
        }
        let (sender, mut receiver) =
            mpsc::channel::<Result<notify::Event, notify::Error>>(EVENT_BUFFER);
        let overflow = Arc::new(AtomicBool::new(false));
        let sender_for_callback = sender.clone();
        let overflow_for_callback = overflow.clone();
        let mut watcher = notify::recommended_watcher(move |event| {
            if sender_for_callback.try_send(event).is_err() {
                overflow_for_callback.store(true, Ordering::Release);
            }
        })
        .map_err(|_| "WATCHER_INIT_FAILED".to_string())?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|_| "WATCHER_START_FAILED".to_string())?;

        let id = workspace_id.to_string();
        let task_root = root.clone();
        let (publish_sender, mut publish_receiver) = mpsc::channel::<PendingEvent>(EVENT_BUFFER);
        let watch_overflow = overflow.clone();
        let watch_id = id.clone();
        let watch_task = tokio::spawn(async move {
            while let Some(result) = receiver.recv().await {
                if watch_overflow.swap(false, Ordering::AcqRel)
                    && publish_sender
                        .try_send(PendingEvent {
                            workspace_id: watch_id.clone(),
                            path: None,
                            change_type: None,
                            snapshot_required: true,
                        })
                        .is_err()
                {
                    watch_overflow.store(true, Ordering::Release);
                }
                match result {
                    Ok(event) => {
                        let Some(change_type) = change_type(&event.kind) else {
                            continue;
                        };
                        for path in event.paths {
                            let Some(relative) = relative_path(&task_root, &path) else {
                                continue;
                            };
                            if publish_sender
                                .try_send(PendingEvent {
                                    workspace_id: watch_id.clone(),
                                    path: Some(relative),
                                    change_type: Some(change_type),
                                    snapshot_required: false,
                                })
                                .is_err()
                            {
                                watch_overflow.store(true, Ordering::Release);
                                break;
                            }
                        }
                    }
                    Err(_error) => {
                        tracing::warn!(
                            "workspace filesystem watcher failed workspaceId={} errorCode=WATCHER_EVENT_FAILED",
                            id
                        );
                    }
                }
            }
        });
        let publish_task = tokio::spawn(async move {
            let mut recent_events: HashMap<(String, &'static str), Instant> = HashMap::new();
            while let Some(event) = publish_receiver.recv().await {
                if event.snapshot_required {
                    report_workspace_snapshot_required(&event.workspace_id).await;
                } else if let (Some(path), Some(change_type)) = (event.path, event.change_type) {
                    let now = Instant::now();
                    recent_events.retain(|_, seen_at| {
                        now.saturating_duration_since(*seen_at) < Duration::from_millis(100)
                    });
                    if recent_events
                        .insert((path.clone(), change_type), now)
                        .is_some()
                    {
                        continue;
                    }
                    report_workspace_event(&event.workspace_id, &path, change_type).await;
                }
            }
        });
        handles.insert(
            workspace_id.to_string(),
            WatchHandle {
                _watcher: watcher,
                watch_task,
                publish_task,
            },
        );
        Ok(())
    }

    pub(crate) async fn stop(&self, workspace_id: &str) {
        if let Some(handle) = self.handles.lock().await.remove(workspace_id) {
            handle.watch_task.abort();
            handle.publish_task.abort();
        }
    }
}

fn change_type(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Remove(_) => Some("deleted"),
        EventKind::Modify(_) => Some("modified"),
        _ => None,
    }
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let relative = relative.trim_matches('/');
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.contains(':')
        || relative.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(relative.to_string())
}

#[cfg(test)]
mod tests {
    use super::{change_type, relative_path};
    use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
    use std::path::Path;

    #[test]
    fn relative_path_never_returns_host_root_or_parent_paths() {
        assert_eq!(
            relative_path(Path::new("C:/work/ws"), Path::new("C:/work/ws/src/a.ts")),
            Some("src/a.ts".to_string())
        );
        assert_eq!(
            relative_path(Path::new("C:/work/ws"), Path::new("C:/work/other/a.ts")),
            None
        );
        assert_eq!(
            relative_path(Path::new("C:/work/ws"), Path::new("C:/work/ws/../secret")),
            None
        );
    }

    #[test]
    fn maps_notify_kinds_to_contract_change_types() {
        assert_eq!(
            change_type(&EventKind::Create(CreateKind::File)),
            Some("created")
        );
        assert_eq!(
            change_type(&EventKind::Remove(RemoveKind::File)),
            Some("deleted")
        );
        assert_eq!(
            change_type(&EventKind::Modify(ModifyKind::Any)),
            Some("modified")
        );
    }
}
