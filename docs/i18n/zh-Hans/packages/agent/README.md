---
title: "@xihe/agent"
category: dev-guide
lang: zh-Hans
sidebar_group: "@xihe/agent"
sidebar_order: 4
---

# xihe-agent

LangChain/LangGraph Agent 服务，为 xihe 平台提供 AI Agent 运行时。

## Agent Worker Registry

Agent Worker Registry 支持从 `agents/` 目录下的 markdown 文件动态加载 Agent Worker。

### 启用

Agent Worker Registry 由 **CP 业务配置** `agent-runtime.useRegistry` 控制：设置页「配置 → agent-runtime → useRegistry」勾选，或写进配置导入文件（键位见 `config.import.example.jsonc`）。默认 `false`；Agent 在下次配置刷新后生效。

> 历史说明：早期文档给的是 `export XIHE_USE_REGISTRY=true`。该环境变量**没有任何消费者**（registry 门只读 CP 配置 `agent-runtime.useRegistry`），设了也不会生效 —— 在旧文档或旧脚本里看到这一行，直接忽略（BL-543）。

### Worker 文件格式

每个 markdown 文件定义一个 Agent Worker，YAML frontmatter 声明元数据，正文为 system prompt：

```markdown
---
id: research              # 唯一标识，用于 registry 查找和 API 路由
name: 研究助手             # 人类可读名称
enabled: true             # 是否激活（默认 true）
description: 网页搜索     # Supervisor 路由描述
tool_keys:                # 可选，MCP 工具白名单
  - web_fetch
  - extract_pdf_text
---

You are a research specialist. Use web_fetch and extract_pdf_text to gather information.
Answer in Chinese by default.
```

### 目录

- `agents/` — Agent Worker markdown 文件目录（通过 `XIHE_AGENT_WORKERS_DIR` 配置，默认 `./agents/`）

### 文件监控

watchdog 自动监控 `agents/` 目录（0.5s 防抖）：

| 事件 | 行为 |
|------|------|
| 文件创建 | 注册新 worker |
| 文件修改 | 重载 worker（更新 prompt 和配置）|
| 文件删除 | 注销 worker |

### HTTP API

| 端点 | 说明 |
|------|------|
| `GET /internal/v1/agent/registry/workers` | 列出所有 worker 及状态 |
| `POST /internal/v1/agent/registry/workers/{id}/enable` | 启用 worker |
| `POST /internal/v1/agent/registry/workers/{id}/disable` | 禁用 worker |

### CP 配置（域 `agent-runtime`）

| 键 | 默认值 | 说明 |
|------|--------|------|
| `useRegistry` | `false` | 启用 Registry 模式（**不是**环境变量：`XIHE_USE_REGISTRY` 无消费者，见 BL-543） |
