//! PLAN-0641 M5 T6.1/T6.2 — per-root static exclusion profile (B3=(a) graded default).
//!
//! Judges (tasks.md M5):
//! * the primary root keeps the frozen decision-#14 table (safety **and** noise);
//! * a declared root drops the noise class (its own `.gitignore` decides) but keeps the
//!   safety class (credentials / shadow infrastructure never enter a slice);
//! * the default is derived from root identity only — no env var, no config switch (T6.2);
//! * restore planning stages the current tree through the same profile, otherwise a
//!   declared root's noise files would show up as phantom delete entries.

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xihe_runtime::checkpoint::{ExcludeProfile, ShadowGit};

const WS: &str = "ws1";
const DECLARED: &str = "root-declared";

struct Fixture {
    temp: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let temp = TempDir::new().expect("fixture tempdir");
        std::fs::create_dir_all(temp.path().join(WS)).expect("primary root dir");
        std::fs::create_dir_all(temp.path().join("declared-root")).expect("declared root dir");
        let engine = ShadowGit::new(temp.path());
        let capability = engine.probe().await;
        assert!(
            capability.available,
            "per-root exclusion profile requires a real host git >= 2.20: {capability:?}"
        );
        Self { temp }
    }

    fn engine(&self) -> ShadowGit {
        ShadowGit::new(self.temp.path())
    }

    fn primary(&self) -> PathBuf {
        self.temp.path().join(WS)
    }

    fn declared(&self) -> PathBuf {
        self.temp.path().join("declared-root")
    }

    fn write(&self, absolute_dir: &Path, relative: &str, content: &str) {
        let path = absolute_dir.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture dirs");
        }
        std::fs::write(&path, content).expect("fixture write");
    }

    /// Register the declared roots the way production does (one ordered set handed to
    /// the engine before any capture).
    fn declare_roots(&self, engine: &ShadowGit) {
        engine.set_declared_roots(
            WS,
            vec![
                (
                    WS.to_string(),
                    self.primary().to_string_lossy().into_owned(),
                ),
                (
                    DECLARED.to_string(),
                    self.declared().to_string_lossy().into_owned(),
                ),
            ],
        );
    }

    fn shadow(&self, root_id: &str) -> PathBuf {
        self.temp
            .path()
            .join(".xihe-shadow")
            .join(format!("{root_id}.git"))
    }
}

fn tree_paths(shadow: &Path, slice_ref: &str) -> Vec<String> {
    let output = Command::new("git")
        .args(["--git-dir"])
        .arg(shadow)
        .args(["ls-tree", "-r", "--name-only", slice_ref])
        .output()
        .expect("git ls-tree");
    assert!(output.status.success(), "ls-tree failed: {output:?}");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn assert_absent(paths: &[String], prefix: &str) {
    assert!(
        !paths
            .iter()
            .any(|path| path == prefix || path.starts_with(prefix)),
        "excluded path {prefix:?} must not be captured, got {paths:?}"
    );
}

fn assert_present(paths: &[String], expected: &str) {
    assert!(
        paths.iter().any(|path| path == expected),
        "path {expected:?} must be captured, got {paths:?}"
    );
}

/// T6.1 judge 1 + T6.2 default: the primary root keeps the frozen table unchanged.
#[tokio::test]
async fn primary_root_keeps_the_frozen_noise_and_safety_table() {
    let fixture = Fixture::new().await;
    let engine = fixture.engine();
    fixture.declare_roots(&engine);
    fixture.write(&fixture.primary(), "src/main.ts", "export const a = 1;\n");
    fixture.write(
        &fixture.primary(),
        "node_modules/dep/index.js",
        "module.exports = 1;\n",
    );
    fixture.write(&fixture.primary(), "dist/bundle.js", "bundle\n");
    fixture.write(&fixture.primary(), "build/out.txt", "build\n");
    fixture.write(&fixture.primary(), ".cache/blob.bin", "cache\n");
    fixture.write(&fixture.primary(), "secret.pem", "-----BEGIN KEY-----\n");
    fixture.write(&fixture.primary(), ".env", "TOKEN=secret\n");
    fixture.write(&fixture.primary(), "id_rsa", "private\n");

    let outcome = engine
        .capture(WS, "run-primary", "fixture", "call-primary", false)
        .await
        .expect("primary capture");
    let slice_ref = outcome.slice_ref.expect("primary capture writes a slice");
    let paths = tree_paths(&fixture.shadow(WS), &slice_ref);

    assert_present(&paths, "src/main.ts");
    for noise in ["node_modules/", "dist/", "build/", ".cache/"] {
        assert_absent(&paths, noise);
    }
    for safety in ["secret.pem", ".env", "id_rsa"] {
        assert_absent(&paths, safety);
    }
    assert_eq!(
        ExcludeProfile::for_root(WS, WS),
        ExcludeProfile::PrimaryRoot,
        "T6.2: the primary root is derived from root identity, not from a switch"
    );
}

/// T6.1 judge 2 + T6.2 default: a declared root drops noise, keeps safety.
#[tokio::test]
async fn declared_root_drops_noise_but_keeps_safety() {
    let fixture = Fixture::new().await;
    let engine = fixture.engine();
    fixture.declare_roots(&engine);
    fixture.write(&fixture.declared(), "keep.txt", "keep\n");
    fixture.write(
        &fixture.declared(),
        "node_modules/dep/index.js",
        "module.exports = 1;\n",
    );
    fixture.write(&fixture.declared(), "dist/bundle.js", "bundle\n");
    fixture.write(&fixture.declared(), ".cache/blob.bin", "cache\n");
    fixture.write(&fixture.declared(), "secret.pem", "-----BEGIN KEY-----\n");
    fixture.write(&fixture.declared(), ".env", "TOKEN=secret\n");

    let outcome = engine
        .capture_for_root(
            WS,
            DECLARED,
            "run-declared",
            "fixture",
            "call-declared",
            false,
        )
        .await
        .expect("declared-root capture");
    assert_eq!(outcome.root_id, DECLARED);
    let slice_ref = outcome.slice_ref.expect("declared capture writes a slice");
    let paths = tree_paths(&fixture.shadow(DECLARED), &slice_ref);

    assert_present(&paths, "keep.txt");
    assert_present(&paths, "node_modules/dep/index.js");
    assert_present(&paths, "dist/bundle.js");
    assert_present(&paths, ".cache/blob.bin");
    for safety in ["secret.pem", ".env"] {
        assert_absent(&paths, safety);
    }
    assert_eq!(
        ExcludeProfile::for_root(WS, DECLARED),
        ExcludeProfile::DeclaredRoot,
        "T6.2: any non-primary routable root is declared, with no opt-out switch"
    );
}

/// Restore planning must stage the current tree with the same per-root profile: with the
/// primary table a declared slice containing `node_modules/` would look like a set of
/// deletions the user never made.
#[tokio::test]
async fn declared_root_restore_preview_uses_the_same_profile() {
    let fixture = Fixture::new().await;
    let engine = fixture.engine();
    fixture.declare_roots(&engine);
    fixture.write(&fixture.declared(), "keep.txt", "keep\n");
    fixture.write(
        &fixture.declared(),
        "node_modules/dep/index.js",
        "module.exports = 1;\n",
    );

    let outcome = engine
        .capture_for_root(
            WS,
            DECLARED,
            "run-declared-preview",
            "fixture",
            "call-declared-preview",
            false,
        )
        .await
        .expect("declared-root capture");
    let slice_ref = outcome.slice_ref.expect("declared capture writes a slice");

    let preview = engine
        .restore_preview_for_root(WS, Some(DECLARED), &slice_ref)
        .await
        .expect("declared-root preview");
    assert_eq!(
        preview.counts.restore, 0,
        "no changes: {:?}",
        preview.entries
    );
    assert_eq!(
        preview.counts.delete, 0,
        "no changes: {:?}",
        preview.entries
    );
    assert!(
        preview.entries.is_empty(),
        "a quiet declared root must preview no changes, got {:?}",
        preview.entries
    );
}
