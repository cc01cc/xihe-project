# 评测专用 MCP fixture（PLAN-0532）

`mcp-fixture-server.mjs` 是**评测/测试侧**的确定性远程 MCP 服务，只为让 PLAN-0511 的
`failure_budget.no_repeat.v1` 在真实工具面上被评测。它不属于生产面：没有生产代码引用它，
没有外部副作用，计数只在内存里。

## 为什么是 remote HTTP，而不是 stdio

XH 的 stdio MCP 会话由 Runtime 在 **workspace 容器内** `exec attach` 承载
（`packages/runtime/src/mcp_session.rs`），而项目自 2026-10-07 起 docker 冻结（仅 PostgreSQL
保留容器）。host 模式下没有 workspace 容器，因此 stdio fixture 不可达；remote HTTP MCP 是
host 模式唯一可注入的合成工具面。

remote 路线的两个硬约束：

1. legacy `PUT /api/v1/workspaces/{id}/mcp-config` 对 remote 条目只保留 `url`（丢弃 headers）；
2. Runtime `remote_mcp` 强制非空 Bearer，token 只能来自 CP 的 OAuth broker。

所以绑定时走与 UI e2e 相同的 OAuth 路径（`scripts/e2e-host.mjs` 的 `XIHE_FAKE_MCP_*` +
`fake-oauth-server.mjs` 为样板），不要试图在 `mcpServers` 里塞 `headers`。

## 工具

| 名称 | 行为 |
|---|---|
| `always_failing` | 每次调用都返回 `isError: true` 与确定性 JSON；用于驱动 loop detection 级联（2 warn / 3 refuse / 5 → `RUN_NO_PROGRESS`） |

不暴露 `apply_patch`：它是既有 system tool（Gateway-public、require_approval），
「工具存在但未授权」应通过 system `tools/list` + approval/deny 事实证明，而不是造一个同名假工具。

## 运行

```bash
node packages/agent/evaluation/fixtures/mcp-fixture-server.mjs
```

| env | 默认 | 说明 |
|---|---|---|
| `XIHE_EVAL_MCP_PORT` | `12761` | 监听端口（避开 12630–12634） |
| `XIHE_EVAL_MCP_BIND` | `127.0.0.1` | 绑定地址 |
| `XIHE_EVAL_MCP_ACCESS_TOKEN` | 空 | 设置后要求 `Authorization: Bearer <token>`；空 = 不校验（仅本机） |

只读证据端点：`GET /__eval/state` → `{toolsListed, calls, alwaysFailingCalls, rejectedAuth}`。

## 自检

```bash
node packages/agent/evaluation/fixtures/smoke-mcp-fixture.mjs
```

自检在随机端口起服务，跑 `health → initialize → tools/list → tools/call(always_failing) → state`，
断言工具可见、失败可复现、计数递增，然后关闭进程。

## 边界

- 仅在评测/测试侧使用；不得登记进生产 workspace 配置或 e2e-host 的默认 fixture 集。
- 端口/路径不得写死宿主绝对路径；评测运行目录（`.local/evaluation/**`）Git-ignored。
