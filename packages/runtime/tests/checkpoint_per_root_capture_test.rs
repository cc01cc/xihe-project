//! PLAN-0639 M7 (VM11/VM13) — per-root capture routing against real host git.
//!
//! VM11: `capture_for_root` routes to the declared root's own shadow repo and work
//! tree, and the primary form stays byte-for-byte identical to pre-M7.
//! VM13: a declared root nested inside the captured root is excluded from that
//! root's slice (it is captured by its own chain), so the parent never flattens or
//! overwrites the child.
//!
//! Change sets are only reported against a previous slice (the first capture of a
//! chain has no predecessor), so every assertion below compares a second capture.

use std::path::{Path, PathBuf};
use std::process::Command;

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
            "M7 per-root capture requires a real host git >= 2.20: {capability:?}"
        );
        Self { temp }
    }

    fn engine(&self) -> ShadowGit {
        ShadowGit::new(self.temp.path())
    }

    fn primary(&self) -> PathBuf {
        self.temp.path().join(WS)
    }

    fn nested(&self) -> PathBuf {
        self.primary().join("vendor").join("lib")
    }

    fn write(&self, absolute_dir: &Path, relative: &str, content: &str) {
        let path = absolute_dir.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture dirs");
        }
        std::fs::write(&path, content).expect("fixture write");
    }

    /// Register the declared roots the way production does (one ordered set handed
    /// to the engine before any capture).
    fn declare_nested_root(&self, engine: &ShadowGit) {
        engine.set_declared_roots(
            WS,
            vec![
                (
                    WS.to_string(),
                    self.primary().to_string_lossy().into_owned(),
                ),
                (
                    "root-nested".to_string(),
                    self.nested().to_string_lossy().into_owned(),
                ),
            ],
        );
    }
}

fn shadow_refs(shadow_dir: &Path) -> Vec<String> {
    let output = Command::new("git")
        .args(["--git-dir"])
        .arg(shadow_dir)
        .args(["for-each-ref", "refs/xihe/slices/"])
        .output()
        .expect("git for-each-ref");
    assert!(output.status.success(), "for-each-ref failed");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// VM11: the primary capture path reports the workspace id as its root and writes
/// the legacy `<wsId>.git` shadow repo — the pre-M7 shape.
#[tokio::test]
async fn primary_capture_reports_the_workspace_root_and_legacy_shadow() {
    let fixture = Fixture::new().await;
    fixture.write(&fixture.primary(), "src/main.ts", "export const a = 1;\n");
    let engine = fixture.engine();

    let outcome = engine
        .capture(WS, "run-1", "fixture", "call-1", false)
        .await
        .expect("primary capture");
    assert_eq!(
        outcome.root_id, WS,
        "primary capture keeps root_id = workspaceId"
    );
    assert!(outcome.slice_ref.is_some());

    let legacy_shadow = fixture
        .temp
        .path()
        .join(".xihe-shadow")
        .join(format!("{WS}.git"));
    assert!(
        legacy_shadow.is_dir(),
        "legacy shadow path must be unchanged"
    );
    assert_eq!(shadow_refs(&legacy_shadow).len(), 1);
}

/// VM11 (the actual gap): before M7 a second declared root was a silent no-op —
/// `capture` only ever looked at the workspace path. Now the same run captures the
/// secondary root into its own shadow repo with its own slice chain.
#[tokio::test]
async fn secondary_root_capture_uses_its_own_shadow_and_chain() {
    let fixture = Fixture::new().await;
    fixture.write(&fixture.primary(), "src/main.ts", "primary\n");
    fixture.write(&fixture.nested(), "lib.rs", "pub fn f() {}\n");
    let engine = fixture.engine();
    fixture.declare_nested_root(&engine);

    let primary = engine
        .capture_for_root(WS, WS, "run-1", "fixture", "call-1", false)
        .await
        .expect("primary capture");
    let secondary = engine
        .capture_for_root(WS, "root-nested", "run-1", "fixture", "call-1", false)
        .await
        .expect("secondary capture");

    assert_eq!(primary.root_id, WS);
    assert_eq!(secondary.root_id, "root-nested");
    assert!(
        secondary.slice_ref.is_some(),
        "secondary root must produce a slice"
    );
    assert_ne!(secondary.slice_ref, primary.slice_ref);

    let secondary_shadow = fixture
        .temp
        .path()
        .join(".xihe-shadow")
        .join("root-nested.git");
    assert!(
        secondary_shadow.is_dir(),
        "secondary root gets its own shadow repo"
    );
    assert_eq!(shadow_refs(&secondary_shadow).len(), 1);
    // The primary shadow must not have received the secondary root's slice.
    let primary_shadow = fixture
        .temp
        .path()
        .join(".xihe-shadow")
        .join(format!("{WS}.git"));
    assert_eq!(shadow_refs(&primary_shadow).len(), 1);
}

/// VM13 (D39-5b①): the parent root's slice excludes the nested declared root, so a
/// file that only the child owns never enters the parent tree — while the parent's
/// own file does.
#[tokio::test]
async fn parent_capture_excludes_a_nested_declared_root() {
    let fixture = Fixture::new().await;
    fixture.write(&fixture.primary(), "top.txt", "top\n");
    let engine = fixture.engine();
    fixture.declare_nested_root(&engine);

    engine
        .capture_for_root(WS, WS, "run-1", "fixture", "call-1", false)
        .await
        .expect("baseline capture");

    fixture.write(&fixture.primary(), "top.txt", "top v2\n");
    fixture.write(&fixture.nested(), "child.txt", "child\n");
    let primary = engine
        .capture_for_root(WS, WS, "run-2", "fixture", "call-2", false)
        .await
        .expect("second capture");

    let changed: Vec<String> = primary
        .changed_files
        .iter()
        .map(|file| file.path.clone())
        .collect();
    assert!(
        changed.iter().any(|path| path == "top.txt"),
        "parent root content must be captured: {changed:?}"
    );
    assert!(
        !changed.iter().any(|path| path.contains("vendor/lib")),
        "nested declared root must not enter the parent slice: {changed:?}"
    );

    // The child root captures its own content independently.
    engine
        .capture_for_root(WS, "root-nested", "run-1", "fixture", "call-1", false)
        .await
        .expect("child baseline");
    fixture.write(&fixture.nested(), "child.txt", "child v2\n");
    let child = engine
        .capture_for_root(WS, "root-nested", "run-2", "fixture", "call-2", false)
        .await
        .expect("child second capture");
    let child_paths: Vec<String> = child.changed_files.iter().map(|f| f.path.clone()).collect();
    assert!(
        child_paths.iter().any(|path| path == "child.txt"),
        "child root must own its content: {child_paths:?}"
    );
}

/// VM13 guard: with **no** declared roots (every legacy single-root workspace and
/// every pre-M7 fixture) the parent capture is unchanged — the nested directory is
/// ordinary content that still belongs to the primary slice.
#[tokio::test]
async fn without_declared_roots_nested_directory_stays_in_the_parent_slice() {
    let fixture = Fixture::new().await;
    fixture.write(&fixture.primary(), "top.txt", "top\n");
    let engine = fixture.engine();

    engine
        .capture_for_root(WS, WS, "run-1", "fixture", "call-1", false)
        .await
        .expect("baseline capture");

    fixture.write(&fixture.nested(), "child.txt", "child\n");
    let primary = engine
        .capture_for_root(WS, WS, "run-2", "fixture", "call-2", false)
        .await
        .expect("second capture");

    let changed: Vec<String> = primary
        .changed_files
        .iter()
        .map(|file| file.path.clone())
        .collect();
    assert!(
        changed.iter().any(|path| path.contains("child.txt")),
        "no declared roots ⇒ byte-identical to pre-M7 capture: {changed:?}"
    );
}
