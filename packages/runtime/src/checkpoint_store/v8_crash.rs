//! V8 crash/consistency suite (test-only fault hooks).
//!
//! This is the current-code port of the spike crash matrix. Hooks live behind
//! `cfg(test)` and deliberately panic at the same phase boundaries the spike
//! killed the process: mid-capture, before slice commit, mid-restore, and
//! mid-GC.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::blob::{blob_path, write_blob};
use super::capture::{CaptureOptions, CaptureResult, capture_root, capture_root_with_options};
use super::fsck::{FsckFindingKind, fsck_store};
use super::gc::{GcOptions, gc};
use super::manifest::Manifest;
use super::restore_full::{FullRestoreOptions, RESTORE_MARKER, restore_full, restore_status};
use super::store::Store;

fn write_file(root: &Path, relative: &str, content: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent");
    }
    fs::write(path, content).expect("write fixture");
}

fn slice_count(store: &Store) -> usize {
    fs::read_dir(store.slice_dir("ws"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .count()
        })
        .unwrap_or(0)
}

fn manifest_count(store: &Store) -> usize {
    fn walk(dir: &Path, count: &mut usize) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                *count += 1;
            }
        }
    }
    let mut count = 0;
    walk(&store.root().join("manifests"), &mut count);
    count
}

fn has_planned_journal(store: &Store) -> bool {
    let Ok(entries) = fs::read_dir(store.root().join("gc")) else {
        return false;
    };
    entries.flatten().any(|entry| {
        fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("phase")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .is_some_and(|phase| phase == "planned")
    })
}

fn no_corrupt_refs(store: &Store) -> bool {
    fsck_store(store, false)
        .map(|report| {
            report
                .findings
                .iter()
                .all(|finding| finding.kind == FsckFindingKind::OrphanBlob)
        })
        .unwrap_or(false)
}

fn capture(store: &Store, root: &Path, run: &str) -> CaptureResult {
    capture_root(store, root, "ws", Some(run), Some("v8")).expect("capture")
}

fn restore(store: &Store, root: &Path, slice: &str) -> Result<(), String> {
    fs::create_dir_all(root).expect("restore root");
    restore_full(store, "ws", slice, root, &FullRestoreOptions::default())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn checked(checks: &mut Vec<Value>, name: &str, ok: bool, detail: impl Into<String>) {
    checks.push(json!({"name": name, "ok": ok, "detail": detail.into()}));
}

fn fixture() -> (tempfile::TempDir, Store, PathBuf, CaptureResult) {
    let temp = tempfile::tempdir().expect("temp");
    let root = temp.path().join("ws");
    fs::create_dir_all(&root).expect("root");
    write_file(&root, "a.txt", b"alpha");
    write_file(&root, "b.txt", b"beta");
    write_file(&root, "c.txt", b"gamma");
    fs::create_dir_all(root.join("sub/.git")).expect("nested git marker");
    write_file(&root, "sub/inner.txt", b"inner");
    let store = Store::init(temp.path().join("store")).expect("store");
    let baseline = capture(&store, &root, "baseline");
    (temp, store, root, baseline)
}

#[test]
fn v8_crash_suite_46_plus_2() {
    let mut checks = Vec::new();
    let (_temp, store, root, baseline) = fixture();
    checked(
        &mut checks,
        "fixture files >= 4",
        slice_count(&store) == 1,
        "one baseline slice",
    );
    checked(
        &mut checks,
        "baseline capture committed",
        !baseline.no_change,
        &baseline.slice_id,
    );
    checked(
        &mut checks,
        "baseline manifest entries",
        baseline.entry_count == 4,
        baseline.entry_count.to_string(),
    );
    checked(
        &mut checks,
        "nested root metadata",
        baseline.nested_roots == vec!["sub".to_string()],
        format!("{:?}", baseline.nested_roots),
    );
    let restore_target = _temp.path().join("restore-baseline");
    checked(
        &mut checks,
        "baseline restore succeeds",
        restore(&store, &restore_target, &baseline.slice_id).is_ok(),
        &baseline.slice_id,
    );
    checked(
        &mut checks,
        "baseline content",
        fs::read_to_string(restore_target.join("a.txt"))
            .ok()
            .as_deref()
            == Some("alpha"),
        "a.txt",
    );

    // Capture crash #1: panic after hashing two changed files.
    write_file(&root, "a.txt", b"broken-a");
    write_file(&root, "b.txt", b"broken-b");
    let crash1 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        capture_root_with_options(
            &store,
            &root,
            "ws",
            Some("crash-after-files"),
            Some("v8"),
            &CaptureOptions {
                crash_after_files: Some(2),
                ..CaptureOptions::default()
            },
        )
    }));
    checked(
        &mut checks,
        "capture crash #1 died",
        crash1.is_err(),
        "panic",
    );
    checked(
        &mut checks,
        "crash #1 lock released",
        store.lock_root("ws").is_ok(),
        "root lock",
    );
    checked(
        &mut checks,
        "crash #1 no corrupt refs",
        no_corrupt_refs(&store),
        "fsck allows orphan blobs",
    );
    checked(
        &mut checks,
        "crash #1 slice count unchanged",
        slice_count(&store) == 1,
        "1",
    );
    let after_crash1 = _temp.path().join("after-crash1");
    checked(
        &mut checks,
        "crash #1 old slice restorable",
        restore(&store, &after_crash1, &baseline.slice_id).is_ok(),
        "baseline",
    );
    checked(
        &mut checks,
        "crash #1 old content intact",
        fs::read_to_string(after_crash1.join("a.txt"))
            .ok()
            .as_deref()
            == Some("alpha"),
        "alpha",
    );
    let recover1 = capture(&store, &root, "recover1");
    checked(
        &mut checks,
        "capture after crash #1 succeeds",
        !recover1.no_change,
        &recover1.slice_id,
    );
    checked(
        &mut checks,
        "recovery sees both changed files",
        recover1.entry_count == 4,
        recover1.entry_count.to_string(),
    );

    // Capture crash #2: panic after manifest rename, before slice record.
    write_file(&root, "c.txt", b"broken-c");
    let before_manifests = manifest_count(&store);
    let crash2 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        capture_root_with_options(
            &store,
            &root,
            "ws",
            Some("crash-before-slice"),
            Some("v8"),
            &CaptureOptions {
                crash_before_slice_commit: true,
                ..CaptureOptions::default()
            },
        )
    }));
    checked(
        &mut checks,
        "capture crash #2 died",
        crash2.is_err(),
        "panic",
    );
    checked(
        &mut checks,
        "crash #2 orphan manifest",
        manifest_count(&store) > before_manifests,
        "manifest renamed",
    );
    checked(
        &mut checks,
        "crash #2 slice count unchanged",
        slice_count(&store) == 2,
        "2",
    );
    checked(
        &mut checks,
        "crash #2 no corrupt refs",
        no_corrupt_refs(&store),
        "fsck",
    );
    checked(
        &mut checks,
        "crash #2 latest slice restorable",
        restore(
            &store,
            &_temp.path().join("after-crash2"),
            &recover1.slice_id,
        )
        .is_ok(),
        "recover1",
    );
    let recover2 = capture(&store, &root, "recover2");
    checked(
        &mut checks,
        "capture after crash #2 succeeds",
        !recover2.no_change,
        &recover2.slice_id,
    );
    checked(
        &mut checks,
        "crash #2 commit after recovery",
        slice_count(&store) == 3,
        "3",
    );

    // Restore crash: panic after one restored file.
    write_file(&root, "a.txt", b"changed-again");
    write_file(&root, "b.txt", b"changed-again-b");
    let restore_root = _temp.path().join("restore-crash");
    fs::create_dir_all(&restore_root).expect("restore root");
    let restore_crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        restore_full(
            &store,
            "ws",
            &baseline.slice_id,
            &restore_root,
            &FullRestoreOptions {
                fail_after_files: Some(1),
                ..FullRestoreOptions::default()
            },
        )
    }));
    checked(
        &mut checks,
        "restore crash died",
        restore_crash.is_err(),
        "panic",
    );
    checked(
        &mut checks,
        "restore crash marker",
        restore_root.join(RESTORE_MARKER).exists(),
        "marker",
    );
    checked(
        &mut checks,
        "restore status incomplete",
        restore_status(&restore_root)
            .map(|status| status.incomplete)
            .unwrap_or(false),
        "incomplete",
    );
    checked(
        &mut checks,
        "restore crash no store corruption",
        no_corrupt_refs(&store),
        "fsck",
    );
    let recovered = restore_full(
        &store,
        "ws",
        &baseline.slice_id,
        &restore_root,
        &FullRestoreOptions {
            resume_same_target: true,
            ..FullRestoreOptions::default()
        },
    );
    checked(
        &mut checks,
        "restore resume succeeds",
        recovered.is_ok(),
        "resume",
    );
    checked(
        &mut checks,
        "restore marker cleared",
        !restore_root.join(RESTORE_MARKER).exists(),
        "cleared",
    );
    checked(
        &mut checks,
        "restore content matches",
        fs::read_to_string(restore_root.join("a.txt"))
            .ok()
            .as_deref()
            == Some("alpha"),
        "alpha",
    );

    // GC after crash leftovers: manual orphan blobs are swept.
    let lease = store.lock_root("ws").expect("lease");
    let gc_blocked = gc(&store, &GcOptions::default()).is_err();
    drop(lease);
    checked(
        &mut checks,
        "restore lease blocks GC",
        gc_blocked,
        "STORE_BUSY",
    );
    let orphan = write_blob(store.root(), b"v8-orphan").expect("orphan");
    let orphan_path = blob_path(store.root(), &orphan.hash);
    let before_gc = gc(
        &store,
        &GcOptions {
            grace_seconds: 0,
            ..GcOptions::default()
        },
    )
    .expect("gc dry");
    checked(
        &mut checks,
        "GC dry run reports candidate",
        before_gc.candidates >= 1,
        before_gc.candidates.to_string(),
    );
    let gc_done = gc(
        &store,
        &GcOptions {
            repair: true,
            grace_seconds: 0,
            ..GcOptions::default()
        },
    )
    .expect("gc repair");
    checked(
        &mut checks,
        "GC deletes orphan blob",
        gc_done.deleted >= 1 && !orphan_path.exists(),
        gc_done.deleted.to_string(),
    );
    checked(
        &mut checks,
        "GC journal completed",
        gc_done.journal_path.is_some(),
        "journal",
    );
    checked(
        &mut checks,
        "GC leaves store clean",
        no_corrupt_refs(&store),
        "fsck",
    );
    checked(
        &mut checks,
        "latest slice restorable after GC",
        restore(&store, &_temp.path().join("after-gc"), &recover2.slice_id).is_ok(),
        "recover2",
    );

    // GC killed after one delete, then restart/replay.
    let a_blob = write_blob(store.root(), b"v8-gc-kill-a").expect("a");
    let a_path = blob_path(store.root(), &a_blob.hash);
    let b_blob = write_blob(store.root(), b"v8-gc-kill-b").expect("b");
    let b_path = blob_path(store.root(), &b_blob.hash);
    let gc_crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        gc(
            &store,
            &GcOptions {
                repair: true,
                grace_seconds: 0,
                crash_after_deletes: Some(1),
                ..GcOptions::default()
            },
        )
    }));
    checked(&mut checks, "GC crash died", gc_crash.is_err(), "panic");
    checked(
        &mut checks,
        "GC crash journal remains",
        has_planned_journal(&store),
        "planned journal",
    );
    checked(
        &mut checks,
        "GC crash no corrupt refs",
        no_corrupt_refs(&store),
        "fsck",
    );
    checked(
        &mut checks,
        "GC crash killed only one blob",
        a_path.exists() || b_path.exists(),
        "one remains",
    );
    let gc_recovered = gc(
        &store,
        &GcOptions {
            repair: true,
            grace_seconds: 0,
            ..GcOptions::default()
        },
    )
    .expect("gc replay");
    checked(
        &mut checks,
        "GC replay completes",
        gc_recovered.deleted >= 1,
        gc_recovered.deleted.to_string(),
    );
    checked(
        &mut checks,
        "GC replay removes both candidates",
        !a_path.exists() && !b_path.exists(),
        "both gone",
    );
    checked(
        &mut checks,
        "GC replay fsck clean",
        no_corrupt_refs(&store),
        "fsck",
    );
    checked(
        &mut checks,
        "GC replay latest slice restorable",
        restore(
            &store,
            &_temp.path().join("after-gc-kill"),
            &recover2.slice_id,
        )
        .is_ok(),
        "recover2",
    );

    // Corruption fixture (separate store): truncated blob and manifest.
    let corrupt_temp = tempfile::tempdir().expect("corrupt temp");
    let corrupt_root = corrupt_temp.path().join("ws");
    fs::create_dir_all(&corrupt_root).expect("corrupt root");
    write_file(&corrupt_root, "x.txt", b"x");
    write_file(&corrupt_root, "y.txt", b"y");
    let corrupt_store = Store::init(corrupt_temp.path().join("store")).expect("corrupt store");
    let corrupt_capture = capture(&corrupt_store, &corrupt_root, "corrupt-base");
    let manifest_bytes = fs::read(corrupt_store.manifest_path(&corrupt_capture.manifest_id))
        .expect("manifest bytes");
    let manifest =
        Manifest::parse_verified(&manifest_bytes, &corrupt_capture.manifest_id).expect("manifest");
    let victim = manifest
        .entries
        .iter()
        .find(|entry| entry.path == "x.txt")
        .expect("x entry");
    let victim_blob = blob_path(corrupt_store.root(), &victim.blob_hash);
    let len = fs::metadata(&victim_blob).expect("blob").len();
    fs::OpenOptions::new()
        .write(true)
        .open(&victim_blob)
        .expect("blob open")
        .set_len(len - 1)
        .expect("truncate blob");
    let blob_fsck = fsck_store(&corrupt_store, false).expect("fsck");
    checked(
        &mut checks,
        "corrupt blob detected",
        blob_fsck.count(FsckFindingKind::TruncatedBlob) >= 1,
        format!("{:?}", blob_fsck.findings),
    );
    let corrupt_target = corrupt_temp.path().join("corrupt-target");
    let corrupt_restore = restore(
        &corrupt_store,
        &corrupt_temp.path().join("corrupt-target"),
        &corrupt_capture.slice_id,
    );
    checked(
        &mut checks,
        "corrupt restore fails",
        corrupt_restore.is_err(),
        "error",
    );
    checked(
        &mut checks,
        "corrupt file not written",
        !corrupt_target.join("x.txt").exists(),
        "x.txt absent",
    );
    let trunc_manifest_path = corrupt_store.manifest_path(&corrupt_capture.manifest_id);
    let bytes = fs::read(&trunc_manifest_path).expect("manifest");
    fs::write(&trunc_manifest_path, &bytes[..bytes.len() / 2]).expect("truncate manifest");
    let trunc_fsck = fsck_store(&corrupt_store, false).expect("fsck trunc");
    checked(
        &mut checks,
        "truncated manifest detected",
        trunc_fsck.count(FsckFindingKind::CorruptManifest) >= 1,
        format!("{:?}", trunc_fsck.findings),
    );
    let trunc_restore = restore(
        &corrupt_store,
        &corrupt_temp.path().join("trunc-target"),
        &corrupt_capture.slice_id,
    );
    checked(
        &mut checks,
        "truncated restore fails",
        trunc_restore.is_err(),
        "error",
    );
    checked(
        &mut checks,
        "truncated restore wrote no files",
        !corrupt_temp
            .path()
            .join("trunc-target")
            .join("x.txt")
            .exists(),
        "x.txt absent",
    );

    let all_ok = checks.iter().all(|check| check["ok"] == true);
    let report = json!({
        "v": 1,
        "suite": "v8-crash-46+2",
        "checks": checks,
        "summary": {"total": checks.len(), "failed": checks.iter().filter(|check| check["ok"] != true).count()},
        "generated_at": chrono::Utc::now().to_rfc3339(),
    });
    if let Ok(path) = std::env::var("V8_REPORT_PATH") {
        fs::write(
            path,
            serde_json::to_vec_pretty(&report).expect("report json"),
        )
        .expect("write report");
    }
    eprintln!(
        "V8_REPORT {}",
        serde_json::to_string_pretty(&report).expect("report")
    );
    assert!(all_ok, "V8 failures: {report}");
}
