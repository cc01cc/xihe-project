//! PLAN-0338 (T2.0) — shadow-git slice engine against real host git.
//!
//! Every scenario uses the real host `git` binary and a real temporary workspace
//! (spec/testing §3 mock boundary). Assertion (a) is the hard gate: if the shadow
//! snapshot picks up `.git` noise, the failure message dumps the exact shadow refs and
//! trees and the test stops there.

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xihe_runtime::checkpoint::{CaptureOutcome, SLICE_REF_PREFIX, ShadowGit};

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

    async fn capture(&self, run_id: &str) -> CaptureOutcome {
        self.engine
            .capture(WS, run_id, "fixture", "call-fixture", false)
            .await
            .expect("capture")
    }

    async fn capture_abnormal(&self, run_id: &str) -> CaptureOutcome {
        self.engine
            .capture(WS, run_id, "fixture", "call-fixture", true)
            .await
            .expect("abnormal capture")
    }

    async fn slices(&self) -> Vec<String> {
        let shadow = self.engine.shadow_git_dir(WS).expect("shadow dir");
        run_capture(&[
            "--git-dir",
            &shadow.to_string_lossy(),
            "for-each-ref",
            "--format=%(refname)",
            SLICE_REF_PREFIX,
        ])
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
    }

    async fn git(&self, args: &[&str]) -> String {
        let shadow = self.engine.shadow_git_dir(WS).expect("shadow dir");
        let mut full: Vec<String> = vec![
            "--git-dir".to_string(),
            shadow.to_string_lossy().into_owned(),
        ];
        full.extend(args.iter().map(|arg| arg.to_string()));
        let refs: Vec<&str> = full.iter().map(String::as_str).collect();
        run_capture(&refs)
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

fn sorted(outcome: &CaptureOutcome) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = outcome
        .changed_files
        .iter()
        .map(|file| (file.status.clone(), file.path.clone()))
        .collect();
    rows.sort();
    rows
}

fn noise_failure(engine: &ShadowGit, outcome: &CaptureOutcome) -> String {
    format!(
        "spike(a) FAILED: the shadow snapshot reported noise that must not exist.\nchanged_files: {:#?}\n--- shadow state ---\n{}\n--- STOP (T2.0): report this git output verbatim; next step is an explicit `.git/**` exclude decision ---",
        outcome.changed_files,
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

/// Assert the canonical slice-ref shape `refs/xihe/slices/<epochMs>-<fullHash>`.
fn assert_slice_ref(outcome: &CaptureOutcome) -> String {
    let slice_ref = outcome.slice_ref.clone().expect("slice ref written");
    assert!(slice_ref.starts_with(SLICE_REF_PREFIX));
    let leaf = slice_ref.trim_start_matches(SLICE_REF_PREFIX);
    let (epoch, hash) = leaf.split_once('-').expect("epochMs-hash leaf");
    assert!(
        !epoch.is_empty() && epoch.chars().all(|c| c.is_ascii_digit()),
        "epochMs leaf: {leaf}"
    );
    assert_eq!(hash.len(), 40, "full commit hash: {leaf}");
    assert_eq!(outcome.commit.as_deref(), Some(hash));
    slice_ref
}

#[tokio::test]
async fn spike_a_zero_noise_with_user_repo_node_modules_gitignored_and_untracked_files() {
    let fixture = Fixture::new().await;

    fixture.write(".gitignore", "dist/\nignored.log\n");
    fixture.write("a.txt", "hello\n");
    git_in(&fixture.ws(), &["init"]);
    git_in(&fixture.ws(), &["config", "user.name", "fixture-user"]);
    git_in(
        &fixture.ws(),
        &["config", "user.email", "fixture@example.com"],
    );
    git_in(&fixture.ws(), &["add", ".gitignore", "a.txt"]);
    git_in(&fixture.ws(), &["commit", "-m", "user initial commit"]);

    fixture.write("node_modules/pkg/index.js", "module.exports = 1;\n");
    fixture.write("dist/bundle.js", "bundled\n");
    fixture.write("ignored.log", "noise\n");
    fixture.write("scratch.txt", "untracked but not ignored\n");

    let first = fixture.capture("run-a1").await;
    assert!(!first.no_change, "the first capture always writes a slice");
    assert_slice_ref(&first);
    eprintln!(
        "spike(a) first capture changed_files: {:?}",
        first.changed_files
    );
    assert!(
        first
            .changed_files
            .iter()
            .all(|file| !file.path.starts_with(".git/") && file.path != ".git"),
        "{}",
        noise_failure(&fixture.engine, &first)
    );

    // A user commit between captures is still invisible to the shadow snapshot.
    git_in(&fixture.ws(), &["add", "a.txt"]);
    git_in(
        &fixture.ws(),
        &[
            "commit",
            "--allow-empty",
            "-m",
            "user commit (shadow noise check)",
        ],
    );
    let second = fixture.capture("run-a2").await;
    assert!(
        second.no_change,
        "the user's own commit must not change the shadow tree: {}",
        noise_failure(&fixture.engine, &second)
    );
    assert!(second.changed_files.is_empty());
    assert_eq!(second.predecessor.as_deref(), first.slice_ref.as_deref());
    assert_eq!(fixture.slices().await.len(), 1, "no-change writes no ref");
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

    let first = fixture.capture("run-n1").await;
    assert_eq!(
        first.opaque_nested_repos,
        vec!["sub/nested".to_string()],
        "nested repositories are declared as opaque gitlinks"
    );

    fixture.write("sub/nested/README.md", "nested changed but uncommitted\n");
    let second = fixture.capture("run-n2").await;
    assert!(
        second.no_change,
        "uncommitted nested-repo edits must not appear: {:?}",
        second.changed_files
    );

    git_in(&nested, &["add", "-A"]);
    git_in(&nested, &["commit", "-m", "nested second"]);
    let third = fixture.capture("run-n3").await;
    assert_eq!(
        sorted(&third),
        vec![("M".to_string(), "sub/nested".to_string())],
        "committed nested-repo HEAD movement must surface as one gitlink entry"
    );
    assert!(
        third
            .changed_files
            .iter()
            .all(|file| !file.path.contains("sub/nested/")),
        "nested-repo internals must never be tracked individually"
    );
    assert_eq!(
        third.opaque_nested_repos,
        vec!["sub/nested".to_string()],
        "the opaque declaration survives content changes"
    );
}

#[tokio::test]
async fn spike_b_real_modification_detected_exactly_once_and_slice_is_a_root_commit() {
    let fixture = Fixture::new().await;
    fixture.write("scratch.txt", "original\n");
    fixture.write("other.txt", "other\n");
    let first = fixture.capture("run-b1").await;
    let first_ref = assert_slice_ref(&first);
    let first_commit = first.commit.clone().expect("commit");

    fixture.write("scratch.txt", "modified\n");
    let second = fixture.capture("run-b2").await;
    assert!(!second.no_change);
    assert_eq!(
        sorted(&second),
        vec![("M".to_string(), "scratch.txt".to_string())],
        "a single real modification must be reported exactly once"
    );
    assert_eq!(second.predecessor.as_deref(), Some(first_ref.as_str()));

    // The slice commit is a root commit: no parent, and its tree is resolvable.
    let parents = fixture
        .git(&["rev-list", "--parents", "-n", "1", &first_commit])
        .await;
    assert_eq!(parents.split_whitespace().count(), 1, "{parents}");
    let tree = fixture
        .git(&["rev-parse", &format!("{first_commit}^{{tree}}")])
        .await;
    assert_eq!(tree.trim().len(), 40);
}

#[tokio::test]
async fn spike_b2_no_change_writes_no_ref_and_reports_the_chain_tail() {
    let fixture = Fixture::new().await;
    fixture.write("scratch.txt", "original\n");
    let first = fixture.capture("run-b2a").await;
    let first_ref = assert_slice_ref(&first);

    let second = fixture.capture("run-b2b").await;
    assert!(second.no_change);
    assert!(second.slice_ref.is_none(), "noChange writes no ref");
    assert!(second.commit.is_none());
    assert!(second.captured_at.is_none());
    assert_eq!(second.changed_files, Vec::new());
    assert_eq!(second.predecessor.as_deref(), Some(first_ref.as_str()));
    assert_eq!(fixture.slices().await, vec![first_ref.clone()]);

    // A third capture after a real change starts a new chain link.
    fixture.write("scratch.txt", "changed\n");
    let third = fixture.capture("run-b2c").await;
    let third_ref = assert_slice_ref(&third);
    assert_eq!(
        third.predecessor.as_deref(),
        Some(first.slice_ref.as_deref().unwrap())
    );
    assert_ne!(third_ref, first_ref);
    assert_eq!(fixture.slices().await.len(), 2);
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

    let first = fixture.capture("run-c1").await;
    assert!(!first.no_change);
    for path in excluded {
        fixture.write(path, "changed content\n");
    }
    fixture.write("big-untracked.bin", &"y".repeat(4096));
    let second = fixture.capture("run-c2").await;
    assert!(
        second.no_change,
        "excluded paths leaked into changed_files: {:?}",
        second.changed_files
    );

    fixture.write("regular.txt", "regular modified\n");
    fixture.write("secret.pem", "changed again\n");
    let third = fixture.capture("run-c3").await;
    assert_eq!(
        sorted(&third),
        vec![("M".to_string(), "regular.txt".to_string())],
        "the positive control file must be detected while the excluded one stays invisible"
    );
}

#[tokio::test]
async fn spike_c2_size_cap_applies_only_to_new_untracked_files() {
    let fixture = Fixture::with_max_untracked(1024).await;
    fixture.write("tracked.bin", &"a".repeat(64));
    let first = fixture.capture("run-cap-1").await;
    assert_slice_ref(&first);

    // The indexed file grows past the cap: already-indexed paths stay included.
    fixture.write("tracked.bin", &"b".repeat(4096));
    // A new oversized untracked file is excluded dynamically.
    fixture.write("new-oversized.bin", &"c".repeat(4096));
    let second = fixture.capture("run-cap-2").await;
    assert_eq!(
        sorted(&second),
        vec![("M".to_string(), "tracked.bin".to_string())],
        "the cap only excludes new untracked files: {:?}",
        second.changed_files
    );
}

#[tokio::test]
async fn spike_d_non_git_workspace_works_identically() {
    let fixture = Fixture::new().await;
    assert!(!fixture.ws().join(".git").exists());
    fixture.write("src/main.ts", "export const a = 1;\n");
    fixture.write("notes.md", "notes\n");

    let first = fixture.capture("run-d1").await;
    assert_slice_ref(&first);
    fixture.write("src/main.ts", "export const a = 2;\n");
    fixture.write("new-file.txt", "created during run\n");
    std::fs::remove_file(fixture.ws().join("notes.md")).expect("delete fixture file");
    let second = fixture.capture("run-d2").await;
    assert_eq!(
        sorted(&second),
        vec![
            ("A".to_string(), "new-file.txt".to_string()),
            ("D".to_string(), "notes.md".to_string()),
            ("M".to_string(), "src/main.ts".to_string()),
        ],
        "non-git workspaces must produce the same change semantics"
    );

    fixture.write("untracked-only.txt", "first version\n");
    let third = fixture.capture("run-d3").await;
    assert_eq!(
        sorted(&third),
        vec![("A".to_string(), "untracked-only.txt".to_string())],
        "untracked files are covered by the checkpoint in non-git workspaces"
    );
}

#[tokio::test]
async fn spike_e_capture_is_change_driven_and_abnormal_captures_stay_plain_slices() {
    let fixture = Fixture::new().await;
    fixture.write("a.txt", "one\n");
    let first = fixture.capture("run-e1").await;
    assert_eq!(first.state, "captured");
    let first_ref = assert_slice_ref(&first);
    assert_eq!(first.changed_files, Vec::new(), "no tail means no diff");

    // No change → no ref, regardless of the run id.
    let repeat = fixture.capture("run-e2").await;
    assert!(repeat.no_change);
    assert_eq!(fixture.slices().await, vec![first_ref.clone()]);

    // Abnormal captures are ordinary slices with a different state marker, and
    // they participate in the same chain.
    fixture.write("b.txt", "two\n");
    let abnormal = fixture.capture_abnormal("run-e3").await;
    assert_eq!(abnormal.state, "abnormal-captured");
    assert!(!abnormal.no_change);
    assert_eq!(abnormal.predecessor.as_deref(), Some(first_ref.as_str()));
    assert_eq!(
        sorted(&abnormal),
        vec![("A".to_string(), "b.txt".to_string())]
    );

    // A clean abnormal re-capture still writes no ref.
    let clean_abnormal = fixture.capture_abnormal("run-e4").await;
    assert!(clean_abnormal.no_change);
    assert_eq!(fixture.slices().await.len(), 2);
}

#[tokio::test]
async fn spike_f_retention_counts_slices_oldest_first_including_abnormal() {
    let fixture = Fixture::new().await;
    let mut abnormal_ref = None;
    for index in 1..=4 {
        fixture.write("file.txt", &format!("version {index}\n"));
        let outcome = if index == 2 {
            let outcome = fixture.capture_abnormal(&format!("run-{index:02}")).await;
            abnormal_ref = outcome.slice_ref.clone();
            outcome
        } else {
            fixture.capture(&format!("run-{index:02}")).await
        };
        assert!(!outcome.no_change, "each write must produce a slice");
    }
    let abnormal_ref = abnormal_ref.expect("the abnormal slice ref");
    let mut refs = fixture.slices().await;
    refs.sort();
    assert_eq!(refs.len(), 4);
    assert_eq!(
        abnormal_ref, refs[1],
        "the abnormal slice is the second oldest"
    );

    let report = fixture
        .engine
        .retention_gc(WS, 2, 30)
        .await
        .expect("retention");
    assert_eq!(report.deleted_slices.len(), 2);
    assert_eq!(report.deleted_slices[0], refs[0], "oldest first");
    assert_eq!(report.deleted_slices[1], refs[1]);
    assert!(
        report.deleted_slices.contains(&abnormal_ref),
        "an abnormal-captured slice is recycled exactly like a normal one"
    );
    assert_eq!(report.kept, 2);
    assert!(report.gc_ran);

    let survivors = fixture.slices().await;
    assert_eq!(survivors.len(), 2);
    assert!(survivors.contains(&refs[2]));
    assert!(survivors.contains(&refs[3]));

    // TTL-only sweep deletes the remaining slices (all older than a 0-day TTL).
    let ttl_report = fixture.engine.retention_gc(WS, 50, 0).await.expect("ttl");
    assert_eq!(ttl_report.deleted_slices.len(), 2);
    assert_eq!(ttl_report.kept, 0);
    assert!(fixture.slices().await.is_empty());
}

/// Case 14 (spec §3): when more than 4096 untracked files exceed the size cap,
/// the dynamic excludes stop at the cap and the remaining oversized files stay
/// included — the overflow is explicit, never silent.
#[tokio::test]
async fn spike_j_dynamic_exclude_overflow_keeps_remaining_files_included() {
    let fixture = Fixture::with_max_untracked(1).await;
    fixture.write("seed.txt", "x");
    let baseline = fixture.capture("run-j0").await;
    assert_slice_ref(&baseline);

    for index in 0..4097 {
        fixture.write(&format!("bulk/f{index:04}.bin"), "xx");
    }
    let outcome = fixture.capture("run-j1").await;
    assert!(!outcome.no_change);
    assert_eq!(
        sorted(&outcome),
        vec![("A".to_string(), "bulk/f4096.bin".to_string())],
        "the first 4096 oversized files are excluded by the cap; the remainder stays included"
    );
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

    let first = fixture.capture("run-g1").await;
    assert_slice_ref(&first);
    fixture.write("a.txt", "target modified\n");
    let second = fixture.capture("run-g2").await;
    assert_eq!(
        sorted(&second),
        vec![("M".to_string(), "a.txt".to_string())],
        "a symlinked path must not break or duplicate the change set"
    );
}

/// V13: a workspace `.gitignore` tightening must not drop already-captured paths —
/// the temp index is seeded from the chain tail, so no automatic `rm --cached`
/// compensation happens and the shadow tree stays unchanged.
#[tokio::test]
async fn spike_k_gitignore_tightening_keeps_captured_paths() {
    let fixture = Fixture::new().await;
    fixture.write(".gitignore", "# baseline\n");
    fixture.write("keepme.txt", "keep\n");
    fixture.capture("run-k1").await;

    fixture.write(".gitignore", "# baseline\nkeepme.txt\n");
    let second = fixture.capture("run-k2").await;
    assert!(!second.no_change);
    let changed = sorted(&second);
    assert_eq!(
        changed,
        vec![("M".to_string(), ".gitignore".to_string())],
        "tightening must not delete the captured path: {changed:?}"
    );

    let tail_ref = assert_slice_ref(&second);
    let tree = fixture
        .git(&["ls-tree", "-r", "--name-only", &tail_ref])
        .await;
    assert!(tree.contains("keepme.txt"), "{tree}");
    assert_eq!(fixture.slices().await.len(), 2);
}

/// V18: a workspace `.gitignore` negation can re-include a statically excluded path.
/// The system does not veto, audit, or block the user's choice — the static list is
/// only a default.
#[tokio::test]
async fn spike_l_workspace_negation_reincludes_static_excludes() {
    let fixture = Fixture::new().await;
    fixture.write("seed.txt", "seed\n");
    fixture.capture("run-l0").await;

    fixture.write(".gitignore", "!secret.key\n");
    fixture.write("secret.key", "user-managed credential\n");

    let outcome = fixture.capture("run-l1").await;
    let changed = sorted(&outcome);
    assert!(
        changed.contains(&("A".to_string(), "secret.key".to_string())),
        "the workspace .gitignore takes precedence over the static excludes file: {changed:?}"
    );
}
