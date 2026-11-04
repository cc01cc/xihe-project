//! PLAN-0639 M8 — revert routed by declared root.
//!
//! The capture side was already per-root (M7: `capture_for_root`). M8 makes the
//! restore side symmetric: a slice that belongs to root B is restored from root B's
//! own shadow repo and work tree. Without it, `run_checkpoints.root_id` would be a
//! label that revert ignores — restoring root B would rewrite the primary root.

use std::path::{Path, PathBuf};

use tempfile::TempDir;
use xihe_runtime::checkpoint::ShadowGit;

const WS: &str = "ws1";

struct Fixture {
    temp: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let temp = TempDir::new().expect("fixture tempdir");
        std::fs::create_dir_all(temp.path().join(WS)).expect("primary root dir");
        let engine = ShadowGit::new(temp.path());
        let capability = engine.probe().await;
        assert!(
            capability.available,
            "M8 per-root revert requires a real host git >= 2.20: {capability:?}"
        );
        Self { temp }
    }

    fn engine(&self) -> ShadowGit {
        ShadowGit::new(self.temp.path())
    }

    fn primary(&self) -> PathBuf {
        self.temp.path().join(WS)
    }

    fn secondary(&self) -> PathBuf {
        self.temp.path().join("root-b")
    }

    fn write(&self, dir: &Path, relative: &str, content: &str) {
        let path = dir.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture dirs");
        }
        std::fs::write(&path, content).expect("fixture write");
    }

    fn read(&self, dir: &Path, relative: &str) -> String {
        std::fs::read_to_string(dir.join(relative)).expect("fixture read")
    }

    fn declare_roots(&self, engine: &ShadowGit) {
        engine.set_declared_roots(
            WS,
            vec![
                (
                    WS.to_string(),
                    self.primary().to_string_lossy().into_owned(),
                ),
                (
                    "root-b".to_string(),
                    self.secondary().to_string_lossy().into_owned(),
                ),
            ],
        );
    }
}

/// The regression this milestone exists for: reverting root B's slice must restore
/// **root B only**. Pre-M8 the resolver always used the primary workspace path and
/// shadow repo, so the same call would have rewritten the primary root instead.
#[tokio::test]
async fn revert_of_a_secondary_root_restores_only_that_root() {
    let fixture = Fixture::new().await;
    fixture.write(&fixture.primary(), "primary.txt", "primary v1\n");
    fixture.write(&fixture.secondary(), "secondary.txt", "secondary v1\n");
    let engine = fixture.engine();
    fixture.declare_roots(&engine);

    // Baseline slices for both roots, then the state each root should revert to.
    engine
        .capture_for_root(WS, WS, "run-1", "fixture", "call-1", false)
        .await
        .expect("primary baseline");
    engine
        .capture_for_root(WS, "root-b", "run-1", "fixture", "call-1", false)
        .await
        .expect("secondary baseline");

    fixture.write(&fixture.primary(), "primary.txt", "primary v2\n");
    fixture.write(&fixture.secondary(), "secondary.txt", "secondary v2\n");
    engine
        .capture_for_root(WS, WS, "run-2", "fixture", "call-2", false)
        .await
        .expect("primary v2");
    let secondary_v2 = engine
        .capture_for_root(WS, "root-b", "run-2", "fixture", "call-2", false)
        .await
        .expect("secondary v2");
    let secondary_slice = secondary_v2.slice_ref.expect("secondary slice ref");

    // Diverge both roots after the slice, then revert only the secondary one.
    fixture.write(&fixture.primary(), "primary.txt", "primary dirty\n");
    fixture.write(&fixture.secondary(), "secondary.txt", "secondary dirty\n");

    let result = engine
        .restore_execute_for_root(WS, Some("root-b"), &secondary_slice, &[], false, &[])
        .await
        .expect("restore of the secondary root must succeed");
    assert_eq!(
        result.counts.restored, 1,
        "exactly the secondary file restores"
    );
    assert_eq!(
        fixture.read(&fixture.secondary(), "secondary.txt"),
        "secondary v2\n"
    );
    assert_eq!(
        fixture.read(&fixture.primary(), "primary.txt"),
        "primary dirty\n",
        "reverting root B must not touch the primary root"
    );
}

/// Equivalence guard: no `rootId` (or the workspace id itself) keeps the pre-M8
/// primary-root behavior byte-for-byte.
#[tokio::test]
async fn revert_without_a_root_id_stays_on_the_primary_root() {
    let fixture = Fixture::new().await;
    fixture.write(&fixture.primary(), "primary.txt", "v1\n");
    let engine = fixture.engine();
    fixture.declare_roots(&engine);

    engine
        .capture_for_root(WS, WS, "run-1", "fixture", "call-1", false)
        .await
        .expect("baseline");
    fixture.write(&fixture.primary(), "primary.txt", "v2\n");
    let slice = engine
        .capture_for_root(WS, WS, "run-2", "fixture", "call-2", false)
        .await
        .expect("v2")
        .slice_ref
        .expect("slice ref");
    fixture.write(&fixture.primary(), "primary.txt", "dirty\n");

    let result = engine
        .restore_execute(WS, &slice, &[])
        .await
        .expect("primary restore");
    assert_eq!(result.counts.restored, 1);
    assert_eq!(fixture.read(&fixture.primary(), "primary.txt"), "v2\n");

    // An explicit primary root id is the same request, not a new surface.
    fixture.write(&fixture.primary(), "primary.txt", "dirty again\n");
    let again = engine
        .restore_execute_for_root(WS, Some(WS), &slice, &[], false, &[])
        .await
        .expect("explicit primary root restore");
    assert_eq!(again.counts.restored, 1);
    assert_eq!(fixture.read(&fixture.primary(), "primary.txt"), "v2\n");
}

/// An unknown declared root fails closed (404-equivalent) instead of silently
/// falling back to the primary root's shadow repo.
#[tokio::test]
async fn revert_of_an_unknown_root_fails_closed() {
    let fixture = Fixture::new().await;
    fixture.write(&fixture.primary(), "primary.txt", "v1\n");
    let engine = fixture.engine();
    fixture.declare_roots(&engine);

    let slice = engine
        .capture_for_root(WS, WS, "run-1", "fixture", "call-1", false)
        .await
        .expect("baseline")
        .slice_ref
        .expect("slice ref");

    let error = engine
        .restore_preview_for_root(WS, Some("root-unknown"), &slice)
        .await
        .expect_err("unknown root must not resolve");
    assert!(
        matches!(
            error,
            xihe_runtime::checkpoint_revert::RestoreError::SliceNotFound(_)
        ),
        "unknown root must be a not-found, got {error:?}"
    );
}
