//! PLAN-0641 M3 T4.1 — undeclared nested-repo probe used by preview/execute.
//!
//! Judges (tasks T4.1): dirty / clean / HEAD-drifted fixtures each assert their
//! probe result; a plan with no nested ancestor spends **zero** git processes
//! (`git_calls == 0`, the zero-cost short circuit); a submodule-shaped repo is
//! classified as `submodule` (T4.4: marked, never declared).

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xihe_runtime::checkpoint::ShadowGit;

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
        "git {args:?} failed in {}: stdout={} stderr={}",
        dir.display(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

struct Fixture {
    temp: TempDir,
    engine: ShadowGit,
}

impl Fixture {
    async fn new() -> Self {
        let temp = TempDir::new().expect("fixture tempdir");
        std::fs::create_dir_all(temp.path().join(WS)).expect("workspace dir");
        let engine = ShadowGit::new(temp.path());
        let capability = engine.probe().await;
        assert!(capability.available, "host git required: {capability:?}");
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
        std::fs::write(path, content).expect("fixture write");
    }

    /// A real embedded repository (gitlink candidate for the capture side).
    fn make_nested_repo(&self, relative: &str) {
        let dir = self.ws().join(relative);
        std::fs::create_dir_all(&dir).expect("nested dir");
        std::fs::write(dir.join("README.md"), "nested base\n").expect("nested file");
        git_in(&dir, &["init"]);
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-m", "nested base"]);
    }

    async fn capture_commit(&self, run_id: &str) -> String {
        let outcome = self
            .engine
            .capture(WS, run_id, "fixture", "call-fixture", false)
            .await
            .expect("capture");
        outcome.commit.expect("first capture writes a slice")
    }

    async fn probe(
        &self,
        commit: &str,
        paths: &[&str],
    ) -> xihe_runtime::checkpoint_revert::NestedRepoProbe {
        let shadow = self.engine.shadow_git_dir(WS).expect("shadow dir");
        let work_tree = self.engine.work_tree_for_root(WS).expect("work tree");
        let owned: Vec<String> = paths.iter().map(|path| path.to_string()).collect();
        self.engine
            .probe_nested_repos(&shadow, &work_tree, commit, &owned)
            .await
            .expect("probe")
    }
}

#[tokio::test]
async fn clean_nested_repo_reports_no_drift() {
    let fixture = Fixture::new().await;
    fixture.make_nested_repo("vendor/lib");
    let commit = fixture.capture_commit("run-t41-clean").await;

    let probe = fixture.probe(&commit, &["vendor/lib/README.md"]).await;
    assert_eq!(probe.affected.len(), 1, "{:?}", probe.affected);
    let repo = &probe.affected[0];
    assert_eq!(repo.repo_path, "vendor/lib");
    assert_eq!(repo.kind, "nested");
    assert!(!repo.dirty, "captured repo is clean");
    assert!(!repo.head_moved, "HEAD matches the flattened slice content");
    assert_eq!(probe.git_calls, 2, "exactly status + rev-parse");
}

#[tokio::test]
async fn dirty_nested_repo_blocks_scenario_b() {
    let fixture = Fixture::new().await;
    fixture.make_nested_repo("vendor/lib");
    let commit = fixture.capture_commit("run-t41-dirty").await;

    // Uncommitted change inside the nested repo: the only permanent-loss path (b).
    std::fs::write(
        fixture.ws().join("vendor/lib/README.md"),
        "uncommitted edit\n",
    )
    .expect("dirty write");

    let probe = fixture.probe(&commit, &["vendor/lib/README.md"]).await;
    assert_eq!(probe.affected.len(), 1, "{:?}", probe.affected);
    assert!(probe.affected[0].dirty, "porcelain must flag the edit");
    assert!(!probe.affected[0].head_moved, "HEAD did not move");
}

#[tokio::test]
async fn head_drifted_nested_repo_is_predicted_read_only() {
    let fixture = Fixture::new().await;
    fixture.make_nested_repo("vendor/lib");
    let commit = fixture.capture_commit("run-t41-drift").await;

    // Clean repo whose HEAD moved past the captured content (scenario c).
    std::fs::write(fixture.ws().join("vendor/lib/README.md"), "next commit\n").expect("edit");
    git_in(&fixture.ws().join("vendor/lib"), &["commit", "-am", "next"]);

    let probe = fixture.probe(&commit, &["vendor/lib/README.md"]).await;
    assert_eq!(probe.affected.len(), 1, "{:?}", probe.affected);
    let repo = &probe.affected[0];
    assert!(!repo.dirty, "committed change leaves a clean work tree");
    assert!(
        repo.head_moved,
        "flattened slice content differs from HEAD tree"
    );
}

#[tokio::test]
async fn empty_ancestor_set_spends_zero_git_processes() {
    let fixture = Fixture::new().await;
    fixture.make_nested_repo("vendor/lib");
    let commit = fixture.capture_commit("run-t41-zero").await;

    // A path outside every nested repo must not spawn any git process.
    let probe = fixture.probe(&commit, &["plain.txt"]).await;
    assert!(probe.affected.is_empty(), "{:?}", probe.affected);
    assert_eq!(probe.git_calls, 0, "zero-cost short circuit");
}

#[tokio::test]
async fn submodule_shaped_repo_is_classified_not_declared() {
    let fixture = Fixture::new().await;
    fixture.write("plain.txt", "ordinary\n");
    let external = fixture
        .temp
        .path()
        .join(".dot")
        .join("modules")
        .join("sub-lib");
    std::fs::create_dir_all(&external).expect("external git dir");
    let sub = fixture.ws().join("sub").join("lib");
    std::fs::create_dir_all(&sub).expect("sub dir");
    git_in(
        fixture.temp.path(),
        &[
            "init",
            "--separate-git-dir",
            external.to_str().unwrap(),
            sub.to_str().unwrap(),
        ],
    );
    std::fs::write(sub.join("README.md"), "sub base\n").expect("sub file");
    git_in(&sub, &["add", "-A"]);
    git_in(&sub, &["commit", "-m", "sub base"]);

    let commit = fixture.capture_commit("run-t41-sub").await;
    let probe = fixture.probe(&commit, &["sub/lib/README.md"]).await;
    assert_eq!(probe.affected.len(), 1, "{:?}", probe.affected);
    assert_eq!(
        probe.affected[0].kind, "submodule",
        "gitdir pointer into modules/ classifies as submodule (T4.4 marks, never declares)"
    );
}
