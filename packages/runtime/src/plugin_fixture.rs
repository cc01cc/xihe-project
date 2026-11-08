//! T2.4a 的 stdio MCP **工艺样本**（不是产品插件）。
//!
//! 只被 `tests/plugin_runner_test.rs` 用来验证 [`xihe_runtime::plugin`] 的进程托管行为：
//! 握手、独立 PID、请求超时、崩溃回收、stderr 尾巴、环境白名单、限并发。
//!
//! 它**不是** B-6 的 `official.doc-index`：那个真实插件包属 T2.4b，本卡没有它。
//! 因此本卡"绿"只证明 runner 机制成立，不证明任何真实插件的加载与工具语义。
//!
//! 协议：换行分隔 JSON-RPC 2.0。`initialize` / `tools/list` 正常应答；
//! 通知（无 `id`）不应答。测试指令：
//! - `_fixture/crash`：不回包，直接 `exit(3)`（验崩溃回收与退出码）
//! - `_fixture/hang`：不回包也不退出（验请求超时与 fail-closed）
//! - `_fixture/stderr`：往 stderr 写固定标记后正常回包（验 stderr 尾巴）
//! - `_fixture/env`：回包带可见环境变量名 + 指定 token 值（验环境白名单/注入）
//!
//! 参数：`--pid-file <path>` 启动时把自身 pid 写进去（验"独立 PID"是子进程自己的）。

use std::io::{BufRead, Write};

use serde_json::{Value, json};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(path) = arg_value(&args, "--pid-file") {
        // pid 文件写失败就让进程直接失败退出：测试要靠它证明"子进程自己的 pid"。
        if let Err(error) = std::fs::write(&path, std::process::id().to_string()) {
            eprintln!("xihe-plugin-fixture: cannot write pid file {path}: {error}");
            std::process::exit(2);
        }
    }

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            // 按 JSON-RPC 口径：解析失败不是协议帧，丢弃继续读。
            continue;
        };
        let Some(method) = frame.get("method").and_then(Value::as_str) else {
            continue;
        };
        let id = frame.get("id").cloned();
        let params = frame.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "_fixture/crash" => std::process::exit(3),
            "_fixture/hang" => {}
            "_fixture/stderr" => {
                eprintln!("xihe-plugin-fixture stderr marker");
                reply(&mut stdout, id, Ok(json!({"ok": true})));
            }
            "_fixture/env" => {
                let mut names: Vec<String> = std::env::vars().map(|(key, _)| key).collect();
                names.sort();
                reply(
                    &mut stdout,
                    id,
                    Ok(json!({
                        "envNames": names,
                        "token": std::env::var("XIHE_PLUGIN_TEST_TOKEN").ok(),
                    })),
                );
            }
            "initialize" => {
                let negotiated = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2026-07-28")
                    .to_string();
                reply(
                    &mut stdout,
                    id,
                    Ok(json!({
                        "protocolVersion": negotiated,
                        "capabilities": {"tools": {}},
                        "serverInfo": {
                            "name": "xihe-plugin-fixture",
                            "version": env!("CARGO_PKG_VERSION"),
                        },
                    })),
                );
            }
            "tools/list" => reply(
                &mut stdout,
                id,
                Ok(json!({
                    "tools": [{
                        "name": "echo",
                        "description": "工艺样本：回显调用参数",
                        "inputSchema": {"type": "object"},
                    }],
                })),
            ),
            other => reply(
                &mut stdout,
                id,
                Err(json!({"code": -32601, "message": format!("method not found: {other}")})),
            ),
        }
    }
}

fn reply(stdout: &mut impl Write, id: Option<Value>, outcome: Result<Value, Value>) {
    // 通知（无 id）按 JSON-RPC 2.0 不应答。
    let Some(id) = id else {
        return;
    };
    let frame = match outcome {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
    };
    // 序列化失败只可能是 Value → 字符串这一步，不会发生；真发生也不能 panic 掉 fixture。
    let Ok(line) = serde_json::to_string(&frame) else {
        return;
    };
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}
