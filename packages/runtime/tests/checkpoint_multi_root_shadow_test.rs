//! PLAN-0639 M1: per-root shadow repo (D-1) — two roots each get an independent shadow
//! repo and slice chain; the legacy single-root path is byte-for-byte unchanged.

use std::path::Path;
use std::process::Command;
use xihe_runtime::checkpoint::ShadowGit;

/// Build a minimal ShadowGit pointed at a temporary host root.
fn make_shadow(host_root: &Path) -> ShadowGit {
    ShadowGit::new(host_root)
}

#[test]
fn primary_root_shadow_path_is_unchanged() {
    let tmp = tempfile::tempdir().expect("temp host root");
    let shadow = make_shadow(tmp.path());

    // Primary root: root_id == workspace_id → legacy path shape.
    let primary = shadow
        .shadow_git_dir("ws-alpha")
        .expect("primary root shadow path");
    let expected = tmp
        .path()
        .join(".xihe-shadow")
        .join("ws-alpha.git");
    assert_eq!(primary, expected);
}

#[test]
fn secondary_root_gets_independent_shadow_path() {
    let tmp = tempfile::tempdir().expect("temp host root");
    let shadow = make_shadow(tmp.path());

    let primary = shadow.shadow_git_dir("ws-alpha").expect("primary shadow");
    let secondary = shadow
        .shadow_git_dir("root-beta")
        .expect("secondary root shadow");

    // Two distinct paths under the same .xihe-shadow directory.
    assert_ne!(primary, secondary);
    assert!(secondary.starts_with(tmp.path().join(".xihe-shadow")));
    assert_eq!(
        secondary.file_name().unwrap().to_string_lossy(),
        "root-beta.git"
    );
}

#[test]
fn shadow_dirs_do_not_alias_each_other() {
    let tmp = tempfile::tempdir().expect("temp host root");
    let shadow = make_shadow(tmp.path());

    let a = shadow.shadow_git_dir("root-a").expect("root a shadow");
    let b = shadow.shadow_git_dir("root-b").expect("root b shadow");

    assert_ne!(a, b);
    // Parent directory is shared.
    assert_eq!(a.parent().unwrap(), b.parent().unwrap());
}

#[test]
fn work_tree_for_root_defaults_to_host_root_join() {
    let tmp = tempfile::tempdir().expect("temp host root");
    let shadow = make_shadow(tmp.path());

    let wt = shadow.work_tree_for_root("root-gamma").expect("work tree");
    assert_eq!(wt, tmp.path().join("root-gamma"));
}

#[test]
fn work_tree_override_for_root_isolates_roots() {
    let tmp = tempfile::tempdir().expect("temp host root");
    let shadow = make_shadow(tmp.path());

    let override_path = tmp.path().join("override-a");
    shadow.set_work_tree_override_for_root("root-a", override_path.clone());

    assert_eq!(
        shadow.work_tree_for_root("root-a").unwrap(),
        override_path
    );
    // root-b is unaffected.
    assert_eq!(
        shadow.work_tree_for_root("root-b").unwrap(),
        tmp.path().join("root-b")
    );
}

/// Guard: two independent shadow repos can be initialised side by side (no path collision).
#[test]
fn two_shadow_repos_initialise_independently() {
    let tmp = tempfile::tempdir().expect("temp host root");
    let shadow = make_shadow(tmp.path());

    let dir_a = shadow.shadow_git_dir("root-a").expect("shadow a dir");
    let dir_b = shadow.shadow_git_dir("root-b").expect("shadow b dir");

    std::fs::create_dir_all(&dir_a).expect("create shadow a");
    std::fs::create_dir_all(&dir_b).expect("create shadow b");

    for (name, dir) in [("a", &dir_a), ("b", &dir_b)] {
        let output = Command::new("git")
            .args(["init", "--bare"])
            .arg(dir)
            .output()
            .expect("git init should run");
        assert!(
            output.status.success(),
            "git init failed for shadow {name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    // Both HEAD files exist independently.
    assert!(dir_a.join("HEAD").exists());
    assert!(dir_b.join("HEAD").exists());
}
