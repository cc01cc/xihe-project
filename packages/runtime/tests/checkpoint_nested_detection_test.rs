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
use xihe_runtime::checkpoint::{CaptureOutcome, SHADOW_DIR_NAME, ShadowGit};

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

#[tokio::test]
async fn detect_endpoint_lists_undeclared_and_flags_declared_roots() {
    let fixture = Fixture::new().await;
    fixture.make_nested_repo("vendor/lib", "README.md");
    // A bare repo is invisible to gitlink detection — caught by the one-level
    // readdir heuristic (design §6.1 / D41-7: never a recursive walk).
    let bare = fixture.ws().join("mirror.git");
    std::fs::create_dir_all(bare.join("objects")).expect("bare objects");
    std::fs::create_dir_all(bare.join("refs")).expect("bare refs");
    std::fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").expect("bare HEAD");

    // Cold probe before any capture: both candidates, bare typed via readdir.
    let items = fixture
        .engine
        .detect_nested_repos(WS)
        .await
        .expect("cold probe");
    let summary: Vec<String> = items
        .iter()
        .map(|item| {
            format!(
                "{}={} declared={}",
                item.path,
                item.kind.as_wire(),
                item.declared
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            "mirror.git=bare declared=false".to_string(),
            "vendor/lib=nested declared=false".to_string(),
        ],
        "depth-ascending discovery with five-kind types: {summary:?}",
    );
    // Wire shape: F4 renames the Rust keyword to `type`.
    let first = serde_json::to_value(&items[0]).expect("serialize item");
    assert_eq!(first["type"], "bare", "F4 wire name: {first}");
    assert!(
        !fixture.temp.path().join(SHADOW_DIR_NAME).exists(),
        "detection never touches the real shadow store"
    );

    // Declare the nested root → the re-probe labels it instead of re-offering.
    fixture.engine.set_declared_roots(
        WS,
        vec![
            (WS.to_string(), fixture.ws().to_string_lossy().into_owned()),
            (
                "root-vendor".to_string(),
                fixture
                    .ws()
                    .join("vendor")
                    .join("lib")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ],
    );
    let after = fixture
        .engine
        .detect_nested_repos(WS)
        .await
        .expect("probe after declare");
    let vendor = after
        .iter()
        .find(|item| item.path == "vendor/lib")
        .expect("declared repo still visible");
    assert_eq!(
        vendor.kind,
        xihe_runtime::nested_repo_kind::NestedRepoKind::Nested
    );
    assert!(
        vendor.declared,
        "declared roots are labelled, not re-offered"
    );
    assert!(
        after
            .iter()
            .any(|item| item.path == "mirror.git" && !item.declared),
        "undeclared bare repo still listed"
    );

    // Classify-only mode (CP cache warm from a capture's `nestedRepos`).
    let classified = fixture
        .engine
        .classify_nested_repos(WS, &["vendor/lib".to_string(), "mirror.git".to_string()])
        .expect("classify");
    let kinds: Vec<&str> = classified.iter().map(|item| item.kind.as_wire()).collect();
    assert_eq!(
        kinds,
        vec!["bare", "nested"],
        "classify-only sorts too: {kinds:?}"
    );
    assert!(classified[1].declared, "classify-only keeps declared flags");
}

/**
 * PLAN-0641 M2 T3.5 (B10 / D41-25, the M2 acceptance gate): a repository nested
 * INSIDE an already declared root must surface too — the probe recurses into each
 * declared root once, and its inner paths stay workspace-relative.
 */
#[tokio::test]
async fn detect_recurses_into_declared_roots_for_b10() {
    let fixture = Fixture::new().await;
    // The declared root is itself a repository and holds a deeper nested repo.
    fixture.make_nested_repo("vendor/lib", "README.md");
    let inner = fixture.ws().join("vendor").join("lib").join("inner");
    std::fs::create_dir_all(&inner).expect("inner dir");
    std::fs::write(inner.join("main.rs"), "fn main() {}\n").expect("inner file");
    git_in(&inner, &["init"]);
    git_in(&inner, &["add", "-A"]);
    git_in(&inner, &["commit", "-m", "inner initial"]);

    fixture.engine.set_declared_roots(
        WS,
        vec![
            (WS.to_string(), fixture.ws().to_string_lossy().into_owned()),
            (
                "root-vendor".to_string(),
                fixture
                    .ws()
                    .join("vendor")
                    .join("lib")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ],
    );

    let items = fixture.engine.detect_nested_repos(WS).await.expect("probe");
    let summary: Vec<String> = items
        .iter()
        .map(|item| {
            format!(
                "{}={} declared={}",
                item.path,
                item.kind.as_wire(),
                item.declared
            )
        })
        .collect();
    // The declared root is labelled from the primary scope (never re-offered).
    assert!(
        summary.contains(&"vendor/lib=nested declared=true".to_string()),
        "{summary:?}"
    );
    // B10: the repository nested inside the declared root is discovered again.
    assert!(
        summary.contains(&"vendor/lib/inner=nested declared=false".to_string()),
        "nested-inside-declared must surface with a workspace-relative path: {summary:?}"
    );
    let lib = summary
        .iter()
        .position(|entry| entry.starts_with("vendor/lib="))
        .expect("declared root row");
    let inner_row = summary
        .iter()
        .position(|entry| entry.starts_with("vendor/lib/inner="))
        .expect("inner row");
    assert!(lib < inner_row, "parents before children: {summary:?}");
}
