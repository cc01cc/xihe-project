use std::fs as std_fs;

use xihe_runtime::error::RuntimeError;
use xihe_runtime::fs as xihe_fs;

fn setup_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("create temp dir");
    std_fs::write(dir.path().join("readme.md"), "# Hello").unwrap();
    std_fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();
    std_fs::write(dir.path().join("lib.rs"), "pub fn foo() {}").unwrap();
    std_fs::create_dir(dir.path().join("src")).unwrap();
    std_fs::write(dir.path().join("src/mod.rs"), "mod test;").unwrap();
    dir
}

#[test]
fn test_read_file_tool() {
    let dir = setup_dir();
    let ws = dir.path().to_str().unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    let content = rt
        .block_on(xihe_fs::read_file("readme.md", ws))
        .expect("read_file should succeed");

    assert_eq!(content, "# Hello");
}

#[test]
fn test_write_file_tool() {
    let dir = setup_dir();
    let ws = dir.path().to_str().unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    let msg = rt
        .block_on(xihe_fs::write_file("new.txt", "test content", ws))
        .expect("write_file should succeed");

    assert!(msg.contains("Written"));

    let content = std_fs::read_to_string(dir.path().join("new.txt")).unwrap();
    assert_eq!(content, "test content");
}

#[test]
fn test_list_directory_tool() {
    let dir = setup_dir();
    let ws = dir.path().to_str().unwrap();

    let entries = xihe_fs::list_directory(".", ws).expect("list_directory should succeed");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

    assert!(names.contains(&"readme.md"));
    assert!(names.contains(&"main.rs"));
    assert!(names.contains(&"lib.rs"));
    assert!(names.contains(&"src"));
    assert!(!names.contains(&"."));
}

#[test]
fn test_glob_tool() {
    let dir = setup_dir();
    let ws = dir.path().to_str().unwrap();

    let matches = xihe_fs::glob_files("*.rs", ".", ws).expect("glob should succeed");
    assert!(matches.contains(&"main.rs".to_string()));
    assert!(matches.contains(&"lib.rs".to_string()));
    assert!(!matches.contains(&"readme.md".to_string()));
}

#[test]
fn test_grep_tool() {
    let dir = setup_dir();
    let ws = dir.path().to_str().unwrap();

    let results = xihe_fs::grep_files("fn", ".", ws).expect("grep should succeed");
    assert_eq!(results.len(), 2);

    let files: Vec<&str> = results.iter().map(|r| r.file.as_str()).collect();
    assert!(files.contains(&"main.rs"));
    assert!(files.contains(&"lib.rs"));
}

#[test]
fn test_get_file_info_tool() {
    let dir = setup_dir();
    let ws = dir.path().to_str().unwrap();

    let info = xihe_fs::get_file_info("readme.md", ws).expect("get_file_info should succeed");
    assert_eq!(info.name, "readme.md");
    assert!(!info.is_dir);
    assert!(info.size > 0);
}

#[test]
fn test_read_path_traversal_rejected() {
    let dir = setup_dir();
    let ws = dir.path().to_str().unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    let err = rt
        .block_on(xihe_fs::read_file("../../etc/passwd", ws))
        .unwrap_err();
    match err {
        RuntimeError::PathTraversal { .. } => {}
        _ => panic!("expected PathTraversal error, got: {:?}", err),
    }
}

#[test]
fn test_read_non_existent_file() {
    let dir = setup_dir();
    let ws = dir.path().to_str().unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    let err = rt
        .block_on(xihe_fs::read_file("does_not_exist.txt", ws))
        .unwrap_err();
    assert!(
        matches!(err, RuntimeError::PathTraversal { .. }),
        "expected PathTraversal for non-existent file (canonicalize fails), got: {:?}",
        err
    );
}
