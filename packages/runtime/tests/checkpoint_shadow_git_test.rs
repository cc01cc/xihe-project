//! PLAN-0328 M2 W1 / T2.0 spike — shadow-git checkpoint engine against real host git.
//!
//! Every scenario uses the real host `git` binary and a real temporary workspace
//! (spec/testing §3 mock boundary). Assertion (a) is the hard gate: if the shadow
//! snapshot picks up `.git` noise, the failure message dumps the exact shadow refs and
//! trees and the test stops there — that is the fallback trigger for explicit
//! `.git/**` excludes (tasks.md T2.0).

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xihe_runtime::checkpoint::{ChangedFile, CheckpointError, ShadowGit};

const WS: &str = "ws1";

struct Fixture {
    temp: TempDir,
    engine: ShadowGit,
}

impl Fixture {
    async fn new() -> Self {
        Self::build(|root: &Path| ShadowGit::new(root)).await
    }

    async fn with_max_untracked(max_bytes: u64) -> Self {
        Self::build(move |root: &Path| {
            ShadowGit::new(root).with_max_untracked_file_bytes(max_bytes)
        })
        .await
    }

    async fn build(engine_for: impl FnOnce(&Path) -> ShadowGit) -> Self {
        let temp = TempDir::new().expect("fixture tempdir");
        std::fs::create_dir_all(temp.path().join(WS)).expect("fixture workspace dir");
        let engine = engine_for(temp.path());
        let capability = engine.probe().await;
        assert!(
            capability.available,
            "T2.0 spike requires a real host git >= 2.20 (spec §6.0): {capability:?}"
        );
        eprintln!(
            "T2.0 git capability: {}",
            capability.version.as_deref().unwrap_or("unknown")
        );
        Self { temp, engine }
    }

    fn root(&self) -> &Path {
        self.temp.path()
    }

    fn ws(&self) -> PathBuf {
        self.root().join(WS)
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.ws().join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture dirs");
        }
        std::fs::write(&path, content).expect("fixture write");
    }

    fn git(&self, args: &[&str]) {
        git_in(&self.ws(), args);
    }
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
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_capture(args: &[&str]) -> String {
    match Command::new("git").args(args).output() {
        Ok(output) => format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        Err(error) => format!("<failed to spawn git: {error}>"),
    }
}

fn dump_shadow_state(engine: &ShadowGit) -> String {
    let Ok(shadow) = engine.shadow_git_dir(WS) else {
        return "<invalid shadow dir>".to_string();
    };
    let shadow = shadow.to_string_lossy().to_string();
    let refs = run_capture(&["--git-dir", &shadow, "for-each-ref"]);
    let mut dump = format!("for-each-ref:\n{refs}\n");
    for line in refs.lines() {
        if let Some(oid) = line.split_whitespace().nth(1) {
            let tree = run_capture(&["--git-dir", &shadow, "ls-tree", "-r", oid]);
            dump.push_str(&format!("ls-tree -r {oid}:\n{tree}\n"));
        }
    }
    dump
}

fn sorted(files: &[ChangedFile]) -> Vec<(String, String, Option<String>)> {
    let mut rows: Vec<(String, String, Option<String>)> = files
        .iter()
        .map(|file| {
            (
                file.status.clone(),
                file.path.clone(),
                file.old_path.clone(),
            )
        })
        .collect();
    rows.sort();
    rows
}

fn noise_failure(engine: &ShadowGit, files: &[ChangedFile]) -> String {
    format!(
        "spike(a) FAILED: the shadow snapshot reported noise that must not exist.\nchanged_files: {files:#?}\n--- shadow state ---\n{}\n--- STOP (T2.0): report this git output verbatim; next step is an explicit `.git/**` exclude decision ---",
        dump_shadow_state(engine)
    )
}

fn null_device() -> &'static str {
    #[cfg(windows)]
    {
        "NUL"
    }
    #[cfg(not(windows))]
    {
        "/dev/null"
    }
}

#[tokio::test]
async fn spike_a_zero_noise_with_user_repo_node_modules_gitignored_and_untracked_files() {
    let fixture = Fixture::new().await;

    fixture.git(&["init"]);
    fixture.git(&["config", "user.name", "fixture-user"]);
    fixture.git(&["config", "user.email", "fixture@example.com"]);
    fixture.write(".gitignore", "dist/\nignored.log\n");
    fixture.write("a.txt", "hello\n");
    fixture.git(&["add", ".gitignore", "a.txt"]);
    fixture.git(&["commit", "-m", "user initial commit"]);

    fixture.write("node_modules/pkg/index.js", "module.exports = 1;\n");
    fixture.write("dist/bundle.js", "bundled\n");
    fixture.write("ignored.log", "noise\n");
    fixture.write("scratch.txt", "untracked but not ignored\n");

    fixture
        .engine
        .create_base(WS, "run-a1", "fixture", "call-a1")
        .await
        .expect("create base");
    let sealed = fixture.engine.seal(WS, "run-a1").await.expect("seal");
    eprintln!(
        "spike(a) clean run changed_files: {:?}",
        sealed.changed_files
    );
    assert!(
        sealed.changed_files.is_empty(),
        "{}",
        noise_failure(&fixture.engine, &sealed.changed_files)
    );

    fixture
        .engine
        .create_base(WS, "run-a2", "fixture", "call-a2")
        .await
        .expect("create base");
    fixture.git(&["add", "a.txt"]);
    fixture.git(&[
        "commit",
        "--allow-empty",
        "-m",
        "user commit (shadow noise check)",
    ]);
    fixture.git(&["status"]);
    let sealed = fixture.engine.seal(WS, "run-a2").await.expect("seal");
    eprintln!(
        "spike(a) user-repo-commit run changed_files: {:?}",
        sealed.changed_files
    );
    assert!(
        sealed.changed_files.is_empty(),
        "{}",
        noise_failure(&fixture.engine, &sealed.changed_files)
    );
}

#[tokio::test]
async fn spike_a2_nested_repository_is_recorded_as_gitlink_only() {
    let fixture = Fixture::new().await;
    fixture.write("top.txt", "top\n");
    fixture.write("sub/nested/README.md", "nested\n");
    let nested = fixture.ws().join("sub/nested");
    git_in(&nested, &["init"]);
    git_in(&nested, &["add", "-A"]);
    git_in(&nested, &["commit", "-m", "nested initial"]);

    fixture
        .engine
        .create_base(WS, "run-n1", "fixture", "call-n1")
        .await
        .expect("create base");
    fixture.write("sub/nested/README.md", "nested changed but uncommitted\n");
    let sealed = fixture.engine.seal(WS, "run-n1").await.expect("seal");
    assert!(
        sealed.changed_files.is_empty(),
        "uncommitted nested-repo edits must not appear: {:?}",
        sealed.changed_files
    );

    fixture
        .engine
        .create_base(WS, "run-n2", "fixture", "call-n2")
        .await
        .expect("create base");
    git_in(&nested, &["add", "-A"]);
    git_in(&nested, &["commit", "-m", "nested second"]);
    let sealed = fixture.engine.seal(WS, "run-n2").await.expect("seal");
    assert_eq!(
        sorted(&sealed.changed_files),
        vec![("M".to_string(), "sub/nested".to_string(), None)],
        "committed nested-repo HEAD movement must surface as one gitlink entry"
    );
    assert!(
        sealed
            .changed_files
            .iter()
            .all(|file| !file.path.contains("sub/nested/")),
        "nested-repo internals must never be tracked individually"
    );
}

#[tokio::test]
async fn spike_b_real_modification_detected_exactly_once() {
    let fixture = Fixture::new().await;
    fixture.write("scratch.txt", "original\n");
    fixture.write("other.txt", "other\n");
    fixture
        .engine
        .create_base(WS, "run-b", "fixture", "call-b")
        .await
        .expect("create base");
    fixture.write("scratch.txt", "modified\n");
    let sealed = fixture.engine.seal(WS, "run-b").await.expect("seal");
    assert_eq!(
        sorted(&sealed.changed_files),
        vec![("M".to_string(), "scratch.txt".to_string(), None)],
        "a single real modification must be reported exactly once"
    );

    let resealed = fixture.engine.seal(WS, "run-b").await.expect("reseal");
    assert_eq!(resealed.end_commit, sealed.end_commit);
    assert_eq!(resealed.changed_files, sealed.changed_files);

    let listed = fixture
        .engine
        .changed_files(WS, "run-b")
        .await
        .expect("changed files");
    assert_eq!(listed, sealed.changed_files);
}

#[tokio::test]
async fn spike_b2_unsealed_run_reports_not_sealed_instead_of_empty() {
    let fixture = Fixture::new().await;
    fixture.write("scratch.txt", "original\n");
    fixture
        .engine
        .create_base(WS, "run-b2", "fixture", "call-b2")
        .await
        .expect("create base");
    let error = fixture
        .engine
        .changed_files(WS, "run-b2")
        .await
        .expect_err("unsealed run must fail explicitly");
    assert!(matches!(error, CheckpointError::NotSealed(_)));
}

#[tokio::test]
async fn spike_c_excluded_patterns_never_appear_in_changed_files() {
    let fixture = Fixture::with_max_untracked(1024).await;
    fixture.write(".gitignore", "user-ignored.log\n");
    fixture.write("regular.txt", "regular\n");
    let excluded = [
        "secret.pem",
        "private.key",
        "cert.p12",
        ".npmrc",
        ".netrc",
        "id_rsa",
        "node_modules/pkg/index.js",
        "dist/bundle.js",
        "build/out.js",
        ".cache/cache.bin",
        ".tmp/tmp.bin",
        ".env",
        ".xihe-snapshots/snap-1.json",
        ".xihe-sentinel",
        ".xihe-probe-writable",
        ".xihe-container-runtime.log",
        ".xihe-container-runtime.pid",
        ".xihe-bridge-42.pid",
        ".xihe-shadow/decoy.txt",
        "user-ignored.log",
        "big-untracked.bin",
    ];
    for path in excluded {
        fixture.write(path, "seed\n");
    }
    fixture.write("big-untracked.bin", &"x".repeat(4096));

    fixture
        .engine
        .create_base(WS, "run-c1", "fixture", "call-c1")
        .await
        .expect("create base");
    for path in excluded {
        fixture.write(path, "changed content\n");
    }
    fixture.write("big-untracked.bin", &"y".repeat(4096));
    let sealed = fixture.engine.seal(WS, "run-c1").await.expect("seal");
    assert!(
        sealed.changed_files.is_empty(),
        "excluded paths leaked into changed_files: {:?}",
        sealed.changed_files
    );

    fixture
        .engine
        .create_base(WS, "run-c2", "fixture", "call-c2")
        .await
        .expect("create base");
    fixture.write("regular.txt", "regular modified\n");
    fixture.write("secret.pem", "changed again\n");
    let sealed = fixture.engine.seal(WS, "run-c2").await.expect("seal");
    assert_eq!(
        sorted(&sealed.changed_files),
        vec![("M".to_string(), "regular.txt".to_string(), None)],
        "the positive control file must be detected while the excluded one stays invisible"
    );
}

#[tokio::test]
async fn spike_d_non_git_workspace_works_identically() {
    let fixture = Fixture::new().await;
    assert!(!fixture.ws().join(".git").exists());
    fixture.write("src/main.ts", "export const a = 1;\n");
    fixture.write("notes.md", "notes\n");

    fixture
        .engine
        .create_base(WS, "run-d1", "fixture", "call-d1")
        .await
        .expect("create base");
    fixture.write("src/main.ts", "export const a = 2;\n");
    fixture.write("new-file.txt", "created during run\n");
    std::fs::remove_file(fixture.ws().join("notes.md")).expect("delete fixture file");
    let sealed = fixture.engine.seal(WS, "run-d1").await.expect("seal");
    assert_eq!(
        sorted(&sealed.changed_files),
        vec![
            ("A".to_string(), "new-file.txt".to_string(), None),
            ("D".to_string(), "notes.md".to_string(), None),
            ("M".to_string(), "src/main.ts".to_string(), None),
        ],
        "non-git workspaces must produce the same change semantics"
    );

    fixture
        .engine
        .create_base(WS, "run-d2", "fixture", "call-d2")
        .await
        .expect("create base");
    fixture.write("untracked-only.txt", "first version\n");
    let sealed = fixture.engine.seal(WS, "run-d2").await.expect("seal");
    assert_eq!(
        sorted(&sealed.changed_files),
        vec![("A".to_string(), "untracked-only.txt".to_string(), None)],
        "untracked files are covered by the checkpoint in non-git workspaces"
    );
}

#[tokio::test]
async fn spike_e_create_base_is_idempotent_per_run() {
    let fixture = Fixture::new().await;
    fixture.write("a.txt", "one\n");
    let first = fixture
        .engine
        .create_base(WS, "run-e", "fixture", "call-e1")
        .await
        .expect("create base");
    assert!(first.created);

    fixture.write("b.txt", "two\n");
    let second = fixture
        .engine
        .create_base(WS, "run-e", "fixture", "call-e2")
        .await
        .expect("idempotent create base");
    assert!(!second.created);
    assert_eq!(second.base_commit, first.base_commit);

    let other = fixture
        .engine
        .create_base(WS, "run-e2", "fixture", "call-e3")
        .await
        .expect("create base for another run");
    assert!(other.created);
    assert_ne!(other.base_commit, first.base_commit);

    fixture.engine.seal(WS, "run-e").await.expect("seal");
    let third = fixture
        .engine
        .create_base(WS, "run-e", "fixture", "call-e4")
        .await
        .expect("create base after seal");
    assert!(!third.created);
    assert_eq!(third.base_commit, first.base_commit);
}

#[tokio::test]
async fn spike_f_retention_deletes_only_sealed_runs_oldest_first() {
    let fixture = Fixture::new().await;
    for index in 1..=4 {
        let run_id = format!("run-{index:02}");
        fixture.write("file.txt", &format!("version {index}\n"));
        fixture
            .engine
            .create_base(WS, &run_id, "fixture", "call")
            .await
            .expect("create base");
        fixture.write("file.txt", &format!("version {index} sealed\n"));
        fixture.engine.seal(WS, &run_id).await.expect("seal");
    }
    fixture.write("file.txt", "unsealed\n");
    fixture
        .engine
        .create_base(WS, "run-05", "fixture", "call")
        .await
        .expect("create unsealed base");

    let report = fixture
        .engine
        .retention_gc(WS, 2, 30)
        .await
        .expect("retention");
    assert_eq!(
        report.deleted_runs,
        vec!["run-01".to_string(), "run-02".to_string()],
        "count-based retention deletes sealed runs oldest-first"
    );
    assert_eq!(report.kept_sealed, 2);
    assert_eq!(report.kept_unsealed, 1);
    assert!(report.gc_ran);

    let survivors = fixture
        .engine
        .changed_files(WS, "run-03")
        .await
        .expect("surviving sealed run");
    assert_eq!(survivors.len(), 1);
    let gone = fixture
        .engine
        .changed_files(WS, "run-01")
        .await
        .expect_err("deleted sealed run");
    assert!(matches!(gone, CheckpointError::RunNotFound(_)));

    let unsealed = fixture
        .engine
        .changed_files(WS, "run-05")
        .await
        .expect_err("unsealed run stays unsealed");
    assert!(matches!(unsealed, CheckpointError::NotSealed(_)));
    let refreshed = fixture
        .engine
        .create_base(WS, "run-05", "fixture", "call")
        .await
        .expect("unsealed base is still resolvable");
    assert!(!refreshed.created);

    let report = fixture
        .engine
        .retention_gc(WS, 50, 0)
        .await
        .expect("ttl-only retention");
    assert_eq!(
        report.deleted_runs,
        vec!["run-03".to_string(), "run-04".to_string()],
        "ttl expiry deletes sealed runs only"
    );
    assert_eq!(report.kept_unsealed, 1);
    let unsealed = fixture
        .engine
        .changed_files(WS, "run-05")
        .await
        .expect_err("unsealed run survives ttl retention");
    assert!(matches!(unsealed, CheckpointError::NotSealed(_)));
    let refreshed = fixture
        .engine
        .create_base(WS, "run-05", "fixture", "call")
        .await
        .expect("unsealed base survives ttl retention");
    assert!(!refreshed.created);
}

#[tokio::test]
async fn spike_g_symlinked_path_behavior_is_recorded() {
    let fixture = Fixture::new().await;
    fixture.write("a.txt", "target\n");
    let link = fixture.ws().join("link-to-a.txt");
    #[cfg(windows)]
    let created = std::os::windows::fs::symlink_file("a.txt", &link);
    #[cfg(not(windows))]
    let created = std::os::unix::fs::symlink("a.txt", &link);
    if let Err(error) = created {
        eprintln!(
            "spike_g declaration: symlink creation not permitted on this host ({error}); the shadow config declares core.symlinks=true and the symlink scenario is recorded as an explicit platform limitation, not a pass"
        );
        return;
    }

    fixture
        .engine
        .create_base(WS, "run-g", "fixture", "call-g")
        .await
        .expect("create base");
    fixture.write("a.txt", "target modified\n");
    let sealed = fixture.engine.seal(WS, "run-g").await.expect("seal");
    assert_eq!(
        sorted(&sealed.changed_files),
        vec![("M".to_string(), "a.txt".to_string(), None)],
        "a symlinked path must not break or duplicate the change set"
    );
}
