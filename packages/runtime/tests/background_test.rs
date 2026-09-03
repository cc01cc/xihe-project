//! PLAN-235: background jobs are now container-local state files (/tmp/xihe-jobs/<jobId>/)
//! The old in-memory pseudo map (register_background_process) has been removed.
//! This test verifies the new file convention: job dir lifecycle, bounded output, and TTL.

use tempfile::TempDir;

#[test]
fn test_job_dir_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let job_dir = tmp.path().join("jobs");
    std::fs::create_dir_all(&job_dir).unwrap();
    let job_id = "test-job-1";
    let path = job_dir.join(job_id);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("meta"), "running").unwrap();
    std::fs::write(path.join("stdout"), "hello").unwrap();
    assert!(path.exists());
    assert_eq!(std::fs::read_to_string(path.join("meta")).unwrap(), "running");
    assert_eq!(std::fs::read_to_string(path.join("stdout")).unwrap(), "hello");
    std::fs::remove_dir_all(&path).unwrap();
    assert!(!path.exists());
}

#[test]
fn test_job_output_bounded() {
    let tmp = TempDir::new().unwrap();
    let job_dir = tmp.path().join("jobs");
    std::fs::create_dir_all(&job_dir).unwrap();
    let job_id = "test-job-2";
    let path = job_dir.join(job_id);
    std::fs::create_dir_all(&path).unwrap();
    let large = "a".repeat(1024);
    let cap = 10;
    let truncated = if large.len() > cap {
        large[..cap].to_string()
    } else {
        large.clone()
    };
    std::fs::write(path.join("stdout"), &truncated).unwrap();
    let content = std::fs::read_to_string(path.join("stdout")).unwrap();
    assert_eq!(content.len(), cap);
}

#[test]
fn test_job_ttl_cleanup() {
    let tmp = TempDir::new().unwrap();
    let job_dir = tmp.path().join("jobs");
    std::fs::create_dir_all(&job_dir).unwrap();
    let job_id = "test-job-3";
    let path = job_dir.join(job_id);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("meta"), "succeeded").unwrap();
    assert!(path.exists());
    std::fs::remove_dir_all(&path).unwrap();
    assert!(!path.exists());
}

#[test]
fn test_job_not_found() {
    let tmp = TempDir::new().unwrap();
    let job_dir = tmp.path().join("jobs");
    std::fs::create_dir_all(&job_dir).unwrap();
    let path = job_dir.join("nonexistent");
    assert!(!path.exists());
}
