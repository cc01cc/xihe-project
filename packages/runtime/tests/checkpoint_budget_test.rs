//! PLAN-0338 T1.4 — checkpoint storage / capture / restore / cleanup budget on real host git.
//!
//! Prints a measurement table (`cargo test --test checkpoint_budget_test -- --nocapture`) and
//! gates the two `spec/capture-scope-and-limits.md` §4 rules:
//!   1. the untracked size cap applies only to NEW files (an excluded new file neither enters
//!      the change set nor grows the shadow repository);
//!   2. an already-indexed path stays included even when it grows past the cap.

use std::path::{Path, PathBuf};
use std::time::Instant;

use tempfile::TempDir;
use xihe_runtime::checkpoint::{CaptureOutcome, ShadowGit};

const WS: &str = "ws-budget";
const MIB: u64 = 1024 * 1024;

struct Fixture {
    temp: TempDir,
    engine: ShadowGit,
}

impl Fixture {
    async fn new() -> Self {
        let temp = TempDir::new().expect("fixture tempdir");
        std::fs::create_dir_all(temp.path().join(WS)).expect("fixture workspace dir");
        let engine = ShadowGit::new(temp.path());
        let capability = engine.probe().await;
        assert!(
            capability.available,
            "T1.4 budget requires a real host git >= 2.20: {capability:?}"
        );
        Self { temp, engine }
    }

    fn ws(&self) -> PathBuf {
        self.temp.path().join(WS)
    }

    fn write_bytes(&self, relative: &str, bytes: usize) {
        let path = self.ws().join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture dirs");
        }
        std::fs::write(&path, vec![b'x'; bytes]).expect("fixture write");
    }

    /// Deterministic incompressible payload (LCG), so blob-growth measurements are
    /// not distorted by git's zlib compression of repeated bytes.
    fn write_incompressible(&self, relative: &str, bytes: usize) -> u64 {
        let path = self.ws().join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture dirs");
        }
        let mut state: u32 = 0x9e37_79b9;
        let mut data = Vec::with_capacity(bytes);
        while data.len() < bytes {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            data.extend_from_slice(&state.to_le_bytes());
        }
        data.truncate(bytes);
        std::fs::write(&path, &data).expect("fixture write");
        data.len() as u64
    }

    async fn capture(&self, run_id: &str) -> CaptureOutcome {
        self.engine
            .capture(WS, run_id, "budget", "call-budget", false)
            .await
            .expect("capture")
    }

    fn shadow_size(&self) -> u64 {
        dir_size(&self.engine.shadow_git_dir(WS).expect("shadow dir"))
    }

    fn slice_refs(&self) -> Vec<String> {
        let shadow = self.engine.shadow_git_dir(WS).expect("shadow dir");
        let output = std::process::Command::new("git")
            .args([
                "--git-dir",
                &shadow.to_string_lossy(),
                "for-each-ref",
                "--format=%(refname)",
                "refs/xihe/slices",
            ])
            .output()
            .expect("run git for-each-ref");
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn changed<'a>(&self, outcome: &'a CaptureOutcome, path: &str) -> Option<&'a str> {
        outcome
            .changed_files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.status.as_str())
    }
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += metadata.len();
        }
    }
    total
}

#[tokio::test]
async fn budget_capture_restore_cleanup_and_size_rules() {
    let fixture = Fixture::new().await;

    // ── 1. Baseline volume: seed, then 500 files × 1 KiB ─────────────────────
    fixture.write_bytes("seed.txt", 16);
    let seed = fixture.capture("budget-0").await;
    assert!(
        seed.changed_files.is_empty(),
        "the first slice has no predecessor"
    );
    for index in 0..500 {
        fixture.write_bytes(&format!("bulk/f{index:04}.txt"), 1024);
    }
    let started = Instant::now();
    let base = fixture.capture("budget-1").await;
    let capture_small_ms = started.elapsed().as_millis();
    assert!(!base.no_change, "the baseline capture must produce a slice");
    assert_eq!(base.changed_files.len(), 500);
    let shadow_after_small = fixture.shadow_size();

    // ── 2. Already-indexed path stays included when it grows past the cap ─────
    fixture.write_incompressible("big-indexed.bin", 5 * MIB as usize);
    let indexed = fixture.capture("budget-2").await;
    assert_eq!(
        fixture.changed(&indexed, "big-indexed.bin"),
        Some("A"),
        "the 5 MiB file is below the 10 MiB cap and must be captured"
    );
    let shadow_before_grow = fixture.shadow_size();

    fixture.write_incompressible("big-indexed.bin", 20 * MIB as usize);
    let started = Instant::now();
    let grown = fixture.capture("budget-3").await;
    let capture_grown_ms = started.elapsed().as_millis();
    assert_eq!(
        fixture.changed(&grown, "big-indexed.bin"),
        Some("M"),
        "an already-indexed path must stay included after growing past the cap"
    );
    let indexed_growth = fixture.shadow_size().saturating_sub(shadow_before_grow);

    // ── 3. Rule: the cap applies only to NEW untracked files ──────────────────
    fixture.write_incompressible("new-big.bin", 20 * MIB as usize);
    let shadow_before_new = fixture.shadow_size();
    let started = Instant::now();
    let excluded = fixture.capture("budget-4").await;
    let capture_excluded_ms = started.elapsed().as_millis();
    assert!(
        excluded.no_change,
        "the 20 MiB NEW file exceeds the cap: nothing else changed, so no slice"
    );
    let new_file_growth = fixture.shadow_size().saturating_sub(shadow_before_new);

    // ── 4. Restore timing over a mixed change set ─────────────────────────────
    // Slice-relative semantics: a deleted file that exists in the slice is
    // recreated by `restore`; a new file absent from the slice is `delete`d.
    let tail_ref = fixture.slice_refs().last().expect("tail slice").clone();
    for index in 0..3 {
        fixture.write_bytes(&format!("bulk/f{index:04}.txt"), 2048);
    }
    std::fs::remove_file(fixture.ws().join("bulk/f0499.txt")).expect("remove fixture file");
    fixture.write_bytes("later-add.txt", 32);
    let started = Instant::now();
    let preview = fixture
        .engine
        .restore_preview(WS, &tail_ref)
        .await
        .expect("preview");
    let preview_ms = started.elapsed().as_millis();
    assert_eq!(preview.counts.restore, 4, "3 modified + 1 recreated");
    assert_eq!(preview.counts.delete, 1, "the later-added file is deleted");
    let started = Instant::now();
    let restored = fixture
        .engine
        .restore_execute(WS, &tail_ref, &[])
        .await
        .expect("execute");
    let restore_ms = started.elapsed().as_millis();
    assert_eq!(restored.counts.restored, 4);
    assert_eq!(restored.counts.deleted, 1);
    assert_eq!(restored.counts.failed, 0);
    assert!(restored.suspects.is_empty());
    assert!(
        fixture.ws().join("bulk/f0499.txt").exists(),
        "the deleted file is recreated from the slice"
    );
    assert!(
        !fixture.ws().join("later-add.txt").exists(),
        "the later-added file is deleted by the restore"
    );

    // ── 5. Cleanup (plan B) timing and size ───────────────────────────────────
    let shadow_bytes = fixture.shadow_size();
    let started = Instant::now();
    let cleanup = fixture.engine.cleanup_workspace(WS).await.expect("cleanup");
    let cleanup_ms = started.elapsed().as_millis();
    assert!(cleanup.removed);
    assert_eq!(fixture.shadow_size(), 0);

    // ── Measurement table (spec §4 budget evidence) ───────────────────────────
    eprintln!(
        "[budget] capture_500x1KiB={capture_small_ms}ms \
         capture_grow5to20MiB={capture_grown_ms}ms capture_nochange_20MiB={capture_excluded_ms}ms \
         preview_mixed={preview_ms}ms restore_mixed={restore_ms}ms cleanup={cleanup_ms}ms"
    );
    eprintln!(
        "[budget] shadow_bytes after_500x1KiB={shadow_after_small} indexed_growth_5to20MiB={indexed_growth} \
         new_20MiB_growth={new_file_growth} before_cleanup={shadow_bytes} after_cleanup={}",
        fixture.shadow_size()
    );
    assert!(
        new_file_growth < 2 * MIB,
        "an excluded NEW 20 MiB file must not grow the shadow repo (grew {new_file_growth} bytes)"
    );
    assert!(
        indexed_growth >= 15 * MIB,
        "an indexed 20 MiB blob is stored on growth (grew {indexed_growth} bytes)"
    );
}
