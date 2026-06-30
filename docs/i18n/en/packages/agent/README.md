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

```bash
export XIHE_USE_REGISTRY=true
```

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

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XIHE_USE_REGISTRY` | `false` | Enable Registry mode |
| `XIHE_AGENT_WORKERS_DIR` | `./agents/` | Worker file directory |
