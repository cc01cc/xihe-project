# Workspace Import、Copy、Direct Attach 与 Reuse

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Owner：CP Import durable job + Runtime copy executor + WorkspaceStorage target  
> 消费者：UI Add Workspace、CP、Runtime、Workspace events  
> 来源：PLAN-0389、PLAN-0376、PLAN-0384、DEV-015  
> 更新日期：2026-09-21

## Owner 分工

| 层 | 职责 |
|---|---|
| CP | 创建/授权/持久化 Import job，暴露 status/progress/error/cancel，处理 idempotency |
| Runtime | 读取已授权 source directory、canonicalize、copy/exclude/scan、更新进度并清理失败 target |
| WorkspaceStorage | 提供目标 Workspace logical storage；copy 完成后成为独立 managed storage |
| UI | 选择 source、显示 mode/status/error/recovery；不定义 durable resource semantics |

Import job 不依赖 Session；完成后用户可选择/创建新 Session。

## 四种明确语义

- `import/copy`：把 source 复制到 XH-managed WorkspaceStorage，源目录不成为持续执行根。
- `direct_attach`：用户明确授权把现有目录作为 WorkspaceStorage；必须走 Runtime-visible source browser、canonical binding、owner/admin 权限和安全确认。
- `reuse`：沿用既有 Workspace logical resource；不等同 copy 或 direct attach，不在首版 Add Workspace 自动隐式触发。
- `sync`：未来双向/增量同步语义，具有冲突和延迟；当前只登记后置，不把 import 当 sync。

## 状态与幂等

CP durable job 至少区分 `pending/running/completed/cancelled/failed`，记录 `importId`、`workspaceId`、进度、errorCode/detail 和 request hash。重复 Idempotency-Key 对同一 request hash 返回既有 job；hash 不同显式 conflict。

Runtime source missing、permission denied、target non-empty、symlink/exclude/IO failure、cancel 必须显式错误并清理 partial target；不得把 partial copy 标成 ready。

## 验证映射

- 当前 executor：Runtime `import_job.rs`。
- CP job owner：PLAN-0376。
- UI flow/mode：PLAN-0384。
- round-trip、cancel、failure cleanup：PLAN-0389 T3.1/V7，尚未完成。
