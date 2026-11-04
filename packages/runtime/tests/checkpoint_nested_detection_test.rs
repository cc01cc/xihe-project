//! PLAN-0641 T2.1 — capture discovers nested repositories (D41-24, contract F1).
//!
//! Judge (tasks T2.1): a parent root holding 2 nested repos lists both in the
//! outcome's `nestedRepos`, depth-ascending (parents before children, independent
//! of creation order), while the flatten policy stays untouched — 0361 semantics
//! (contents become ordinary blobs, `opaqueNestedRepos` stays empty) and the
//! discovery field is internal wire only: absent from the JSON when nothing is
//! found, and ignored by readers that predate it.

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xihe_runtime::checkpoint::{CaptureOutcome, ShadowGit};

const WS: &str = "ws1";

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

fn git_in(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", null_device())
        .env("GIT_CONFIG_SYSTEM", null_device())
        .env("GIT_AUTHOR_NAME", "fixture-user")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.com")
        .env("GIT_COMMITTER_NAME", "fixture-user")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.com")
        .output()
        .expect("spawn git");
    assert!(
        output.status.success(),
        "git {args:?} failed in {}: status {:?}\nstdout: {}\nstderr: {}",
        dir.display(),
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

/// Slice tree listing (the proof surface for flatten): what the shadow store
/// actually holds for one capture commit.
fn shadow_ls_tree(fixture: &Fixture, commit: &str) -> String {
    let shadow = fixture.engine.shadow_git_dir(WS).expect("shadow dir");
    let output = Command::new("git")
        .args(["--git-dir"])
        .arg(&shadow)
        .args(["ls-tree", "-r", "--name-only", commit])
        .output()
        .expect("spawn git ls-tree");
    assert!(
        output.status.success(),
        "git ls-tree failed: status {:?}\nstderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8_lossy(&output.stdout).to_string()
}

struct Fixture {
    temp: TempDir,
    engine: ShadowGit,
}

impl Fixture {
    async fn new() -> Self {
        let temp = TempDir::new().expect("fixture tempdir");
        std::fs::create_dir_all(temp.path().join(WS)).expect("primary root dir");
        let engine = ShadowGit::new(temp.path());
        let capability = engine.probe().await;
        assert!(
            capability.available,
            "T2.1 discovery test requires a real host git >= 2.20: {capability:?}"
        );
        Self { temp, engine }
    }

    fn ws(&self) -> PathBuf {
        self.temp.path().join(WS)
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.ws().join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture dirs");
        }
        std::fs::write(&path, content).expect("fixture write");
    }

    /// A real embedded repository (git only records mode 160000 for valid `.git`s).
    fn make_nested_repo(&self, relative: &str, file: &str) {
        let dir = self.ws().join(relative);
        std::fs::create_dir_all(&dir).expect("nested dir");
        std::fs::write(dir.join(file), "nested content\n").expect("nested file");
        git_in(&dir, &["init"]);
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-m", "nested initial"]);
    }

    async fn capture(&self, run_id: &str) -> CaptureOutcome {
        self.engine
            .capture(WS, run_id, "t21", "call-t21", false)
            .await
            .expect("capture")
    }
}

#[tokio::test]
async fn capture_reports_nested_repos_depth_ascending_and_still_flattens() {
    let fixture = Fixture::new().await;

    // Creation order is deliberately reversed against the expected output so the
    // assertion proves depth-ascending sorting, not insertion order.
    fixture.make_nested_repo("deep/nested", "README.md");
    fixture.make_nested_repo("top", "main.rs");
    fixture.write("plain.txt", "ordinary file\n");

    let outcome = fixture.capture("run-t21-a").await;
    assert_eq!(
        outcome.nested_repos,
        vec!["top".to_string(), "deep/nested".to_string()],
        "both nested repos, parents before children: {:?}",
        outcome.nested_repos
    );
    assert!(
        outcome.opaque_nested_repos.is_empty(),
        "flatten policy unchanged: nothing stays opaque: {:?}",
        outcome.opaque_nested_repos
    );
    // `changed_files` is only diffed against a previous slice (first capture has
    // no predecessor), so flatten is proven against the slice tree itself.
    let tree = shadow_ls_tree(
        &fixture,
        outcome
            .commit
            .as_deref()
            .expect("first capture writes a slice"),
    );
    assert!(
        tree.contains("deep/nested/README.md") && tree.contains("top/main.rs"),
        "flatten still stages nested contents as ordinary blobs: {tree}"
    );
    assert!(
        !tree
            .lines()
            .any(|line| line == ".git" || line.starts_with(".git/")),
        "no .git ever enters the shadow store: {tree}"
    );

    // MECHANISM (measured, T2.1): the list reports what THIS staging pass
    // detected. Under the flatten policy the first capture converted the repos
    // into ordinary blobs, so a later pass — whose index is seeded from the tail
    // — sees no new gitlink (160000) entry. The authoritative per-workspace list
    // for the首屏 screen is therefore the on-demand probe (T2.3, re-stages the
    // worktree); capture warms the cache whenever detection fires (first run,
    // newly added repos). Persisting it instead would violate "不落 durable".
    let again = fixture.capture("run-t21-b").await;
    assert!(again.no_change, "second capture has no changes");
    assert!(
        again.nested_repos.is_empty(),
        "a tail-seeded pass reports no new gitlinks: {:?}",
        again.nested_repos,
    );

    // A NEW nested repo added later is detected again (discovery is per-capture).
    fixture.make_nested_repo("later/new", "README.md");
    let third = fixture.capture("run-t21-c2").await;
    assert!(!third.no_change, "the new repo changes the slice");
    assert_eq!(
        third.nested_repos,
        vec!["later/new".to_string()],
        "newly added nested repos are discovered: {:?}",
        third.nested_repos,
    );
}

#[tokio::test]
async fn nested_repos_wire_field_is_optional_and_absent_when_nothing_found() {
    let fixture = Fixture::new().await;
    fixture.write("plain.txt", "ordinary file\n");

    let empty = fixture.capture("run-t21-c").await;
    let json = serde_json::to_string(&empty).expect("serialize outcome");
    assert!(
        !json.contains("nestedRepos"),
        "byte-identical body when nothing is found: {json}"
    );

    // Readers that predate the field never required it: dropping `nestedRepos`
    // yields exactly the frozen body (old readers see no new key at all; when the
    // key IS present, CP-side Jackson ignores unknown fields).
    fixture.make_nested_repo("vendor/lib", "README.md");
    let discovered = fixture.capture("run-t21-d").await;
    assert_eq!(
        discovered.nested_repos,
        vec!["vendor/lib".to_string()],
        "single nested repo: {:?}",
        discovered.nested_repos
    );
    let mut legacy: serde_json::Value =
        serde_json::to_value(&discovered).expect("serialize discovered");
    let removed = legacy
        .as_object_mut()
        .expect("object body")
        .remove("nestedRepos");
    assert!(removed.is_some(), "discovery body carries the new key");
    let legacy_json = legacy.to_string();
    assert!(
        !legacy_json.contains("nestedRepos"),
        "removal leaves no trace of the new key: {legacy_json}"
    );
    assert!(
        legacy_json.contains("opaqueNestedRepos"),
        "frozen body keys unchanged: {legacy_json}"
    );
}
