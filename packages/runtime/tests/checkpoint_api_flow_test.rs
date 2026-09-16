//! PLAN-0338 T1.0 — slice-model checkpoint service integration flow (real host git).
//!
//! One end-to-end host flow at the service boundary the HTTP handlers call:
//! capture C1 → workspace write → capture C2 reports the changed files; an
//! unchanged capture writes no slice (`noChange`); a same-run replay within the
//! process is idempotent; slice GC counts what is left. Complements the
//! endpoint-level handler tests in `src/main.rs`.

use tempfile::TempDir;
use xihe_runtime::checkpoint_api::{C0_RUN_ID, CheckpointService};

const WS: &str = "ws-flow";

fn sorted(changed: &[xihe_runtime::checkpoint::ChangedFile]) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = changed
        .iter()
        .map(|file| (file.status.clone(), file.path.clone()))
        .collect();
    rows.sort();
    rows
}

#[tokio::test]
async fn slice_flow_capture_write_capture_reports_changes_and_no_change() {
    let temp = TempDir::new().expect("fixture tempdir");
    std::fs::create_dir_all(temp.path().join(WS)).expect("fixture workspace");
    let ws = temp.path().join(WS);
    std::fs::write(ws.join("notes.md"), "before\n").expect("fixture notes");
    let service = CheckpointService::new(temp.path());
    let diagnostics = service.diagnostics().await;
    assert!(
        diagnostics.capable,
        "slice integration flow requires a real host git >= 2.20: {diagnostics:?}"
    );

    // C0 (workspace materialization baseline) uses the reserved run id.
    let c0 = service
        .capture(WS, C0_RUN_ID, "materialize", "materialize", false)
        .await
        .expect("C0 capture");
    assert!(!c0.no_change);
    assert_eq!(c0.state, "captured");
    let c0_ref = c0.slice_ref.clone().expect("C0 slice ref");
    assert!(c0_ref.starts_with("refs/xihe/slices/"));
    assert!(c0.predecessor.is_none());
    assert!(
        c0.captured_at
            .as_deref()
            .is_some_and(|value| value.ends_with('Z')),
        "capturedAt must be RFC3339 UTC: {:?}",
        c0.captured_at
    );

    // Sandbox-side writes land directly in the workspace bind mount.
    std::fs::create_dir_all(ws.join("src")).expect("fixture dirs");
    std::fs::write(ws.join("src/new.txt"), "created during the run\n").expect("write new file");
    std::fs::write(ws.join("notes.md"), "after\n").expect("modify notes");

    let captured = service
        .capture(WS, "run-flow", "integration", "call-flow", false)
        .await
        .expect("capture the run");
    assert!(!captured.no_change);
    assert_eq!(captured.state, "captured");
    assert_eq!(captured.predecessor.as_deref(), Some(c0_ref.as_str()));
    assert_eq!(
        sorted(&captured.changed_files),
        vec![
            ("A".to_string(), "src/new.txt".to_string()),
            ("M".to_string(), "notes.md".to_string()),
        ],
        "the change set is the diff against the previous slice"
    );
    let slice_ref = captured.slice_ref.clone().expect("run slice ref");

    // Same-run replay within this process is idempotent.
    let replay = service
        .capture(WS, "run-flow", "integration", "call-flow", false)
        .await
        .expect("idempotent replay");
    assert_eq!(
        replay, captured,
        "the replayed capture returns the same body"
    );

    // An unchanged workspace captured under another run writes no slice.
    let no_change = service
        .capture(WS, "run-clean", "integration", "call-clean", false)
        .await
        .expect("no-change capture");
    assert!(no_change.no_change);
    assert!(no_change.slice_ref.is_none());
    assert_eq!(no_change.changed_files, Vec::new());
    assert_eq!(no_change.predecessor.as_deref(), Some(slice_ref.as_str()));

    // Abnormal captures are ordinary slices with a different state marker.
    std::fs::write(ws.join("notes.md"), "abnormal\n").expect("modify notes");
    let abnormal = service
        .capture(WS, "run-abnormal", "integration", "call-abnormal", true)
        .await
        .expect("abnormal capture");
    assert_eq!(abnormal.state, "abnormal-captured");
    assert!(!abnormal.no_change);

    // GC counts slices: keep the newest two, delete the older ones.
    let gc = service.gc(WS).await.expect("gc");
    assert_eq!(gc.counts.kept + gc.counts.deleted, 3);
    assert_eq!(
        gc.counts.deleted, 0,
        "the default retention keeps 50 slices"
    );
    assert!(
        service
            .engine()
            .slice_commit(WS, &slice_ref)
            .await
            .expect("slice lookup")
            .is_some(),
        "the captured slice stays resolvable"
    );
}

#[tokio::test]
async fn slice_flow_capture_without_git_reports_unavailable() {
    let temp = TempDir::new().expect("fixture tempdir");
    std::fs::create_dir_all(temp.path().join(WS)).expect("fixture workspace");
    let service =
        CheckpointService::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
    match service
        .capture(WS, "run-1", "integration", "call-1", false)
        .await
    {
        Err(xihe_runtime::checkpoint_api::CaptureFailure::Unavailable { reason, .. }) => {
            assert_eq!(reason, "GIT_UNAVAILABLE");
        }
        other => panic!("expected GIT_UNAVAILABLE, got {other:?}"),
    }
}
