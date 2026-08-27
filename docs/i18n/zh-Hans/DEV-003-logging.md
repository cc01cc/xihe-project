---
title: DEV-003 - 日志系统设计
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 3
created: 2026-06-03
status: active
updated: 2026-06-16
---

# DEV-003: 日志系统设计

## 1. 架构概览

xihe 采用**分层统一**的日志系统：

```
XIHE_LOG_LEVEL (全局默认)
  ├── XIHE_LOG_LEVEL_UI       → Vite logLevel + 浏览器 logger (3 路并行)
  ├── XIHE_LOG_LEVEL_CP        → Logback (logback-spring.xml)
  ├── XIHE_LOG_LEVEL_AGENT     → loguru (Python)
  └── XIHE_LOG_LEVEL_RUNTIME   → tracing EnvFilter
        └── XIHE_RUNTIME_LOG_FILTER (优先级更高，完整 EnvFilter 语法)
```

每模块输出独立的 JSONL 日志文件，日志格式统一为 JSON Lines（一行一条 JSON 记录）。

### 1.1 文件日志概览

| 模块 | 框架 | 文件 | 轮转 | 保留 | 格式 |
|------|------|------|------|------|------|
| Control Plane | Logback + LogstashEncoder | `{XIHE_LOG_DIR}/cp.log` | 日轮转 `%d{yyyy-MM-dd}.%i.gz` | 7d / 1GB / 100MB | JSONL |
| Agent | loguru | `{XIHE_LOG_DIR}/agent.log` | 100MB | 7 备份 | JSONL |
| Runtime | tracing + tracing-appender | `{XIHE_LOG_DIR}/runtime.log` | 日轮转 | 30d（logrotate） | JSONL |
| UI (IndexedDB) | Dexie | 浏览器 IndexedDB | 10k 条上限自动清理 | — | JSON |
| UI (telemetry) | CP TelemetryController | `{XIHE_LOG_DIR}/telemetry.log` | 日轮转 `%d{yyyy-MM-dd}.%i.gz` | 7d / 500MB / 100MB | JSONL |

### 1.2 日志级别

| 级别 | 含义 | 用途 |
|------|------|------|
| `trace` | 细粒度调试 | Runtime 内部细节 |
| `debug` | 调试信息 | 预期内的失败（用户取消、JSON 解析回退） |
| `info`  | 正常信息 | 启动、连接、业务关键事件 |
| `warn`  | 警告 | 可恢复异常、认证失败、配置降级 |
| `error` | 错误 | 不可恢复异常、catch 块 |

## 2. 配置方式

### 2.1. 环境变量

| 变量 | 作用范围 | 默认值 | 示例 |
|------|---------|--------|------|
| `XIHE_LOG_DIR` | 日志文件目录 | `logs` | `logs` |
| `XIHE_LOG_LEVEL` | 所有模块回退 | `info` | `debug` |
| `XIHE_LOG_LEVEL_UI` | UI Vite logLevel + 浏览器日志 | `info` | `info` |
| `XIHE_LOG_LEVEL_CP` | CP Logback package level | `INFO` | `DEBUG` |
| `XIHE_LOG_LEVEL_AGENT` | Agent loguru level | `info` | `debug` |
| `XIHE_LOG_LEVEL_RUNTIME` | Runtime tracing filter | `info` | `debug` |
| `XIHE_RUNTIME_LOG_FILTER` | Runtime 完整 EnvFilter 语法 | — | `xihe_runtime=debug,rmcp=trace` |

层次回退链：`XIHE_LOG_LEVEL_<MODULE>` → `XIHE_LOG_LEVEL` → 模块默认值。

### 2.2. ConfigService 动态级别

CP 和 Agent 支持通过 ConfigService 动态调整日志级别：

- **CP**: `LoggingConfigInitializer` 启动时从 ConfigService `logging` 域读取 `levelCp`/`logLevel`，调用 `LoggingSystem.setLogLevel()`
- **Agent**: 启动时拉取 `logging.levelAgent`；运行中每 30s 后台轮询（`_poll_log_level`），通过 `logger.remove()` + `logger.add()` 实时切换

ConfigService `logging` 域字段见 `config-schemas/logging.json`。

## 3. 模块实现

### 3.1. Agent (Python) — loguru

使用 loguru 替代 Python stdlib logging：

```python
from loguru import logger

# 可恢复异常
except Exception as e:
    logger.warning("Context: {}", str(e))

# 不可恢复异常（含 stacktrace）
except Exception as e:
    logger.error("Failed: {}", str(e))
```

日志初始化（`main.py`）：

```python
logger.remove(0)
logger.add(sys.stderr, level=AGENT_LOG_LEVEL.upper())
logger.add("agent.log", rotation="100 MB", retention=7, level=AGENT_LOG_LEVEL.upper(), serialize=True)
```

第三方库的 stdlib 日志通过 `InterceptHandler` 路由至 loguru。

### 3.2. Control Plane (Java) — Logback + JSONL

使用 SLF4J + Logback（`logback-spring.xml`），LogstashEncoder 输出 JSONL：

```java
private static final Logger logger = LoggerFactory.getLogger(XXX.class);

// 可恢复异常
catch (Exception e) {
    logger.warn("Failed to X: {}", e.getMessage());
}

// 不可恢复异常（含 stacktrace）
catch (Exception e) {
    logger.error("Failed to X: {}", e.getMessage(), e);
}
```

日志配置详见 `src/main/resources/logback-spring.xml`（RollingFileAppender + LogstashEncoder）。

### 3.3. Runtime (Rust) — tracing + JSONL

使用 `tracing` + `tracing-subscriber` + `tracing-appender`：

```rust
// 可恢复异常
tracing::warn!("Failed to X: {}", e);

// 不可恢复异常
tracing::error!("Failed to X: {e:?}");
```

文件输出为 JSONL（`fmt().json()`），无 ANSI 颜色码（`.with_ansi(false)`）。

子二进制（`xihe-container-runtime`、`xihe-mcp-bridge`）使用同一 `XIHE_*` 环境变量体系，不依赖 `RUST_LOG`。

### 3.4. UI (TypeScript/Vue) — 3 路并行

浏览器端 `logger`（`lib/logger.ts`）三路并行输出：

```typescript
import { logger } from '../lib/logger'

// 所有 catch 块使用 logger
catch (e) {
    logger.warn(`Operation failed: ${e}`)
}
```

| 输出路 | 目标 | 说明 |
|--------|------|------|
| Console | `console.log/debug/warn/error` | 开发调试 |
| IndexedDB | Dexie (`XiheLogDB.logs`) | 本地持久化，10k 条上限，自动清理 |
| Telemetry batch | POST `/api/v1/telemetry/logs` 或 `/anonymous` | 5s 间隔，50 条/批，64KB 上限 |

支持 `logger.exportLogs()` / `logger.download()` 导出和下载日志。

## 4. Telemetry

CP `TelemetryController` 接收前端遥测日志：

| 端点 | 认证 | 限流 | 说明 |
|------|------|------|------|
| `POST /api/v1/telemetry/logs` | JWT (`@PreAuthorize`) | 无 | 已登录用户遥测 |
| `POST /api/v1/telemetry/anonymous` | 无 | 100 req/min/device（内存） | 匿名设备遥测 |

写入 `{XIHE_LOG_DIR}/telemetry.log`（日轮转，7d / 500MB / 100MB，JSONL）。

## 5. 审计日志

CP 的 `AuditLogger` 记录所有 MCP 工具调用和策略决策：

- 字段: `sessionId | toolName | action | detail | timestamp`
- 控制台输出通过 `XIHE_CP_AUDIT_LOG_TO_CONSOLE` 控制
- MVP 存储在内存 `ConcurrentHashMap` 中

## 6. 错误日志规范

异常日志约定维护在当前 workspace 的通用 skill 中。

核心原则：
- 每个 catch 必须有日志
- 异常日志必须包含 stacktrace（`exc_info=True` / `e` as parameter / `{e:?}`）
- 禁止 `except: pass` / `catch {}` / `catch (Exception ignored)`
