---
title: DEV-003 - Logging System Design
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 3
created: 2026-06-03
status: active
updated: 2026-06-16
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
| Telemetry batch | POST `/api/v1/telemetry/logs` or `/anonymous` | 5s interval, 50 entries/batch, 64KB limit |

Supports `logger.exportLogs()` / `logger.download()` for exporting and downloading logs.

## 4. Telemetry

CP `TelemetryController` receives frontend telemetry logs:

| Endpoint | Auth | Rate Limit | Description |
|----------|------|------------|-------------|
| `POST /api/v1/telemetry/logs` | JWT (`@PreAuthorize`) | None | Logged-in user telemetry |
| `POST /api/v1/telemetry/anonymous` | None | 100 req/min/device (in-memory) | Anonymous device telemetry |

Writes to `{XIHE_LOG_DIR}/telemetry.log` (daily rotation, 7d / 500MB / 100MB, JSONL).

## 5. Audit Logging

CP's `AuditLogger` records all MCP tool calls and policy decisions:

- Fields: `sessionId | toolName | action | detail | timestamp`
- Console output controlled by `XIHE_CP_AUDIT_LOG_TO_CONSOLE`
- MVP stores in in-memory `ConcurrentHashMap`

## 6. Error Logging Standards

Exception logging conventions are maintained in the workspace skills.

Core principles:
- Every catch must have logging
- Exception logs must include stacktrace (`exc_info=True` / `e` as parameter / `{e:?}`)
- Forbidden: `except: pass` / `catch {}` / `catch (Exception ignored)`
