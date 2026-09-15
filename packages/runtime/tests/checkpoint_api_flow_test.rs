//! PLAN-0328 M2 W2 — Run-checkpoint service integration flow against real host git.
//!
//! One end-to-end host flow at the service boundary the HTTP handlers call:
//! create base (mutation lease acquired) → sandbox-side write → seal (lease
//! released) reports the changed files; a reseal is idempotent; a following run
//! sees a clean base (cross-run isolation). Complements the endpoint-level
//! handler tests in `src/main.rs`.

use tempfile::TempDir;
use xihe_runtime::checkpoint_api::{CheckpointService, SealOutcome, StatusFailure};

const WS: &str = "ws-flow";

fn changed(sealed: &SealOutcome) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = sealed
        .changed_files
        .iter()
        .map(|file| (file.status.clone(), file.path.clone()))
        .collect();
    rows.sort();
    rows
}

#[tokio::test]
async fn w2_flow_create_write_seal_reports_changed_files_and_releases_the_lease() {
    let temp = TempDir::new().expect("fixture tempdir");
    std::fs::create_dir_all(temp.path().join(WS)).expect("fixture workspace");
    let ws = temp.path().join(WS);
    std::fs::write(ws.join("notes.md"), "before\n").expect("fixture notes");
    let service = CheckpointService::new(temp.path());
    let diagnostics = service.diagnostics().await;
    assert!(
        diagnostics.capable,
        "W2 integration flow requires a real host git >= 2.20: {diagnostics:?}"
    );

    let created = service
        .create_base(WS, "run-flow", Some("integration"), Some("call-flow"))
        .await
        .expect("create base");
    assert_eq!(created.state, "base");
    assert_eq!(created.run_id, "run-flow");
    assert_eq!(created.base_ref, "refs/xihe/run-flow/base");
    assert!(
        uuid::Uuid::parse_str(&created.checkpoint_id).is_ok(),
        "checkpointId must be a UUID: {}",
        created.checkpoint_id
    );
    assert_eq!(
        service.leases().active_workspaces(),
        vec![WS.to_string()],
        "create must acquire the workspace mutation lease"
    );

    // Sandbox-side writes land directly in the workspace bind mount.
    std::fs::create_dir_all(ws.join("src")).expect("fixture dirs");
    std::fs::write(ws.join("src/new.txt"), "created during the run\n").expect("write new file");
    std::fs::write(ws.join("notes.md"), "after\n").expect("modify notes");

    let sealed = service
        .seal(WS, "run-flow", false)
        .await
        .expect("seal the run");
    assert_eq!(sealed.state, "sealed");
    assert_eq!(sealed.end_ref, "refs/xihe/run-flow/end");
    assert_eq!(
        changed(&sealed),
        vec![
            ("A".to_string(), "src/new.txt".to_string()),
            ("M".to_string(), "notes.md".to_string()),
        ],
        "the seal change set must contain exactly the files the run touched"
    );
    assert!(!sealed.sealed_with_live_jobs);
    assert!(
        !sealed.sealed_after_abnormal,
        "a seal under the run's own live lease is the normal path"
    );
    assert!(
        service.leases().active_workspaces().is_empty(),
        "seal must release the mutation lease"
    );

    let resealed = service
        .seal(WS, "run-flow", false)
        .await
        .expect("idempotent reseal");
    assert_eq!(
        resealed, sealed,
        "idempotent reseal returns the same result"
    );

    let status = service.status(WS, "run-flow").await.expect("status");
    assert_eq!(status.state, "sealed");
    assert_eq!(status.changed_files, sealed.changed_files);
    assert!(status.base_commit.is_some());
    assert!(status.end_commit.is_some());

    let missing = service
        .status(WS, "run-missing")
        .await
        .expect_err("unknown run must be reported as not found");
    assert!(matches!(missing, StatusFailure::NotFound { .. }));

    // Cross-run isolation: the next run starts from the sealed tree, so a clean
    // run reports an empty change set.
    let second = service
        .create_base(WS, "run-2", None, None)
        .await
        .expect("second run base");
    assert!(second.base_ref.ends_with("run-2/base"));
    let second_sealed = service.seal(WS, "run-2", false).await.expect("second seal");
    assert!(
        second_sealed.changed_files.is_empty(),
        "a clean second run must not inherit the previous run's change set: {:?}",
        second_sealed.changed_files
    );
}
