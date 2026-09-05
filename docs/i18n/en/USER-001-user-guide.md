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

1. Click "+" in the sidebar to create a new session (navigating to `/chat/:sessionId` automatically opens a session-scoped persistent SSE: `GET /api/v1/events?sessionId=`).
2. Enter a message in the input box, press Enter or click Send. Only one in-flight message per session is allowed (`CHAT_IN_PROGRESS`); if you see “a chat run is already active”, wait for the current reply to finish.
3. Agent replies via SSE streaming: `token` increments are appended to the assistant bubble incrementally (separate `text`/`reasoning` parts), tool calls appear as collapsible cards.
4. After the first reply finishes, the SSE stays open — you can send the next message **without refreshing** and still get incremental `token`s. `done` ends the turn only, not the session SSE.
5. If the connection drops due to network jitter, the UI automatically reconnects with 250ms→5s backoff and shows “recovering”; after reconnect it reloads the canonical content.

When sending fails, the input remains in the composer. A failure before a run is created is not added to history and leaves no empty assistant bubble; deterministic failures can be retried. If the provider may already have executed when the connection drops, the run is marked `ambiguous`; the system does not retry automatically, and a confirmed retry uses a new run.

**Consecutive & streaming verification (PLAN-230)**: Real long replies should produce multiple `token` events with several visible growths before `done`; a single-shot appearance means the single-token fallback (provider without streaming). Inspect `Network → events` for `token`/`done` counts.

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

The model selector shows only verified, chat-capable models. ASR/TTS models are excluded from Chat. Provider credentials belong to the Admin configuration layer; regular users receive status without secrets.

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
| UI cannot connect to CP | Docker services not started | `docker compose up -d` or `mise run dev:host` |
| Agent MCP retry | CP not yet ready | Wait for CP startup to complete (~10s) |
| Registration returns 400 | Password less than 8 characters | Use ≥8 character password |
| 401 error | Not logged in or token expired | Re-login; the persistent SSE is closed before expiry and local token is cleared — re-login is required |
| `409 SSE_SUBSCRIPTION_REQUIRED` | Sent without an active `GET /api/v1/events` subscription | Refresh the page or wait for `connected`, then retry; UI's `ensureConnected()` will attempt one reconnect |
| `409 CHAT_IN_PROGRESS` | A run is already active in this session | Wait for the current `done` before sending; refreshing does not clear the server-side lease |
| Sent but only user bubble, no assistant reply | Previously `SSE_SUBSCRIPTION_REQUIRED`; fixed by PLAN-230 (persistent SSE + generation isolation) | Verify `Network` shows `/events` as `200 text/event-stream` and `POST /api/v1/chat` as `202`; check `logs/cp.log` for `stale_cleanup_ignored` / `replaced` |
| Long reply shows only one content change | Provider without streaming, single `token` fallback | Expected fallback — inspect `Network → events` `token` count; real MiMo should yield ≥2 `token`s |
| SSE disconnect (jitter) | Network issue or heartbeat timeout | Auto-reconnect (backoff 250ms→5s); shows `recovering` and reloads `/messages` after `done` |
| PostgreSQL connection failure | Docker container not running | `docker compose up -d postgres` or `mise run dev:host` (auto-waits for Postgres) |

## 5. Keyboard Shortcuts

| Shortcut | Function |
|----------|----------|
| `Ctrl+K` | Search sessions |
| `Ctrl+Shift+N` | New session |
| `Ctrl+Shift+,` | Open settings |
| `Ctrl+Shift+Enter` | Regenerate response |
