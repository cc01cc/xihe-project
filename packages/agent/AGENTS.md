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
├── llm/                 # LLM 调用（base.py — ConfigClient 获取 provider）
├── tools/               # 工具调用（init.py — ProviderManager）
├── rag/                 # RAG 检索
└── config_client.py     # CP 配置客户端
```

## Key Conventions

- `snake_case` 命名
- 配置通过 ConfigClient 从 CP 获取，不从环境变量直接读取
- model 格式为 `provider/model`（litellm 要求）
- 每个 catch 必须有日志 + stacktrace

## Permissions

### Allowed
- 修改 `src/`、`tests/`、`pyproject.toml`

### Require Approval
- 新增外部依赖
- 修改 ConfigClient API 路径

## Parent Project

详见 `../../AGENTS.md`。
