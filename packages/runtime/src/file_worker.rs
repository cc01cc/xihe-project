//! One-shot Workspace file worker used by the Windows MXC Router path.
//!
//! The worker has no mutable session state. Its stdin contains one operation
//! frame and it emits one JSON response before exiting. Binary writes use a
//! JSON header followed by an unsigned little-endian length and exactly that
//! many raw bytes.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use crate::error::{Result, RuntimeError};
use crate::fs;

pub const MAX_FILE_OPERATION_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, serde::Deserialize)]
struct OperationRequest {
    operation: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResponse {
    ok: bool,
    result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<OperationError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationError {
    code: String,
    message: String,
}

/// Encodes a binary write frame for the worker stdin.
pub fn encode_binary_request(path: &str, root_id: Option<&str>, data: &[u8]) -> Result<Vec<u8>> {
    ensure_payload_size(data.len())?;
    let header = serde_json::to_vec(&serde_json::json!({
        "operation": "write_binary",
        "payload": {"path": path, "rootId": root_id},
    }))
    .map_err(|error| RuntimeError::Command(format!("serialize file worker header: {error}")))?;
    let mut frame = Vec::with_capacity(header.len() + 1 + 8 + data.len());
    frame.extend_from_slice(&header);
    frame.push(b'\n');
    frame.extend_from_slice(&(data.len() as u64).to_le_bytes());
    frame.extend_from_slice(data);
    Ok(frame)
}

pub fn ensure_payload_size(size: usize) -> Result<()> {
    if size > MAX_FILE_OPERATION_BYTES {
        return Err(RuntimeError::PayloadTooLarge {
            actual: size,
            limit: MAX_FILE_OPERATION_BYTES,
        });
    }
    Ok(())
}

/// Runs the worker mode of `xihe-runtime`.
pub async fn run(args: &[String]) -> anyhow::Result<()> {
    let workspace = args
        .windows(2)
        .find(|pair| pair[0] == "--workspace")
        .map(|pair| pair[1].clone())
        .ok_or_else(|| anyhow::anyhow!("--workspace is required for --file-worker"))?;
    let roots = parse_root_table(args)?;

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut header = Vec::new();
    let header_len = reader.read_until(b'\n', &mut header).await?;
    if header_len == 0 || header_len > 1024 * 1024 {
        anyhow::bail!("invalid or oversized file worker header");
    }
    if header.last() == Some(&b'\n') {
        header.pop();
    }
    let request: OperationRequest = serde_json::from_slice(&header)?;
    let binary = if request.operation == "write_binary" {
        let mut length = [0u8; 8];
        reader.read_exact(&mut length).await?;
        let length = u64::from_le_bytes(length);
        let length = usize::try_from(length)
            .map_err(|_| anyhow::anyhow!("binary payload length does not fit usize"))?;
        ensure_payload_size(length)?;
        let mut data = vec![0u8; length];
        reader.read_exact(&mut data).await?;
        let mut extra = [0u8; 1];
        if reader.read(&mut extra).await? != 0 {
            anyhow::bail!("binary frame contains trailing bytes");
        }
        Some(data)
    } else {
        None
    };

    let response = match dispatch(&request, binary.as_deref(), &workspace, &roots).await {
        Ok(result) => OperationResponse {
            ok: true,
            result,
            error: None,
            error_code: None,
        },
        Err(error) => {
            let (code, message) = map_error(&error);
            OperationResponse {
                ok: false,
                result: Value::Null,
                error: Some(OperationError {
                    code: code.clone(),
                    message,
                }),
                error_code: Some(code),
            }
        }
    };
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

/// task-979: parse repeated `--root <rootId>=<absolute hostPath>` arguments.
fn parse_root_table(args: &[String]) -> anyhow::Result<Vec<(String, PathBuf)>> {
    let mut roots = Vec::new();
    for pair in args.windows(2) {
        if pair[0] != "--root" {
            continue;
        }
        let (root_id, host_path) = pair[1]
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("--root must be <rootId>=<absolute hostPath>"))?;
        if root_id.trim().is_empty() || host_path.trim().is_empty() {
            anyhow::bail!("--root carries a blank rootId or hostPath");
        }
        let path = PathBuf::from(host_path);
        if !path.is_absolute() {
            anyhow::bail!("--root hostPath is not absolute: {host_path}");
        }
        roots.push((root_id.to_string(), path));
    }
    Ok(roots)
}

/// task-979: select the declared root boundary for one operation. No `rootId`
/// keeps the pre-979 primary-root behavior; an unknown id fails closed.
fn resolve_boundary<'a>(
    workspace: &'a str,
    roots: &'a [(String, PathBuf)],
    root_id: Option<&str>,
) -> Result<&'a Path> {
    match root_id {
        None => Ok(Path::new(workspace)),
        Some(root_id) if root_id.trim().is_empty() => {
            Err(RuntimeError::InvalidPath("rootId must not be blank".into()))
        }
        Some(root_id) => roots
            .iter()
            .find(|(id, _)| id == root_id)
            .map(|(_, path)| path.as_path())
            .ok_or_else(|| RuntimeError::InvalidPath(format!("unknown rootId {root_id:?}"))),
    }
}

async fn dispatch(
    request: &OperationRequest,
    binary: Option<&[u8]>,
    workspace: &str,
    roots: &[(String, PathBuf)],
) -> Result<Value> {
    let payload = &request.payload;
    let boundary = resolve_boundary(
        workspace,
        roots,
        payload.get("rootId").and_then(Value::as_str),
    )?;
    let workspace = boundary.to_string_lossy().into_owned();
    let path = || payload.get("path").and_then(Value::as_str).unwrap_or("");
    match request.operation.as_str() {
        "read_file" => Ok(serde_json::json!({
            "content": fs::read_file(path(), &workspace).await?
        })),
        "read_file_range" => serde_json::to_value(
            fs::read_file_range(
                path(),
                payload
                    .get("offset")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
                payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
                &workspace,
            )
            .await?,
        )
        .map_err(|error| RuntimeError::Command(format!("serialize read result: {error}"))),
        "list_directory" => {
            let path = path().to_string();
            let workspace = workspace.clone();
            let entries =
                tokio::task::spawn_blocking(move || fs::list_directory(&path, &workspace))
                    .await
                    .map_err(|error| RuntimeError::Join(error.to_string()))??;
            Ok(serde_json::json!({"entries": entries}))
        }
        "glob" => serde_json::to_value(fs::glob_files(
            payload
                .get("pattern")
                .and_then(Value::as_str)
                .unwrap_or("*"),
            path(),
            &workspace,
        )?)
        .map_err(|error| RuntimeError::Command(format!("serialize glob result: {error}"))),
        "grep" => serde_json::to_value(fs::grep_files(
            payload.get("pattern").and_then(Value::as_str).unwrap_or(""),
            path(),
            &workspace,
        )?)
        .map_err(|error| RuntimeError::Command(format!("serialize grep result: {error}"))),
        "get_file_info" => serde_json::to_value(fs::get_file_info(path(), &workspace)?)
            .map_err(|error| RuntimeError::Command(format!("serialize file info: {error}"))),
        "write_file" => {
            let content = payload.get("content").and_then(Value::as_str).unwrap_or("");
            ensure_payload_size(content.len())?;
            Ok(serde_json::json!({
                "message": fs::write_file(path(), content, &workspace).await?
            }))
        }
        "write_binary" => {
            let data =
                binary.ok_or_else(|| RuntimeError::InvalidPath("missing binary frame".into()))?;
            Ok(serde_json::json!({
                "message": fs::write_file_binary(path(), data, &workspace).await?
            }))
        }
        "edit_file" => {
            let file_path = payload
                .get("filePath")
                .or_else(|| payload.get("file_path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let old = payload
                .get("oldString")
                .or_else(|| payload.get("old_string"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let new = payload
                .get("newString")
                .or_else(|| payload.get("new_string"))
                .and_then(Value::as_str)
                .unwrap_or("");
            ensure_payload_size(old.len().saturating_add(new.len()))?;
            serde_json::to_value(
                fs::edit_file(
                    file_path,
                    old,
                    new,
                    payload
                        .get("replaceAll")
                        .or_else(|| payload.get("replace_all"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    &workspace,
                )
                .await?,
            )
            .map_err(|error| RuntimeError::Command(format!("serialize edit result: {error}")))
        }
        "delete_file" => {
            Ok(serde_json::json!({"message": fs::delete_file(path(), &workspace).await?}))
        }
        "delete_directory" => Ok(serde_json::json!({
            "message": fs::delete_directory(
                path(),
                payload.get("recursive").and_then(Value::as_bool).unwrap_or(false),
                &workspace,
            ).await?
        })),
        "mkdir" => Ok(serde_json::json!({"message": fs::mkdir(path(), &workspace).await?})),
        "move_file" => Ok(serde_json::json!({
            "message": fs::move_file(
                payload.get("from").and_then(Value::as_str).unwrap_or(""),
                payload.get("to").and_then(Value::as_str).unwrap_or(""),
                &workspace,
            ).await?
        })),
        "copy_file" => {
            let from = payload.get("from").and_then(Value::as_str).unwrap_or("");
            let to = payload.get("to").and_then(Value::as_str).unwrap_or("");
            if fs::get_file_info(from, &workspace)?.is_dir {
                return Err(RuntimeError::Unsupported {
                    capability: "file-operation:copy_file".into(),
                    reason: "UNSUPPORTED_DIRECTORY_COPY".into(),
                });
            }
            Ok(serde_json::json!({"message": fs::copy_file(from, to, &workspace).await?}))
        }
        "watch_directory" | "extract_pdf_text" => Err(RuntimeError::Unsupported {
            capability: format!("file-operation:{}", request.operation),
            reason: "UNSUPPORTED".into(),
        }),
        "apply_patch" => serde_json::to_value(
            fs::apply_patch_at(
                &workspace,
                payload
                    .get("patches")
                    .and_then(Value::as_array)
                    .ok_or_else(|| RuntimeError::InvalidPath("missing patches array".into()))?,
            )
            .await?,
        )
        .map_err(|error| RuntimeError::Command(format!("serialize patch result: {error}"))),
        other => Err(RuntimeError::Unsupported {
            capability: format!("file-operation:{other}"),
            reason: "UNSUPPORTED".into(),
        }),
    }
}

fn map_error(error: &RuntimeError) -> (String, String) {
    let code = match error {
        RuntimeError::PathTraversal { .. } | RuntimeError::SymlinkEscape { .. } => {
            "BOUNDARY_DENIED"
        }
        RuntimeError::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            "BOUNDARY_DENIED"
        }
        RuntimeError::PayloadTooLarge { .. } => "PAYLOAD_TOO_LARGE",
        RuntimeError::InvalidPath(_) => "INVALID_PATH",
        RuntimeError::FileNotFound(_) => "FILE_NOT_FOUND",
        RuntimeError::Unsupported { .. } => "UNSUPPORTED",
        RuntimeError::PartialRollbackFailed { .. } => "PARTIAL_ROLLBACK_FAILED",
        _ => "EXEC_FAILED",
    };
    let message = match error {
        RuntimeError::PathTraversal { .. } => {
            "Workspace file boundary denied: path traversal".to_string()
        }
        RuntimeError::SymlinkEscape { .. } => {
            "Workspace file boundary denied: symlink escape".to_string()
        }
        _ => match code {
            "PAYLOAD_TOO_LARGE" => {
                "Workspace file payload exceeds the configured limit".to_string()
            }
            "FILE_NOT_FOUND" => "Workspace file was not found".to_string(),
            "INVALID_PATH" => "Invalid workspace file path".to_string(),
            "UNSUPPORTED" => "Workspace file operation is unsupported".to_string(),
            "PARTIAL_ROLLBACK_FAILED" => {
                "Workspace file operation partially applied and rollback failed".to_string()
            }
            _ => "Workspace file operation failed".to_string(),
        },
    };
    (code.to_string(), message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_frame_has_length_prefix_and_exact_payload() {
        let frame = encode_binary_request("x.bin", None, &[0, 1, 0xff]).expect("frame");
        let header_end = frame
            .iter()
            .position(|byte| *byte == b'\n')
            .expect("header");
        assert_eq!(
            u64::from_le_bytes(frame[header_end + 1..header_end + 9].try_into().unwrap()),
            3
        );
        assert_eq!(&frame[header_end + 9..], &[0, 1, 0xff]);
    }

    #[test]
    fn binary_frame_rejects_payload_over_cap() {
        let error = encode_binary_request("x.bin", None, &vec![0; MAX_FILE_OPERATION_BYTES + 1])
            .expect_err("oversized payload");
        assert!(matches!(error, RuntimeError::PayloadTooLarge { .. }));
    }

    /// task-979: the worker must route a `rootId` to that root's own host path
    /// instead of always resolving against the primary `--workspace`.
    #[tokio::test]
    async fn root_table_routes_reads_and_writes_to_the_selected_root() {
        let primary = tempfile::TempDir::new().expect("primary tempdir");
        let root_b = tempfile::TempDir::new().expect("root b tempdir");
        let roots = vec![
            ("ws-primary".to_string(), primary.path().to_path_buf()),
            ("root-b".to_string(), root_b.path().to_path_buf()),
        ];

        let write = OperationRequest {
            operation: "write_file".to_string(),
            payload: serde_json::json!({"path": "probe.txt", "content": "from-root-b", "rootId": "root-b"}),
        };
        dispatch(&write, None, primary.path().to_str().unwrap(), &roots)
            .await
            .expect("write through root-b");
        assert_eq!(
            std::fs::read_to_string(root_b.path().join("probe.txt")).expect("root b file"),
            "from-root-b"
        );
        assert!(!primary.path().join("probe.txt").exists());

        let read = OperationRequest {
            operation: "read_file".to_string(),
            payload: serde_json::json!({"path": "probe.txt", "rootId": "root-b"}),
        };
        let value = dispatch(&read, None, primary.path().to_str().unwrap(), &roots)
            .await
            .expect("read through root-b");
        assert_eq!(value["content"], "from-root-b");

        let unknown = OperationRequest {
            operation: "read_file".to_string(),
            payload: serde_json::json!({"path": "probe.txt", "rootId": "root-unknown"}),
        };
        assert!(matches!(
            dispatch(&unknown, None, primary.path().to_str().unwrap(), &roots).await,
            Err(RuntimeError::InvalidPath(_))
        ));
    }
}
