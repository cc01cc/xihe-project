use xihe_runtime::fs as xihe_fs;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_ws() -> (TempDir, String) {
        let dir = TempDir::new().expect("create temp dir");
        fs::write(dir.path().join("test.txt"), "content").unwrap();
        fs::write(dir.path().join("existing.md"), "markdown").unwrap();
        let ws_path = dir.path().to_str().unwrap().to_string();
        (dir, ws_path)
    }

    #[test]
    fn test_resolve_read_path_valid() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("test.txt", &ws);
        assert!(result.is_ok());
    }

    #[test]
    fn test_resolve_read_path_absolute_rejected() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("/etc/passwd", &ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_read_path_dotdot_rejected() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_read_path("../outside.txt", &ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_write_path_valid() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_write_path("output.txt", &ws);
        assert!(result.is_ok());
    }

    #[test]
    fn test_resolve_write_path_absolute_rejected() {
        let (_dir, ws) = setup_ws();
        let result = xihe_fs::resolve_write_path("/bin/sh", &ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_directory() {
        let (dir, ws) = setup_ws();
        fs::write(dir.path().join("file1.txt"), "a").unwrap();
        fs::write(dir.path().join("file2.txt"), "b").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();

        let entries = xihe_fs::list_directory(".", &ws).expect("list dir");
        assert!(entries.iter().any(|e| e.name == "file1.txt"));
        assert!(entries.iter().any(|e| e.name == "file2.txt"));
        assert!(entries.iter().any(|e| e.name == "sub"));
    }

    #[test]
    fn test_get_file_info() {
        let (dir, ws) = setup_ws();
        fs::write(dir.path().join("info.txt"), "content").unwrap();

        let info = xihe_fs::get_file_info("info.txt", &ws).expect("get info");
        assert_eq!(info.name, "info.txt");
        assert!(!info.is_dir);
    }

    #[test]
    fn test_glob_files() {
        let (dir, ws) = setup_ws();
        fs::write(dir.path().join("a.rs"), "").unwrap();
        fs::write(dir.path().join("b.ts"), "").unwrap();
        fs::write(dir.path().join("c.rs"), "").unwrap();

        let files = xihe_fs::glob_files("*.rs", ".", &ws).expect("glob");
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|f| f.ends_with("a.rs")));
        assert!(files.iter().any(|f| f.ends_with("c.rs")));
    }

    #[test]
    fn test_grep_files() {
        let (dir, ws) = setup_ws();
        fs::write(dir.path().join("search.txt"), "hello world\nfoo bar").unwrap();
        fs::write(dir.path().join("other.txt"), "no match").unwrap();

        let matches = xihe_fs::grep_files("hello", ".", &ws).expect("grep");
        assert!(matches.iter().any(|m| m.file.ends_with("search.txt")));
    }

    // --- read_file_range tests (P1) ---

    #[test]
    fn test_read_file_range_full_file() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_str().unwrap().to_string();
        fs::write(dir.path().join("lines.txt"), "line1\nline2\nline3\n").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(xihe_fs::read_file_range("lines.txt", None, None, &ws))
            .unwrap();

        assert_eq!(result.total_lines, 3);
        assert!(!result.is_binary);
        assert!(result.content.contains("1 | line1"));
        assert!(result.content.contains("2 | line2"));
        assert!(result.content.contains("3 | line3"));
    }

    #[test]
    fn test_read_file_range_with_offset_and_limit() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_str().unwrap().to_string();
        fs::write(dir.path().join("lines.txt"), "a\nb\nc\nd\ne\n").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(xihe_fs::read_file_range("lines.txt", Some(2), Some(2), &ws))
            .unwrap();

        assert_eq!(result.total_lines, 5);
        assert!(result.content.contains("2 | b"));
        assert!(result.content.contains("3 | c"));
        assert!(!result.content.contains("1 | a"));
        assert!(!result.content.contains("4 | d"));
    }

    #[test]
    fn test_read_file_range_offset_beyond_eof() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_str().unwrap().to_string();
        fs::write(dir.path().join("small.txt"), "only\n").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(xihe_fs::read_file_range(
                "small.txt",
                Some(100),
                Some(10),
                &ws,
            ))
            .unwrap();

        assert_eq!(result.total_lines, 1);
        assert!(result.content.is_empty());
    }

    #[test]
    fn test_read_file_range_binary_detection() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_str().unwrap().to_string();
        let binary_content: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03, 0xFF];
        fs::write(dir.path().join("binary.bin"), &binary_content).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(xihe_fs::read_file_range("binary.bin", None, None, &ws))
            .unwrap();

        assert!(result.is_binary);
        assert_eq!(result.total_lines, 0);
        assert!(!result.content.is_empty()); // base64 encoded
    }

    #[test]
    fn test_read_file_range_traversal_rejected() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_str().unwrap().to_string();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(xihe_fs::read_file_range("../outside.txt", None, None, &ws));
        assert!(result.is_err());
    }

    #[test]
    fn test_read_file_range_absolute_rejected() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_str().unwrap().to_string();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(xihe_fs::read_file_range("/etc/passwd", None, None, &ws));
        assert!(result.is_err());
    }

    // --- web_fetch tests ---

    #[test]
    fn test_web_fetch_invalid_url_returns_error() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(xihe_runtime::fetch::web_fetch(
            "not-a-valid-url",
            Some("text"),
            Some(2),
        ));
        assert!(
            result.is_err(),
            "invalid URL should return error, got: {:?}",
            result
        );
    }

    #[test]
    fn test_web_fetch_unreachable_host_returns_error() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(xihe_runtime::fetch::web_fetch(
            "http://192.0.2.1:1", // TEST-NET, unreachable
            Some("text"),
            Some(2),
        ));
        assert!(
            result.is_err(),
            "unreachable host should return error, got: {:?}",
            result
        );
    }

    #[test]
    fn test_web_fetch_localhost_returns_content() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        std::thread::spawn(move || {
            // Accept more than one connection because clients may retry while
            // negotiating a local connection on different Windows stacks.
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let response =
                    b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nHello, world!";
                if stream.write_all(response).is_err() {
                    continue;
                }
            }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(xihe_runtime::fetch::web_fetch(
            &format!("http://127.0.0.1:{}", port),
            Some("text"),
            Some(5),
        ));
        assert!(
            result.is_ok(),
            "localhost fetch should succeed, got: {:?}",
            result
        );
        let fetch_result = result.unwrap();
        assert!(
            fetch_result.content.contains("Hello, world!"),
            "content mismatch: {}",
            fetch_result.content
        );
        assert!(!fetch_result.truncated);
        assert_eq!(fetch_result.url, format!("http://127.0.0.1:{}", port));
    }

    #[test]
    fn test_web_fetch_struct_fields() {
        let result = xihe_runtime::fetch::WebFetchResult {
            content: "hello".to_string(),
            url: "https://example.com".to_string(),
            truncated: false,
        };
        assert_eq!(result.content, "hello");
        assert_eq!(result.url, "https://example.com");
        assert!(!result.truncated);
    }
}
