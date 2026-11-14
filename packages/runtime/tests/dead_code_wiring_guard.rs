//! task-559 wiring tripwire: `process_guard::execute` (and its host / cwd
//! helpers) must not gain a caller outside `process_guard.rs`.
//!
//! Why: those functions stopped being production code at `a844f5737`
//! (PLAN-0397 M1), which routed one-shot execution through `job_engine`. The
//! production cwd check is `job_engine::validate_cwd`, called by
//! `start_windows` for BOTH execution modes. Re-wiring the old path would
//! bypass that check while looking like reuse of an existing strong check.
//!
//! Comments erode over time, a red test does not (same shape as the task-562
//! tripwire). Mutation check: add a call in another module files => this fails.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Names that must stay confined to `process_guard.rs`.
const GUARDED: &[&str] = &["execute", "cwd_within_grants", "execute_host"];

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|error| panic!("read {dir:?}: {error}"));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rs_files(&path, out);
        } else if path.extension() == Some(OsStr::new("rs")) {
            out.push(path);
        }
    }
}

/// Drops whole-line comments so prose mentions do not trip the guard.
fn strip_comment_lines(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Returns every `process_guard::<guarded>` reference found in `source`,
/// covering both `process_guard::execute(..)` and `use ...::{execute, ..}`.
fn offending_references(source: &str) -> Vec<String> {
    let marker = "process_guard::";
    let mut hits = Vec::new();
    let mut rest = source;
    while let Some(index) = rest.find(marker) {
        let after = &rest[index + marker.len()..];
        if let Some(group) = after.strip_prefix('{') {
            if let Some(end) = group.find('}') {
                for item in group[..end].split(',') {
                    let name = item.split("::").last().unwrap_or("").trim();
                    if GUARDED.contains(&name) {
                        hits.push(name.to_string());
                    }
                }
            }
        } else {
            let name: String = after
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if GUARDED.contains(&name.as_str()) {
                hits.push(name);
            }
        }
        rest = after;
    }
    hits
}

#[test]
fn no_callers_of_the_dead_one_shot_path_outside_its_own_module() {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rs_files(&src_dir, &mut files);
    assert!(!files.is_empty(), "scanned no sources under {src_dir:?}");
    let mut violations = Vec::new();
    for file in &files {
        if file.file_name() == Some(OsStr::new("process_guard.rs")) {
            continue;
        }
        let text =
            std::fs::read_to_string(file).unwrap_or_else(|error| panic!("read {file:?}: {error}"));
        for name in offending_references(&strip_comment_lines(&text)) {
            violations.push(format!("{}: process_guard::{name}", file.display()));
        }
    }
    assert!(
        violations.is_empty(),
        "do not re-wire process_guard::execute - route new callers through job_engine::validate_cwd (task-559)\nfound: {violations:#?}"
    );
}

#[test]
fn detector_recognises_both_wiring_shapes() {
    assert_eq!(
        offending_references("let result = crate::process_guard::execute(request).await;"),
        vec!["execute".to_string()]
    );
    assert_eq!(
        offending_references("use crate::process_guard::{execute_host, probe_direct_attach};"),
        vec!["execute_host".to_string()]
    );
    assert!(offending_references("crate::process_guard::probe_direct_attach()").is_empty());
    assert!(offending_references("crate::process_guard::execute_mxc(req)").is_empty());
}
