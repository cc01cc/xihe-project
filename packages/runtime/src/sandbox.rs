use std::collections::HashMap;
use std::sync::OnceLock;

use rmcp::schemars;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Security Profile ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SecurityProfile {
    Strict,
    Coding,
    Isolated,
}

// ── Command Result ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
    pub success: bool,
    pub artifact_id: Option<String>,
}

// ── Background Process (schema only, no host in-memory map) ───────────────
// Jobs are now container-local via /tmp/xihe-jobs state files (PLAN-235 M2).
// This struct remains as the MCP schema for background jobs; runtime no longer
// maintains a host-side pseudo map.

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct BackgroundProcess {
    pub pid: String,
    pub ws_id: String,
    pub command: String,
    pub started_at: String,
    pub status: String,
}

// ── Artifact Store (retained preview for bounded output) ─────────────────

fn artifact_store() -> &'static std::sync::Mutex<HashMap<String, Vec<String>>> {
    static STORE: OnceLock<std::sync::Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    STORE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub fn store_artifact(output: &str, limit: usize) -> String {
    let id = Uuid::new_v4().to_string();
    let lines: Vec<String> = output.lines().map(|l| l.to_string()).collect();
    let stored: Vec<String> = if lines.len() > limit {
        lines[..limit].to_vec()
    } else {
        lines
    };
    artifact_store().lock().unwrap().insert(id.clone(), stored);
    id
}

pub fn read_artifact(id: &str, offset: Option<usize>, limit: Option<usize>) -> Option<Vec<String>> {
    let store = artifact_store().lock().unwrap();
    let lines = store.get(id)?;
    let start = offset.unwrap_or(0).min(lines.len());
    let end = start + limit.unwrap_or(lines.len()).min(lines.len() - start);
    Some(lines[start..end].to_vec())
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_store_and_read_artifact() {
        let id = store_artifact("line1\nline2\nline3", 10);
        let lines = read_artifact(&id, None, None);
        assert!(lines.is_some());
        assert_eq!(lines.unwrap().len(), 3);
    }

    #[test]
    fn test_store_artifact_truncates() {
        let id = store_artifact("a\nb\nc\nd\ne", 3);
        let lines = read_artifact(&id, None, None).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "a");
        assert_eq!(lines[2], "c");
    }

    #[test]
    fn test_read_artifact_pagination() {
        let id = store_artifact("1\n2\n3\n4\n5", 10);
        let page = read_artifact(&id, Some(1), Some(2)).unwrap();
        assert_eq!(page, vec!["2", "3"]);
    }

    #[test]
    fn test_read_artifact_not_found() {
        assert!(read_artifact("nonexistent", None, None).is_none());
    }
}
