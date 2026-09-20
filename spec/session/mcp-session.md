# Runtime MCP Session 生命周期

> 契约状态：`proposed`  
> 实现状态：`implemented`（Runtime session seam 已存在；跨领域 root SPEC 尚未晋升）  
> Profile：`lifecycle`  
> Owner：Runtime/MCP owner  
> 消费者：CP Runtime client、Agent MCP adapter、Workspace lifecycle  
> 来源：PLAN-0347、PLAN-0385、PLAN-0387、DEV-015/016  
> 更新日期：2026-09-20

## 边界

Runtime MCP session 是 Workspace 内某个 stdio MCP server 的执行承载，不是 Chat Session、ChatRun 或 Agent principal。

唯一 key 是 `(workspaceId, serverId)`。同一个 key 的请求共享一个 Runtime session；不同 Workspace 或 server MUST 使用不同 session。

## 状态

Runtime 当前状态为：

`starting → ready → restarting → failed → stopped`

失败重启使用 1/5/15 秒退避和有限预算；预算耗尽进入冷却/failed，不能静默创建第二个 session。

## 规范条款

1. Runtime MCP session MUST 通过既有 `SandboxBackend`/exec attach 边界运行，不向 CP/Agent 泄漏 Docker transport 细节。
2. v1 请求 MUST FIFO 单飞；JSON-RPC response 只能按 request `id` 配对，无 id notification 不得充当响应。
3. Workspace cleanup、container rebuild 或 server config removal MUST 停止对应 session 并释放进程资源。
4. session unavailable、frame overflow、process exit 和 timeout MUST 返回显式错误；不得回退到默认 Workspace 或其他 server session。
5. Runtime MCP session 不负责 User/Agent authorization；CP 下发的 Workspace/能力输入必须在调用链上游完成校验。

## 恢复与资源边界

- server process 退出后由 Runtime session driver 按预算重启；`failed` 冷却期间请求显式失败。
- 进程终止使用既有 cleanup/kill 路径；不能因请求 timeout 留下孤儿 session。
- MCP frame 上限、超时和 capability probe 以 Runtime `mcp_session.rs`/DEV-015/016 为事实源。

## 验证映射

- 当前实现：Runtime `mcp_session.rs` 与 PLAN-0347 既有测试。
- 与 Chat/Agent 生命周期分离：PLAN-0387 `evidence/current-state.md`、`consumer-matrix.md`。
- 跨 CP/Runtime/Agent 真实链路：PLAN-0387 V7，尚未在本批宣称完成。
