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

## Package Entrypoints

- `src/xihe_agent/main.py`：FastAPI service entrypoint.
- `src/xihe_agent/config_client.py`：CP business-configuration client.
- `src/xihe_agent/interfaces/` and `agent_runner/`：Agent abstractions and orchestration; architecture details are in [`DEV-013`](../../docs/i18n/zh-Hans/DEV-013-agent-architecture.md).

## Key Conventions

- `snake_case` 命名
- 启动/部署配置（如端口、service tokens、日志参数）来自 dotenv/OS environment；业务 effective config 通过 ConfigClient 从 CP 获取。不要把 bootstrap environment 与业务配置混为一谈。
- model 格式为 `provider/model`（litellm 要求）
- Agent 启动和周期 refresh 使用 atomic runtime snapshot；`llmReady` 必须独立于 HTTP liveness，并按 `missing_credentials`/`invalid_credentials`/`unreachable`/`model_unavailable`/`ready` fail-closed
- `/internal/v1/agent/chat` 显式接收 `provider`、`model` 和 `toolMode`；`toolMode=none` 不初始化 MCP，`workspace` 模式必须绑定 workspace 且不得复用其他 workspace 的 MCP context
- 每个 catch 必须有日志 + stacktrace
- `interfaces/` 目录下禁止直接 import `langchain*`；LangChain 特定代码收敛到 `agent_runner/langgraph_runner.py` 和 `adapters/`
- Agent 编排通过 `AgentRunner` 接口，不直接调用 LangGraph
- Context 通过 `ContextProvider.load()` 获取 CP 投影后的 `AgentContext` 快照；事件持久化由 `EventStore` 写入 CP
- Agent 执行、role/scope 绑定传播和 Context/Tool 边界的项目级 proposed SPEC 见 `../../spec/agent/`；通用授权正文仍归 `../../spec/security/`
- **Diagnostics security**：诊断内容是不可信输入；模型可见诊断必须在不可信信封内，结构化 artifact 不得进入 model wire。当前通道与边界见 [`DEV-013 §3.5`](../../docs/i18n/zh-Hans/DEV-013-agent-architecture.md)。
- **Streaming and logs**：流式 token 不得因 end-event fallback 重复；日志必须脱敏 `Authorization`，不得记录 token 内容。实现导航见 [`DEV-013`](../../docs/i18n/zh-Hans/DEV-013-agent-architecture.md)。
- **Approval/grant**：CP gate 后仅可对同一 request id 等待并重试一次；grant 必须绑定同一工具及 canonical arguments SHA-256，错配、过期、复用、重复 gate 或传输失败均 fail-closed。不可用截断 preview 授权。
- **Workspace binding**：`toolMode=none` 不初始化 MCP；workspace 模式须按请求 Workspace 加载，发现结果不得跨 Workspace 复用。
- **Tool visibility and tests**：`apply_patch` 是 Gateway-public mutation，必须走正常 approval；legacy snapshot 工具已移除。Agent 变更至少运行 `cd packages/agent && uv run pytest tests/unit/test_approval_tool.py tests/unit/test_mcp_client.py tests/unit/test_gate_owned_approval_contract.py tests/unit/test_tool_registry_contract.py tests/unit/test_mcp_timeout_override.py -q`，并按影响范围补跑 `uv run ruff check src/` 与 `uv run mypy src/`。

## Permissions

### Allowed
- 修改 `src/`、`tests/`、`pyproject.toml`

### Require Approval
- 新增外部依赖
- 修改 ConfigClient API 路径

## Parent Project

详见 `../../AGENTS.md`。
