use xihe_runtime::fs as xihe_fs;
use std::fs;
use tempfile::TempDir;

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_ws() -> (TempDir, String) {
        let dir = TempDir::new().expect("temp dir");
        fs::write(dir.path().join("test.txt"), "content").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/nested.txt"), "nested").unwrap();
        let ws = dir.path().to_str().unwrap().to_string();
        (dir, ws)
    }

    // --- Read path: absolute rejection ---

    #[test]
    fn test_read_rejects_absolute_path() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("/etc/passwd", &ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_rejects_double_slash_absolute() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("//etc/shadow", &ws);
        assert!(result.is_err());
    }

    // --- Read path: traversal rejection ---

    #[test]
    fn test_read_rejects_dotdot_traversal() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("../../../etc/passwd", &ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_rejects_deep_traversal() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("foo/bar/../../../../etc/passwd", &ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_rejects_mid_traversal() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("foo/../../etc/passwd", &ws);
        assert!(result.is_err());
    }

    // --- Write path: absolute and traversal rejection ---

    #[test]
    fn test_write_rejects_absolute_path() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_write_path("/bin/sh", &ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_write_rejects_dotdot_traversal() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_write_path("../outside.txt", &ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_write_rejects_nested_traversal() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_write_path("foo/../../../outside.txt", &ws);
        assert!(result.is_err());
    }

    // --- Symlink escape ---

    #[test]
    fn test_read_rejects_symlink_to_etc() {
        let (dir, ws) = setup_ws();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc", dir.path().join("link-to-etc")).unwrap();
            let result = xihe_fs::resolve_read_path("link-to-etc/shadow", &ws);
            assert!(result.is_err());
        }
    }

    #[test]
    fn test_read_rejects_symlink_to_other_workspace() {
        let ws1 = TempDir::new().unwrap();
        let ws2 = TempDir::new().unwrap();
        fs::write(ws2.path().join("secret.txt"), "secret").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(ws2.path(), ws1.path().join("link-to-ws2")).unwrap();
            let ws = ws1.path().to_str().unwrap().to_string();
            let result = xihe_fs::resolve_read_path("link-to-ws2/secret.txt", &ws);
            assert!(result.is_err());
        }
    }

    #[test]
    fn test_read_rejects_chained_symlinks() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret"), "data").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), dir.path().join("a")).unwrap();
            std::os::unix::fs::symlink(dir.path().join("a"), dir.path().join("b")).unwrap();
            let ws = dir.path().to_str().unwrap().to_string();
            let result = xihe_fs::resolve_read_path("b/secret", &ws);
            assert!(result.is_err());
        }
    }

    #[test]
    fn test_write_rejects_symlink_parent_escape() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
            let ws = dir.path().to_str().unwrap().to_string();
            let result = xihe_fs::resolve_write_path("escape/newfile.txt", &ws);
            assert!(result.is_err());
        }
    }

    // --- Write boundary: write inside workspace ---

    #[test]
    fn test_write_allows_inside_workspace() {
        let (dir, ws) = setup_ws();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(xihe_fs::write_file("output.txt", "data", &ws));
        assert!(result.is_ok());
        assert_eq!(fs::read_to_string(dir.path().join("output.txt")).unwrap(), "data");
    }

    #[test]
    fn test_write_allows_nested_inside_workspace() {
        let (dir, ws) = setup_ws();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(xihe_fs::write_file("sub/deep/file.txt", "deep", &ws));
        assert!(result.is_ok());
        assert_eq!(fs::read_to_string(dir.path().join("sub/deep/file.txt")).unwrap(), "deep");
    }

    // --- Valid path allowed ---

    #[test]
    fn test_read_allows_valid_relative_path() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("test.txt", &ws);
        assert!(result.is_ok());
    }

    #[test]
    fn test_read_allows_valid_nested_path() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("sub/nested.txt", &ws);
        assert!(result.is_ok());
    }
}
