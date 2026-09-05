---
title: DEV-003 - Logging System Design
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 3
created: 2026-06-03
status: active
updated: 2026-08-28
---

# DEV-003: Logging System Design

## 1. Architecture Overview

xihe uses a **layered unified** logging system:

```
XIHE_LOG_LEVEL (global default)
  ├── XIHE_LOG_LEVEL_UI       → Vite logLevel + browser logger (3-way parallel)
  ├── XIHE_LOG_LEVEL_CP        → Logback (logback-spring.xml)
  ├── XIHE_LOG_LEVEL_AGENT     → loguru (Python)
  └── XIHE_LOG_LEVEL_RUNTIME   → tracing EnvFilter
        └── XIHE_RUNTIME_LOG_FILTER (higher priority, full EnvFilter syntax)
```

Each module outputs independent JSONL log files, with log format unified as JSON Lines (one JSON record per line).

### 1.1 File Log Overview

| Module | Framework | File | Rotation | Retention | Format |
|--------|-----------|------|----------|-----------|--------|
| Control Plane | Logback + LogstashEncoder | `{XIHE_LOG_DIR}/cp.log` | Daily rotation `%d{yyyy-MM-dd}.%i.gz` | 7d / 1GB / 100MB | JSONL |
| Agent | loguru | `{XIHE_LOG_DIR}/agent.log` | 100MB | 7 backups | JSONL |
| Runtime | tracing + tracing-appender | `{XIHE_LOG_DIR}/runtime.log` | Daily rotation | 30d (logrotate) | JSONL |
| UI (IndexedDB) | Dexie | Browser IndexedDB | 10k entry limit with auto-cleanup | — | JSON |
| UI (telemetry) | CP TelemetryController | `{XIHE_LOG_DIR}/telemetry.log` | Daily rotation `%d{yyyy-MM-dd}.%i.gz` | 7d / 500MB / 100MB | JSONL |

### 1.2 Log Levels

| Level | Meaning | Usage |
|-------|---------|-------|
| `trace` | Fine-grained debugging | Runtime internal details |
| `debug` | Debug information | Expected failures (user cancellation, JSON parse fallback) |
| `info` | Normal information | Startup, connections, critical business events |
| `warn` | Warning | Recoverable exceptions, authentication failures, config degradation |
| `error` | Error | Unrecoverable exceptions, catch blocks |

## 2. Configuration

### 2.1. Environment Variables

| Variable | Scope | Default | Example |
|----------|-------|---------|---------|
| `XIHE_LOG_DIR` | Log file directory | `logs` | `logs` |
| `XIHE_LOG_LEVEL` | All modules fallback | `info` | `debug` |
| `XIHE_LOG_LEVEL_UI` | UI Vite logLevel + browser log | `info` | `info` |
| `XIHE_LOG_LEVEL_CP` | CP Logback package level | `INFO` | `DEBUG` |
| `XIHE_LOG_LEVEL_AGENT` | Agent loguru level | `info` | `debug` |
| `XIHE_LOG_LEVEL_RUNTIME` | Runtime tracing filter | `info` | `debug` |
| `XIHE_RUNTIME_LOG_FILTER` | Runtime full EnvFilter syntax | — | `xihe_runtime=debug,rmcp=trace` |

Hierarchical fallback chain: `XIHE_LOG_LEVEL_<MODULE>` → `XIHE_LOG_LEVEL` → module default.

### 2.2. ConfigService Dynamic Levels

CP and Agent support dynamic log level adjustment through ConfigService:

- **CP**: `LoggingConfigInitializer` reads `levelCp`/`logLevel` from ConfigService `logging` domain at startup, calls `LoggingSystem.setLogLevel()`
- **Agent**: Fetches `logging.levelAgent` at startup; polls every 30s in the background (`_poll_log_level`), switching in real-time via `logger.remove()` + `logger.add()`

ConfigService `logging` domain fields: see `config-schemas/logging.json`.

## 3. Module Implementations

### 3.1. Agent (Python) — loguru

Uses loguru instead of Python stdlib logging:

```python
from loguru import logger

# Recoverable exception
except Exception as e:
    logger.warning("Context: {}", str(e))

# Unrecoverable exception (with stacktrace)
except Exception as e:
    logger.error("Failed: {}", str(e))
```

Log initialization (`main.py`):

```python
logger.remove(0)
logger.add(sys.stderr, level=AGENT_LOG_LEVEL.upper())
logger.add("agent.log", rotation="100 MB", retention=7, level=AGENT_LOG_LEVEL.upper(), serialize=True)
```

Third-party library stdlib logs are routed to loguru via `InterceptHandler`.

### 3.2. Control Plane (Java) — Logback + JSONL

Uses SLF4J + Logback (`logback-spring.xml`), LogstashEncoder outputs JSONL:

```java
private static final Logger logger = LoggerFactory.getLogger(XXX.class);

// Recoverable exception
catch (Exception e) {
    logger.warn("Failed to X: {}", e.getMessage());
}

// Unrecoverable exception (with stacktrace)
catch (Exception e) {
    logger.error("Failed to X: {}", e.getMessage(), e);
}
```

Log configuration details: `src/main/resources/logback-spring.xml` (RollingFileAppender + LogstashEncoder).

### 3.3. Runtime (Rust) — tracing + JSONL

Uses `tracing` + `tracing-subscriber` + `tracing-appender`:

```rust
// Recoverable exception
tracing::warn!("Failed to X: {}", e);

// Unrecoverable exception
tracing::error!("Failed to X: {e:?}");
```

File output is JSONL (`fmt().json()`), no ANSI color codes (`.with_ansi(false)`).

Sub-binaries (`xihe-container-runtime`, `xihe-mcp-bridge`) use the same `XIHE_*` environment variable system, not depending on `RUST_LOG`.

### 3.4. UI (TypeScript/Vue) — 3-Way Parallel

Browser-side `logger` (`lib/logger.ts`) outputs in three parallel ways:

```typescript
import { logger } from '../lib/logger'

// All catch blocks use logger
catch (e) {
    logger.warn(`Operation failed: ${e}`)
}
```

| Output Channel | Target | Description |
|----------------|--------|-------------|
| Console | `console.log/debug/warn/error` | Development debugging |
| IndexedDB | Dexie (`XiheLogDB.logs`) | Local persistence, 10k entry limit, auto-cleanup |
| Telemetry batch | POST `/api/v1/telemetry/logs` | 5s interval, 50 entries/batch, 64KB limit; **UI-side sending is intentionally disabled** (`sendTelemetry` drops the batch), CP endpoint retained |

Supports `logger.exportLogs()` / `logger.download()` for exporting and downloading logs.

## 4. Telemetry

CP `TelemetryController` receives frontend telemetry logs:

| Endpoint | Auth | Rate Limit | Description |
|----------|------|------------|-------------|
| `POST /api/v1/telemetry/logs` | JWT (`@PreAuthorize`) | None | Logged-in user telemetry |

> The former `POST /api/v1/telemetry/anonymous` endpoint has been removed (PLAN-245): it was blocked by the `/api/v1/**` role gate, never reachable anonymously, and had no consumers. Telemetry uses the JWT endpoint only.

Writes to `{XIHE_LOG_DIR}/telemetry.log` (daily rotation, 7d / 500MB / 100MB, JSONL; redacted via `RedactingLogstashEncoder`).

## 5. Audit Logging

CP's `AuditLogger` records all MCP tool calls and policy decisions:

- Fields: `sessionId | toolName | action | detail | timestamp`
- Console output controlled by `XIHE_CP_AUDIT_LOG_TO_CONSOLE`
- **Persistence**: written to `{XIHE_LOG_DIR}/audit.log` via the logback `AUDIT` logger (daily rotation, 30d / 1GB / 100MB, JSONL, redacted encoder); replayable after restarts
- In-memory `recentRecords` keeps only the latest 1000 entries as a query view

## 6. Log Security (Redaction / Correlation IDs / Leak Scan)

### 6.1 Redaction at the Serialization Boundary

Every module redacts at the log serialization boundary rather than relying on call-site discipline (PLAN-196):

| Module | Boundary | Implementation |
|--------|----------|----------------|
| CP | Logback encoder | `RedactingLogstashEncoder` / `RedactingPatternLayoutEncoder` (`LogRedactor`) |
| Runtime | tracing writer | `log_redact::RedactingWriter` / `RedactingMakeWriter` wrapping stdout and file layers |
| Agent | loguru patcher | `log_redact.patch_record` (`logger.configure(patcher=...)`) |
| UI | logger emit | `sanitizeData` / `redactDeep` (`lib/logger.ts`) |

Rules: sensitive keys (`token/secret/password/authorization/cookie/accessToken/refreshToken/apiKey/serviceToken/clientSecret/pkce/verifier`, case-insensitive) are replaced with `***redacted***`; Bearer tokens, JWTs (`eyJ...`), and PEM private-key patterns are replaced anywhere in strings.

### 6.2 Correlation ID Propagation

- CP entry `RequestIdFilter` generates or propagates `X-Request-Id` (regenerates a UUID when missing/oversized), binds it to MDC `requestId`, and echoes it in the response header; the shared `RestTemplate` interceptor forwards it downstream.
- Runtime axum `request_id_middleware` reads/generates `X-Request-Id`, injects a `tracing` span (`request_id` field), and echoes the header.
- Agent FastAPI middleware reads/generates `X-Request-Id`, binds it via `logger.contextualize(request_id=...)`, and echoes the header.
- `workspaceId` has a reserved MDC key (`RequestIdFilter.MDC_WORKSPACE`), set by controllers after workspace resolution.

### 6.3 Chat SSE Observability (PLAN-230)

Chat SSE and streaming logs follow PLAN-197 Appendix C canonical fields plus these component fields:

| Field | Where required | Notes |
|-------|----------------|-------|
| `requestId` | CP entry, explicitly propagated via `X-Request-Id` to `execAsync` and Agent | From `RequestIdFilter`; async thread must not rely on `MDC`/`ThreadLocal` inheritance |
| `runId` | Every `POST /api/v1/chat` run | UUID generated by CP, forwarded via `X-Chat-Run-Id` + body `runId`; present on all Agent `chat_stream_*` events |
| `sessionId` | All Chat/SSE events | Component-level appended field |
| `connectionGeneration` | `chat_sse_registered` / `replaced` / `stale_cleanup_ignored` / `client_closed` | Atomic generation from `SseEmitterManager` distinguishing new vs stale emitters |
| `eventIndex` / `tokenChars` | `chat_stream_chunk` / `chat_stream_event_received` | Per-token sequence and length — length only, never content |
| `errorCode` | Failure events | Stable codes such as `SSE_SUBSCRIPTION_REQUIRED` / `CHAT_IN_PROGRESS` / `AGENT_TIMEOUT` |
| `outcome` / `durationMs` | `chat_run_failed` / `chat_run_forwarded` etc. | Duration and result |

**CP stable events**: `chat_sse_registered`, `chat_sse_replaced`, `chat_sse_stale_cleanup_ignored`, `chat_sse_client_closed`, `chat_sse_send_failed`, `chat_run_started`, `chat_run_forwarded`, `chat_run_finished` (with `tokenCount`/`assistantChars`), `chat_run_failed`, `chat_sse_rejected`. `heartbeat` carries only `connectionGeneration` and never enters the message persistence layer.

**Agent stable events**: `chat_stream_started`, `chat_stream_chunk` (`eventIndex` + `tokenChars`), `chat_stream_finished` (`tokenCount` + `assistantChars`), `chat_stream_failed` (`errorCode` + `stacktrace`). `token` logs never include `content`; provider logs record only `provider`/`model`/`status`/`durationMs`/`errorCode`.

**Log safety**: `main.py` sets `litellm.suppress_debug_info=True` and `log_redact` masks `Authorization:`; `application.properties` reserves `spring.security.user.*` to suppress `Using generated security password`; `RequestIdFilter` is not implicitly inherited across `new Thread()`; the UI `logger` explicitly logs IndexedDB/telemetry failure paths without message body.

### 6.4 Leak Scan Gate

```bash
node scripts/scan-log-secrets.mjs [path ...]   # defaults to logs/
```

Scans for `Bearer`/JWT/PEM/`Authorization:`/JSON sensitive fields; any hit exits 1. An unreadable file or permission failure itself fails the gate (throws instead of silent `continue`). This command is the gate for PLAN-195 M6 and PLAN-230 M4.

## 7. Error Logging Standards

Exception logging conventions are maintained in the workspace skills.

Core principles:
- Every catch must have logging
- Exception logs must include stacktrace (`exc_info=True` / `e` as parameter / `{e:?}`)
- Forbidden: `except: pass` / `catch {}` / `catch (Exception ignored)`
