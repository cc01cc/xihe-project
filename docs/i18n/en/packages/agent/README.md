---
title: "@xihe/agent"
category: dev-guide
lang: en
sidebar_group: "@xihe/agent"
sidebar_order: 4
---

# xihe-agent

LangChain/LangGraph Agent service providing AI Agent runtime for the xihe platform.

## Agent Worker Registry

Agent Worker Registry supports dynamic loading of Agent Workers from markdown files in the `agents/` directory.

### Enable

The Agent Worker Registry is controlled by the **CP business config** `agent-runtime.useRegistry`: Settings → Config → agent-runtime → useRegistry, or the config import file (key shape in `config.import.example.jsonc`). It defaults to `false`; the Agent picks it up on its next config refresh.

> Historical note: older docs showed `export XIHE_USE_REGISTRY=true`. That environment variable **has no consumer** (the registry gate only reads the CP config `agent-runtime.useRegistry`), so setting it does nothing — ignore that line when you find it in old docs or scripts (BL-543).

### Worker File Format

Each markdown file defines an Agent Worker. YAML frontmatter declares metadata, body is the system prompt:

```markdown
---
id: research              # Unique identifier for registry lookup and API routing
name: Research Assistant   # Human-readable name
enabled: true             # Whether activated (default true)
description: Web search   # Supervisor routing description
tool_keys:                # Optional, MCP tool whitelist
  - web_fetch
  - extract_pdf_text
---

You are a research specialist. Use web_fetch and extract_pdf_text to gather information.
Answer in Chinese by default.
```

### Directory

- `agents/` — Agent Worker markdown file directory (configured via `XIHE_AGENT_WORKERS_DIR`, default `./agents/`)

### File Watching

watchdog automatically monitors the `agents/` directory (0.5s debounce):

| Event | Behavior |
|-------|----------|
| File creation | Register new worker |
| File modification | Reload worker (update prompt and config) |
| File deletion | Unregister worker |

### HTTP API

| Endpoint | Description |
|----------|-------------|
| `GET /registry/workers` | List all workers and their status |
| `POST /registry/workers/{id}/enable` | Enable worker |
| `POST /registry/workers/{id}/disable` | Disable worker |

### CP config (domain `agent-runtime`)

| Key | Default | Description |
|-----|---------|-------------|
| `useRegistry` | `false` | Enable Registry mode (**not** an environment variable: `XIHE_USE_REGISTRY` has no consumer, see BL-543) |
