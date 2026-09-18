//! PLAN-0358 M0 — checkpoint performance baseline harness (slice model).
//!
//! Reproducible S0/S1/S2 matrix on real host git. Primary mouth: `--release`.
//!
//! ```text
//! cargo test --release --test checkpoint_perf_m0 -- --nocapture
//! ```
//!
//! Prints per-scenario samples plus P50 / P95 / max. When `n < 20`, P95 is
//! reported as `max` and annotated (design: small-n P95 ≈ max).
//!
//! Gate metrics: `capture`, `restore_execute`, `storage_ratio`.
//! Baseline-only: `restore_preview`, `cleanup`.
//! Correctness companions (changed counts, no-change, cleanup zero) are asserted.

use std::path::{Path, PathBuf};
use std::time::Instant;

use tempfile::TempDir;
use xihe_runtime::checkpoint::{CaptureOutcome, ShadowGit};

const WS: &str = "ws-perf-m0";

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
            "M0 perf harness requires real host git >= 2.20: {capability:?}"
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

    /// Deterministic incompressible payload (LCG) so large-blob timings are not
    /// distorted by zlib on repeated bytes.
    fn write_incompressible(&self, relative: &str, bytes: usize) {
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
    }

    async fn capture(&self, run_id: &str) -> CaptureOutcome {
        self.engine
            .capture(WS, run_id, "perf-m0", "call-perf-m0", false)
            .await
            .expect("capture")
    }

    fn shadow_size(&self) -> u64 {
        dir_size(&self.engine.shadow_git_dir(WS).expect("shadow dir"))
    }

    fn tracked_bytes(&self) -> u64 {
        dir_size(&self.ws())
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

#[derive(Clone, Copy)]
struct Stats {
    n: usize,
    p50_ms: u128,
    p95_ms: u128,
    max_ms: u128,
    p95_is_max: bool,
}

fn summarize(mut samples_ms: Vec<u128>) -> Stats {
    assert!(!samples_ms.is_empty(), "need at least one sample");
    samples_ms.sort_unstable();
    let n = samples_ms.len();
    let p50 = samples_ms[n / 2];
    let max = samples_ms[n - 1];
    // P95 index: nearest-rank. Small-n → report max and annotate.
    let p95_is_max = n < 20;
    let p95 = if p95_is_max {
        max
    } else {
        let idx = ((n as f64) * 0.95).ceil() as usize - 1;
        samples_ms[idx.min(n - 1)]
    };
    Stats {
        n,
        p50_ms: p50,
        p95_ms: p95,
        max_ms: max,
        p95_is_max,
    }
}

fn print_stats(label: &str, samples: &[u128], extra: &str) -> Stats {
    let stats = summarize(samples.to_vec());
    let samples_joined = samples
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let p95_note = if stats.p95_is_max {
        " (n<20, p95:=max)"
    } else {
        ""
    };
    eprintln!(
        "[perf-m0] {label} n={} p50={}ms p95={}ms{p95_note} max={}ms samples=[{samples_joined}] {extra}",
        stats.n, stats.p50_ms, stats.p95_ms, stats.max_ms
    );
    stats
}

/// S0: 100×1KiB — capture first / incremental / noop; restore 10-file mixed.
#[tokio::test]
async fn m0_s0_small_100() {
    let fixture = Fixture::new().await;
    eprintln!("[perf-m0] === S0 100×1KiB ===");

    fixture.write_bytes("seed.txt", 16);
    let _ = fixture.capture("m0-s0-seed").await;

    for index in 0..100 {
        fixture.write_bytes(&format!("src/f{index:04}.txt"), 1024);
    }
    let mut first = Vec::new();
    for sample in 0..5 {
        // Each sample: modify a distinct batch then capture (incremental path).
        if sample == 0 {
            let started = Instant::now();
            let outcome = fixture.capture("m0-s0-first").await;
            first.push(started.elapsed().as_millis());
            assert_eq!(outcome.changed_files.len(), 100);
        } else {
            let path = format!("src/f{sample:04}.txt");
            fixture.write_bytes(&path, 1024 + sample);
            let started = Instant::now();
            let outcome = fixture.capture(&format!("m0-s0-incr-{sample}")).await;
            first.push(started.elapsed().as_millis());
            assert!(!outcome.no_change);
        }
    }
    print_stats(
        "S0.capture",
        &first,
        &format!(
            "shadow={} tracked={}",
            fixture.shadow_size(),
            fixture.tracked_bytes()
        ),
    );

    // noop
    let mut noops = Vec::new();
    for sample in 0..5 {
        let started = Instant::now();
        let outcome = fixture.capture(&format!("m0-s0-noop-{sample}")).await;
        noops.push(started.elapsed().as_millis());
        assert!(
            outcome.no_change,
            "unchanged workspace must not write a slice"
        );
    }
    print_stats("S0.capture_noop", &noops, "");

    let tail = fixture.slice_refs().last().expect("tail slice").clone();
    // 10-file mixed restore: 7 modify + 2 delete-existing + 1 add-then-delete
    for index in 0..7 {
        fixture.write_bytes(&format!("src/f{index:04}.txt"), 2048);
    }
    std::fs::remove_file(fixture.ws().join("src/f0098.txt")).expect("rm");
    fixture.write_bytes("later.txt", 32);

    let mut previews = Vec::new();
    let mut executes = Vec::new();
    for sample in 0..5 {
        let started = Instant::now();
        let preview = fixture
            .engine
            .restore_preview(WS, &tail)
            .await
            .expect("preview");
        previews.push(started.elapsed().as_millis());
        if sample == 0 {
            assert!(preview.counts.restore >= 7);
            assert!(preview.counts.delete >= 1);
        }
        let started = Instant::now();
        let restored = fixture
            .engine
            .restore_execute(WS, &tail, &[])
            .await
            .expect("execute");
        executes.push(started.elapsed().as_millis());
        assert_eq!(restored.counts.failed, 0);
        // Re-apply drift for the next sample.
        for index in 0..7 {
            fixture.write_bytes(&format!("src/f{index:04}.txt"), 2048);
        }
        let _ = std::fs::remove_file(fixture.ws().join("src/f0098.txt"));
        fixture.write_bytes("later.txt", 32);
    }
    print_stats("S0.restore_preview", &previews, "baseline-only");
    print_stats("S0.restore_execute_10", &executes, "gate");

    let started = Instant::now();
    let cleanup = fixture.engine.cleanup_workspace(WS).await.expect("cleanup");
    let cleanup_ms = started.elapsed().as_millis();
    assert!(cleanup.removed);
    assert_eq!(fixture.shadow_size(), 0);
    eprintln!("[perf-m0] S0.cleanup {cleanup_ms}ms (baseline-only)");
}

/// S1: 500×1KiB — aligns with checkpoint_budget_test scale.
#[tokio::test]
async fn m0_s1_medium_500() {
    let fixture = Fixture::new().await;
    eprintln!("[perf-m0] === S1 500×1KiB ===");

    fixture.write_bytes("seed.txt", 16);
    let _ = fixture.capture("m0-s1-seed").await;

    for index in 0..500 {
        fixture.write_bytes(&format!("bulk/f{index:04}.txt"), 1024);
    }
    let started = Instant::now();
    let base = fixture.capture("m0-s1-first").await;
    let first_ms = started.elapsed().as_millis();
    assert_eq!(base.changed_files.len(), 500);
    let mut samples = vec![first_ms];
    for sample in 1..5 {
        for index in 0..20 {
            let path = format!("bulk/f{:04}.txt", sample * 20 + index);
            fixture.write_bytes(&path, 1024 + sample);
        }
        let started = Instant::now();
        let outcome = fixture.capture(&format!("m0-s1-incr-{sample}")).await;
        samples.push(started.elapsed().as_millis());
        assert!(!outcome.no_change);
    }
    let shadow = fixture.shadow_size();
    let tracked = fixture.tracked_bytes();
    let ratio = if tracked > 0 {
        shadow as f64 / tracked as f64
    } else {
        0.0
    };
    print_stats(
        "S1.capture",
        &samples,
        &format!("shadow={shadow} tracked={tracked} ratio={ratio:.4}"),
    );

    let mut noops = Vec::new();
    for sample in 0..5 {
        let started = Instant::now();
        let outcome = fixture.capture(&format!("m0-s1-noop-{sample}")).await;
        noops.push(started.elapsed().as_millis());
        assert!(outcome.no_change);
    }
    print_stats("S1.capture_noop", &noops, "");

    let tail = fixture.slice_refs().last().expect("tail").clone();
    // 50-file mixed: 40 modify + 5 delete + 5 later-add
    for index in 0..40 {
        fixture.write_bytes(&format!("bulk/f{index:04}.txt"), 2048);
    }
    for index in 40..45 {
        let _ = std::fs::remove_file(fixture.ws().join(format!("bulk/f{index:04}.txt")));
    }
    for index in 0..5 {
        fixture.write_bytes(&format!("later/l{index}.txt"), 64);
    }

    let mut previews = Vec::new();
    let mut executes = Vec::new();
    for _sample in 0..3 {
        let started = Instant::now();
        let _ = fixture
            .engine
            .restore_preview(WS, &tail)
            .await
            .expect("preview");
        previews.push(started.elapsed().as_millis());
        let started = Instant::now();
        let restored = fixture
            .engine
            .restore_execute(WS, &tail, &[])
            .await
            .expect("execute");
        executes.push(started.elapsed().as_millis());
        assert_eq!(restored.counts.failed, 0);
        // drift again
        for index in 0..40 {
            fixture.write_bytes(&format!("bulk/f{index:04}.txt"), 2048);
        }
        for index in 40..45 {
            let _ = std::fs::remove_file(fixture.ws().join(format!("bulk/f{index:04}.txt")));
        }
        for index in 0..5 {
            fixture.write_bytes(&format!("later/l{index}.txt"), 64);
        }
    }
    print_stats("S1.restore_preview", &previews, "baseline-only");
    print_stats("S1.restore_execute_50", &executes, "gate");
}

/// S2: 5k code-repo proportion — main debt battlefield.
///
/// 75% small (0.2–4 KiB) / 18% medium (4–64 KiB) / 6% large (64 KiB–2 MiB)
/// / 1% oversized (2–8 MiB). Nested 3–5 levels.
#[tokio::test]
async fn m0_s2_code_repo_5k() {
    let fixture = Fixture::new().await;
    eprintln!("[perf-m0] === S2 5k code-repo proportion ===");

    fixture.write_bytes("seed.txt", 16);
    let _ = fixture.capture("m0-s2-seed").await;

    let total = 5000usize;
    let n_small = total * 75 / 100; // 3750
    let n_medium = total * 18 / 100; // 900
    let n_large = total * 6 / 100; // 300
    let n_oversized = total - n_small - n_medium - n_large; // 50

    let dirs = [
        "src/core",
        "src/adapters",
        "tests/unit",
        "tests/integration",
        "docs/specs",
        "assets/static",
        "config",
    ];

    // Small text 0.2–4 KiB
    for index in 0..n_small {
        let dir = dirs[index % dirs.len()];
        let size = 200 + (index % 38) * 100; // 200..~3.9KiB
        fixture.write_bytes(&format!("{dir}/s{index:05}.ts"), size);
    }
    // Medium 4–64 KiB
    for index in 0..n_medium {
        let dir = dirs[index % dirs.len()];
        let size = 4096 + (index % 60) * 1024;
        fixture.write_bytes(&format!("{dir}/m{index:05}.ts"), size);
    }
    // Large 64 KiB–2 MiB (incompressible for a subset to keep write cost honest)
    for index in 0..n_large {
        let dir = "assets/static";
        let size = 65_536 + (index % 20) * 32_768; // 64KiB..~640KiB average
        if index % 10 == 0 {
            fixture.write_incompressible(&format!("{dir}/l{index:05}.bin"), size);
        } else {
            fixture.write_bytes(&format!("{dir}/l{index:05}.bin"), size);
        }
    }
    // Oversized 2–8 MiB (incompressible; still under 10 MiB untracked cap)
    for index in 0..n_oversized {
        let size = 2 * 1024 * 1024 + (index % 6) * 1024 * 1024; // 2..7 MiB
        fixture.write_incompressible(&format!("assets/static/o{index:05}.bin"), size);
    }

    eprintln!(
        "[perf-m0] S2 fixture written small={n_small} medium={n_medium} large={n_large} oversized={n_oversized}"
    );

    // C-first: full tree capture
    let started = Instant::now();
    let first = fixture.capture("m0-s2-first").await;
    let first_ms = started.elapsed().as_millis();
    assert!(!first.no_change);
    let changed = first.changed_files.len();
    let shadow = fixture.shadow_size();
    let tracked = fixture.tracked_bytes();
    let ratio = if tracked > 0 {
        shadow as f64 / tracked as f64
    } else {
        0.0
    };
    print_stats(
        "S2.C-first",
        &[first_ms],
        &format!("changed={changed} shadow={shadow} tracked={tracked} ratio={ratio:.4}"),
    );

    // C-incr-1% ≈ 50 files
    for index in 0..50 {
        fixture.write_bytes(&format!("src/core/s{index:05}.ts"), 512 + index);
    }
    let started = Instant::now();
    let incr1 = fixture.capture("m0-s2-incr1").await;
    let incr1_ms = started.elapsed().as_millis();
    assert!(!incr1.no_change);
    print_stats(
        "S2.C-incr-1pct",
        &[incr1_ms],
        &format!("changed={}", incr1.changed_files.len()),
    );

    // C-incr-5% ≈ 250 files
    for index in 0..250 {
        fixture.write_bytes(&format!("src/adapters/s{index:05}.ts"), 300 + index);
    }
    let started = Instant::now();
    let incr5 = fixture.capture("m0-s2-incr5").await;
    let incr5_ms = started.elapsed().as_millis();
    assert!(!incr5.no_change);
    print_stats(
        "S2.C-incr-5pct",
        &[incr5_ms],
        &format!("changed={}", incr5.changed_files.len()),
    );

    // C-noop
    let mut noops = Vec::new();
    for sample in 0..3 {
        let started = Instant::now();
        let outcome = fixture.capture(&format!("m0-s2-noop-{sample}")).await;
        noops.push(started.elapsed().as_millis());
        assert!(outcome.no_change);
    }
    print_stats("S2.C-noop", &noops, "");

    // C-large: one large indexed file 2MiB → 8MiB (pick first oversized)
    let large_path = "assets/static/o00000.bin";
    fixture.write_incompressible(large_path, 8 * 1024 * 1024);
    let started = Instant::now();
    let large = fixture.capture("m0-s2-large").await;
    let large_ms = started.elapsed().as_millis();
    assert!(!large.no_change);
    print_stats(
        "S2.C-large",
        &[large_ms],
        &format!("changed={}", large.changed_files.len()),
    );

    // Restore 100-file mixed: M70 / A15 / D10 / conflict-skip 5
    // Conflict-skip simulation: external write after planning is covered by
    // suspects path; for baseline we plant 5 files that differ, then restore
    // without ack (they are normal M, not type-conflict). True external-skip
    // is a correctness scenario; here we time the 100-file execute path.
    let tail = fixture.slice_refs().last().expect("tail").clone();
    for index in 0..70 {
        fixture.write_bytes(&format!("src/core/s{index:05}.ts"), 9000 + index);
    }
    for index in 0..15 {
        fixture.write_bytes(&format!("src/core/new{index:05}.ts"), 128);
    }
    for index in 0..10 {
        let _ = std::fs::remove_file(fixture.ws().join(format!("src/adapters/s{index:05}.ts")));
    }
    // 5 more modifies to reach ~100 touched paths in the plan
    for index in 70..75 {
        fixture.write_bytes(&format!("src/core/s{index:05}.ts"), 4096);
    }

    let started = Instant::now();
    let preview = fixture
        .engine
        .restore_preview(WS, &tail)
        .await
        .expect("preview");
    let preview_ms = started.elapsed().as_millis();
    let planned = preview.counts.restore + preview.counts.delete;
    print_stats(
        "S2.restore_preview",
        &[preview_ms],
        &format!(
            "planned_restore={} delete={}",
            preview.counts.restore, preview.counts.delete
        ),
    );

    let started = Instant::now();
    let restored = fixture
        .engine
        .restore_execute(WS, &tail, &[])
        .await
        .expect("execute");
    let execute_ms = started.elapsed().as_millis();
    assert_eq!(restored.counts.failed, 0);
    let per_file = if planned > 0 {
        execute_ms as f64 / planned as f64
    } else {
        0.0
    };
    print_stats(
        "S2.restore_execute_100",
        &[execute_ms],
        &format!(
            "planned={planned} restored={} deleted={} ms_per_file={per_file:.1} engine_ms={}",
            restored.counts.restored, restored.counts.deleted, restored.duration_ms
        ),
    );
}
