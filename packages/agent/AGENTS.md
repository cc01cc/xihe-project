# Package: xihe-agent

LLM 编排、工具调用、RAG — Python Agent 服务。基于 FastAPI + LangChain + LangGraph + litellm。

## Tech Stack

- **Python** 3.12 — 运行时
- **uv** — 包管理（非 pip/poetry）
- **FastAPI** — HTTP 服务框架
- **LangChain** / **LangGraph** — 编排框架
- **litellm** — LLM 调用
- **pytest** — 测试框架
- **ruff + mypy** — lint/类型检查

## Setup

```bash
cd packages/agent
uv sync          # 安装依赖（见 pyproject.toml）
```

## Commands

### File-Scoped
- Run single test: `uv run pytest tests/unit/test_file.py -k "test_name" -v`
- Lint single file: `ruff check src/xihe_agent/path/to/file.py`

### Full Suite
- `uv run pytest` — 全部测试
- `uv run ruff check src/` — lint
- `uv run mypy src/` — 类型检查

## Project Structure

```
src/xihe_agent/
├── main.py              # FastAPI 入口
├── interfaces/          # 抽象接口层（PLAN-033 / PLAN-035）
│   ├── agent_runner.py  # AgentRunner / RunnerConfig / AgentEvent
│   ├── tool.py          # BaseAgentTool / ToolSpec
│   ├── event_adapter.py # EventAdapter
│   ├── llm.py           # LLMProvider
│   ├── message.py       # Message / TextMessage
│   ├── event.py         # Event Sourcing 域事件
│   ├── event_store.py   # EventStore 接口
│   └── context.py       # AgentContext / ContextEpoch / ContextProvider
├── agent_runner/        # AgentRunner 实现
│   └── langgraph_runner.py
├── context/             # Event Sourced Context 客户端
│   ├── event_sourced_provider.py
│   ├── store_client.py
│   ├── crash_recovery.py
│   ├── sources.py
│   └── diagnostics.py   # 命令结果诊断提取/去重账本/预算（PLAN-0342）
├── adapters/            # LangChain 适配器与自定义工具
│   ├── sse_adapter.py
│   ├── approval_tool.py
│   └── mcp_client.py
├── llm/                 # LLM 调用（base.py — ConfigClient 获取 provider）
├── tools/               # 工具调用（init.py — ProviderManager）
├── rag/                 # RAG 检索
├── registry/            # Worker Registry
└── config_client.py     # CP 配置客户端
```

## Key Conventions

- `snake_case` 命名
- 配置通过 ConfigClient 从 CP 获取，不从环境变量直接读取
- model 格式为 `provider/model`（litellm 要求）
- Agent 启动和周期 refresh 使用 atomic runtime snapshot；`llmReady` 必须独立于 HTTP liveness，并按 `missing_credentials`/`invalid_credentials`/`unreachable`/`model_unavailable`/`ready` fail-closed
- `/internal/v1/agent/chat` 显式接收 `provider`、`model` 和 `toolMode`；`toolMode=none` 不初始化 MCP，`workspace` 模式必须绑定 workspace 且不得复用其他 workspace 的 MCP context
- 每个 catch 必须有日志 + stacktrace
- `interfaces/` 目录下禁止直接 import `langchain*`；LangChain 特定代码收敛到 `agent_runner/langgraph_runner.py` 和 `adapters/`
- Agent 编排通过 `AgentRunner` 接口，不直接调用 LangGraph
- Context 通过 `ContextProvider.load()` 获取 CP 投影后的 `AgentContext` 快照；事件持久化由 `EventStore` 写入 CP
- **诊断回灌（PLAN-0342）**：失败命令结果经 `context/diagnostics.py` 提取 L0 诊断（`path:line[:col]: message`；未命中保留原文 L2）+ 会话级去重账本/预算；结构化 bundle 经 `ToolMessage.artifact` 通道（`response_format="content_and_artifact"`，不进模型 wire），模型可见 `<diagnostics>` 文本块位于不可信信封内，durable `tool.result` payload 与 SSE `tool_result.data.diagnostics` 仅触发时携带
- **Chat 流式（PLAN-230）**：`XiheLiteLLM` 以 `streaming=True` 实现 `BaseChatModel._astream()`，使 `astream_events` 产生真实 `on_chat_model_stream`；`LangGraphEventAdapter` 按 `run_id` 记录 `streamed` 状态，`on_chat_model_end` 仅在无 stream 时 fallback 单 `token`，避免重复；`main.py` 设置 `litellm.suppress_debug_info=True` 并经 `log_redact` 掩码 `Authorization:`，日志仅 `tokenChars`/`tokenCount` 不记内容
- **Post-gate approval**：CP 闸门以 JSON-RPC `-32003` 返回，`error.data` 携带 `code=APPROVAL_REQUIRED`、`approvalRequestId`、`tool`、`expiresAt` 与 `retryHeader`。Agent 注册 waiter 等待同一 request id，批准后仅重试一次，并以 `X-Xihe-Approval-Request-Id` 头携带 grant；第二次 gate/403、过期、错配或传输失败均 fail-closed。复用 grant 必须绑定同一工具及 canonical arguments SHA-256，不得以截断 preview 匹配。
- **Tool visibility**：`apply_patch` 是 Gateway-public mutation，走正常 approval；legacy snapshot 工具已随 PLAN-0357 删除。Agent 变更至少运行 `cd packages/agent && uv run pytest tests/unit/test_approval_tool.py tests/unit/test_mcp_client.py tests/unit/test_gate_owned_approval_contract.py tests/unit/test_tool_registry_contract.py tests/unit/test_mcp_timeout_override.py -q`，并按影响范围补跑 `uv run ruff check src/` 与 `uv run mypy src/`。

## Permissions

### Allowed
- 修改 `src/`、`tests/`、`pyproject.toml`

### Require Approval
- 新增外部依赖
- 修改 ConfigClient API 路径

## Parent Project

详见 `../../AGENTS.md`。
