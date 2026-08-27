---
title: USER-001 - User Guide
category: guide
lang: en
sidebar_group: "User Guide"
status: active
created: 2026-05-28
updated: 2026-06-15
---

# User Guide — xihe Agent Platform

## 1. Quick Start

### 1.1. System Requirements

- Docker Desktop (or Docker Engine)
- Node.js 22+ (UI frontend)
- `mise` installation recommended

### 1.2. Installation

```bash
mise install
mise run setup
cp .env.example .env.dev
# Edit .env.dev, set XIHE_DEEPSEEK_API_KEY
```

### 1.3. Startup

```bash
# One-click startup (recommended)
mise run dev:full
```

`dev:full` will:
1. Start CP / Agent / Runtime / PostgreSQL via Docker Compose
2. Wait for CP health check to pass
3. Start UI on host (Vite dev server)

Open browser at `http://localhost:12630`.

### 1.4. Registration and Login

First-time use requires account registration:
1. Open `http://localhost:12630`
2. Click "Register"
3. Fill in email, password (≥8 characters), name
4. After login, automatically redirects to chat interface

### 1.5. Testing

```bash
mise run validate       # All unit tests
mise run validate:full  # Unit + integration + E2E
```

## 2. Feature Usage

### 2.1. Chat

1. Click "+" in the sidebar to create a new session
2. Enter message in the input box, press Enter to send
3. Agent replies via SSE streaming
4. Tool calls displayed as collapsible cards with details

### 2.2. Multimodal

| Feature | Operation | Description |
|---------|-----------|-------------|
| **Image Upload** | Drag and drop / click to select | Auto Canvas compression ≤1920px |
| **Screenshot** | Click screenshot button | Screen Capture API |
| **Voice Input** | Click microphone button | Browser Web Speech API |
| **Voice Output** | AI reply read-aloud | Browser TTS |
| **PDF** | Drag and drop upload | pdfjs-dist preview + text extraction |

### 2.3. MCP Tools

Agent can invoke Runtime tools through MCP reverse proxy:

| Tool | Description | Example |
|------|-------------|---------|
| `read_file` | Read file | "Read /tmp/test.txt" |
| `write_file` | Write file | "Write /tmp/output.txt with content hello" |
| `list_directory` | List directory | "List /tmp directory contents" |
| `glob` | File matching | "Find all .py files" |
| `grep` | Text search | "Search for files containing TODO" |
| `execute_command` | Execute command | "Run ls -la" |

### 2.4. Agent Approval

When Agent needs to perform high-risk operations, an approval window pops up:
- **Approve**: Allow Agent to continue
- **Reject**: Block the operation

### 2.5. Settings

Click the settings icon at the bottom of the sidebar:
- **Model**: LLM Provider (OpenAI / DeepSeek / Xiaomi MiMo / Anthropic presets + custom), Model, API Key, Base URL
  - Selecting a preset Provider auto-fills model name and API Base URL
  - Selecting "Custom" allows manual input of any Provider information
- **Theme**: dark / light / system
- **MCP**: MCP Server management
- **Workspace**: Workspace management
- **Knowledge Base**: Document upload, chunking, Embedding

## 3. Configuration

### 3.1. LLM Providers

System has 5 built-in preset Providers, also supports custom OpenAI-compatible Providers:

| Value | Description | Required |
|-------|-------------|----------|
| `mock` | Mock mode, returns fixed responses | None |
| `deepseek` | DeepSeek V3/R1 series | `XIHE_DEEPSEEK_API_KEY` |
| `openai` | OpenAI GPT series | `XIHE_OPENAI_API_KEY` |
| `xiaomi` | Xiaomi MiMo series | `XIHE_XIAOMI_API_KEY` |
| `anthropic` | Anthropic Claude series | `XIHE_ANTHROPIC_API_KEY` |
| `ollama` | Local Ollama | Ollama service running |
| `custom` | Any OpenAI-compatible API | API Key (if applicable) |

Providers can be managed in the model configuration on the settings page. Selecting a preset auto-fills model name and Base URL.

### 3.2. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XIHE_LLM_PROVIDER` | `deepseek` | LLM provider (deepseek/openai/anthropic/ollama/xiaomi/mock) |
| `XIHE_DEEPSEEK_API_KEY` | — | DeepSeek API Key |
| `XIHE_DEEPSEEK_MODEL` | `deepseek-chat` | DeepSeek model |
| `XIHE_XIAOMI_API_KEY` | — | Xiaomi MiMo API Key |
| `XIHE_XIAOMI_MODEL` | `mimo-v2-omni` | Xiaomi MiMo model |
| `XIHE_CP_PORT` | `12631` | CP port (host mapping, Docker internal is 8080) |
| `XIHE_AGENT_PORT` | `12632` | Agent port (host mapping, Docker internal is 8000) |
| `XIHE_RUNTIME_PORT` | `12633` | Runtime port (host mapping, Docker internal is 8001) |
| `XIHE_UI_PORT` | `12630` | UI port (overridable by environment variable) |
| `XIHE_CP_DATASOURCE_URL` | `jdbc:postgresql://localhost:12634/xihe` | Database connection (host mapping, Docker internal is 5432) |
| `XIHE_CP_JWT_SECRET` | — | JWT signing key |
| `XIHE_LOG_LEVEL` | `info` | Log level |

## 4. Troubleshooting

| Symptom | Cause | Solution |
|---------|-------|----------|
| UI cannot connect to CP | Docker services not started | `docker compose up -d` |
| Agent MCP retry | CP not yet ready | Wait for CP startup to complete (~10s) |
| Registration returns 400 | Password less than 8 characters | Use ≥8 character password |
| 401 error | Not logged in or token expired | Re-login |
| SSE disconnect | Network issue | Auto-reconnect (exponential backoff) |
| PostgreSQL connection failure | Docker container not running | `docker compose up -d postgres` |

## 5. Keyboard Shortcuts

| Shortcut | Function |
|----------|----------|
| `Ctrl+K` | Search sessions |
| `Ctrl+Shift+N` | New session |
| `Ctrl+Shift+,` | Open settings |
| `Ctrl+Shift+Enter` | Regenerate response |
