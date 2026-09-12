---
title: DEV-004 - 日志系统设计
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 4
created: 2026-06-03
status: active
updated: 2026-09-12
---

# DEV-004: 日志系统设计

> 面向排障：先看 §1 表格定位文件，再按 §6 查脱敏与扫描门禁。PLAN-230 事件名以 §6.3 为准。

## 1. 架构概览

xihe 采用**分层统一**的日志系统：

```
XIHE_LOG_LEVEL (全局默认)
  ├── XIHE_LOG_LEVEL_UI       → Vite logLevel + 浏览器 logger (console/IndexedDB 有效，telemetry 发送已禁用)
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
| Runtime | tracing + tracing-appender | `{XIHE_LOG_DIR}/runtime.log`（host） | 日轮转 | 依赖外部 logrotate（未入仓） | JSONL |
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

运行期日志级别的权威是 DB `logging` 域（**instance 层唯一**，仅 ADMIN 可写，决策 #23；域键：`logLevel`/`levelAgent`/`levelCp`/`levelRuntime`/`levelUi`）。env 仅承担启动早期引导（DB 未就绪时）：

- **CP**: `LoggingConfigInitializer` 启动时从 ConfigService `logging` 域读取 `levelCp`/`logLevel`，调用 `LoggingSystem.setLogLevel()`；写入/删除该域时发布 `LoggingConfigChangedEvent` 热更 logback
- **Agent**: 启动时拉取 `logging.levelAgent`；运行中每 30s 后台轮询（`_poll_log_level`），通过 `logger.remove()` + `logger.add()` 实时切换
- **Runtime**: `levelRuntime` 由 env 承担（`XIHE_LOG_LEVEL_RUNTIME → XIHE_LOG_LEVEL → RUST_LOG`，决策 #29）——Runtime 无 config 拉取通道；DB 键位保留供未来 channel push 接线
- **UI**: `levelUi` 为前端过滤等级

ConfigService `logging` 域字段见 `config-schemas/logging.json`；三层/域集与写权限见 DEV-003 §1。

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

Workspace 执行事件（PLAN-235 约定，`WorkspaceExecutionRouter` + oneshot exec，`info` 级，全经 `RedactingWriter`）：

| 事件 | 结构化字段 |
|------|-----------|
| exec 开始 / 成功 / 失败 | `workspaceId`、`profile`、`operation`、`requestId`、`durationMs`、`errorCode` |
| job start / cancel / cleanup | `workspaceId`、`jobId`、`status` |

`command`/`args`/`stdout` 与 `/tmp/xihe-jobs` 输出内容永不进入明文日志，由 `scan-log-secrets` 门禁覆盖。

### 3.4. UI (TypeScript/Vue) — 输出通道

浏览器端 `logger`（`lib/logger.ts`）输出通道（telemetry 发送当前禁用，见下表备注）：

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
| Telemetry batch | POST `/api/v1/telemetry/logs` | 5s 间隔，50 条/批，64KB 上限；**当前 UI 侧已禁用发送**（`sendTelemetry` 直接丢弃），CP 端点保留 |

支持 `logger.exportLogs()` / `logger.download()` 导出和下载日志。

## 4. Telemetry

CP `TelemetryController` 接收前端遥测日志：

| 端点 | 认证 | 限流 | 说明 |
|------|------|------|------|
| `POST /api/v1/telemetry/logs` | JWT (`@PreAuthorize`) | 无 | 已登录用户遥测 |

> 旧 `POST /api/v1/telemetry/anonymous` 已移除（PLAN-245）：该路径实际被 `/api/v1/**` 角色门槛拦截、从未可用，且无消费者；遥测统一走 JWT 端点。

写入 `{XIHE_LOG_DIR}/telemetry.log`（日轮转，7d / 500MB / 100MB，JSONL；经 `RedactingLogstashEncoder` 脱敏）。

## 5. 审计日志

CP 的 `AuditLogger` 记录所有 MCP 工具调用和策略决策：

- 字段: `sessionId | toolName | action | detail | timestamp`
- 控制台输出通过 `XIHE_CP_AUDIT_LOG_TO_CONSOLE` 控制
- **持久化**：通过 logback `AUDIT` logger 写入 `{XIHE_LOG_DIR}/audit.log`（日轮转，30d / 1GB / 100MB，JSONL，经脱敏 encoder），重启后可复盘
- 内存 `recentRecords` 仅保留最近 1000 条作为查询视图

## 6. 日志安全（脱敏 / 关联 ID / 泄露扫描）

### 6.1 序列化层统一脱敏

各模块在日志序列化边界统一 redact，不依赖调用点自觉处理（PLAN-196）：

| 模块 | 脱敏位置 | 实现 |
|------|---------|------|
| CP | Logback encoder | `RedactingLogstashEncoder` / `RedactingPatternLayoutEncoder`（`LogRedactor`） |
| Runtime | tracing writer | `log_redact::RedactingWriter` / `RedactingMakeWriter` 包装 stdout 与文件层 |
| Agent | loguru patcher | `log_redact.patch_record`（`logger.configure(patcher=...)`） |
| UI | logger emit | `sanitizeData` / `redactDeep`（`lib/logger.ts`） |

统一规则：

| 目标 | 处理 |
|------|------|
| 敏感 key（`token`、`secret`、`password`、`authorization`、`cookie`、`accessToken`、`refreshToken`、`apiKey`、`serviceToken`、`clientSecret`、`pkce`、`verifier` 等，大小写不敏感） | 值替换为 `***redacted***` |
| Bearer token、JWT（`eyJ...`）、PEM 私钥模式 | 在任意字符串中也被替换 |

### 6.2 关联 ID 贯通

- CP 入口 `RequestIdFilter` 生成或透传 `X-Request-Id`（超长/缺失时重新生成 UUID），写入 MDC `requestId` 并回写响应头；共享 `RestTemplate` 拦截器自动向下游透传。
- Runtime axum `request_id_middleware` 读取/生成 `X-Request-Id`，注入 `tracing` span（`request_id` 字段）并回写响应头。
- Agent FastAPI middleware 读取/生成 `X-Request-Id`，通过 `logger.contextualize(request_id=...)` 写入结构化日志并回写响应头。
- `workspaceId` 预留 MDC 键位（`RequestIdFilter.MDC_WORKSPACE`），由控制器在解析 workspace 后写入。

### 6.3 Chat SSE 可观测性（PLAN-230）

Chat SSE 与 Agent 流式的结构化日志遵循 PLAN-197 附录 C 的 canonical 字段，追加以下组件字段：

| 字段 | 必填位置 | 说明 |
|------|----------|------|
| `requestId` | CP 入口生成，经 `X-Request-Id` 显式透传至 `execAsync` 与 Agent | 来自 `RequestIdFilter`；异步线程禁止依赖 `MDC`/`ThreadLocal` |
| `runId` | 每次 `POST /api/v1/chat` 的 run | CP 生成 `UUID`，经 `X-Chat-Run-Id` 与 body `runId` 透传；Agent `chat_stream_*` 均携带 |
| `sessionId` | 全部 Chat/SSE 事件 | 组件级追加字段 |
| `connectionGeneration` | `chat_sse_registered` / `replaced` / `stale_cleanup_ignored` / `client_closed` | `SseEmitterManager` 原子递增的连接代数，用于区分新旧 emitter |
| `eventIndex` / `tokenChars` | `chat_stream_chunk` / `chat_stream_event_received` | 单 token 事件序号与长度，仅记长度不记内容 |
| `errorCode` | 失败事件 | `SSE_SUBSCRIPTION_REQUIRED` / `CHAT_IN_PROGRESS` / `AGENT_TIMEOUT` 等稳定码 |
| `outcome` / `durationMs` | `chat_run_failed` / `chat_run_forwarded` 等 | 耗时与结果 |

**CP 稳定事件**：

| 事件 | 备注 |
|------|------|
| `chat_sse_registered`、`chat_sse_replaced`、`chat_sse_stale_cleanup_ignored`、`chat_sse_client_closed`、`chat_sse_send_failed` | 连接生命周期 |
| `chat_run_started`、`chat_run_forwarded`、`chat_run_finished`、`chat_run_failed`、`chat_sse_rejected` | run 生命周期（`finished` 含 `tokenCount`/`assistantChars`） |
| `heartbeat` | 仅含 `connectionGeneration`，永不进入消息持久层 |

**Agent 稳定事件**：

| 事件 | 字段 |
|------|------|
| `chat_stream_started` | — |
| `chat_stream_chunk` | `eventIndex` + `tokenChars`（不记 `content` 明文） |
| `chat_stream_finished` | `tokenCount` + `assistantChars` |
| `chat_stream_failed` | `errorCode` + `stacktrace` |

provider 日志仅 `provider`/`model`/`status`/`durationMs`/`errorCode`。

**日志安全**（四条硬规则）：

1. `main.py` 设置 `litellm.suppress_debug_info=True`，`log_redact` 掩码 `Authorization:` 明文。
2. `application.properties` 占位 `spring.security.user.*`，抑制 `Using generated security password`。
3. `RequestIdFilter` 不跨 `new Thread()` 隐式继承。
4. UI `logger` 的 IndexedDB/telemetry 失败路径显式落错误日志，且不携带消息正文。

### 6.4 泄露扫描门禁

```bash
node scripts/scan-log-secrets.mjs [path ...]   # 默认扫描 logs/
```

扫描模式：`Bearer` / JWT / PEM / `Authorization:` / JSON 敏感字段。

- 命中即退出码 1；读取失败或权限失败本身也使门禁失败（`throw` 而非静默 `continue`）。
- 该命令是 PLAN-195 M6 与 PLAN-230 M4 的安全门禁。

### 6.5 ChatRun 与 provider 审计（PLAN-247）

- Chat 生命周期日志必须同时携带 `requestId`、`runId`、`sessionId`、`outcome` 和必要的 `errorCode`；异步 CP worker 使用显式参数传递关联 ID。
- provider 仅记录 provider/model/status/duration/errorCode 和 token/字符计数，不记录 prompt、token 内容、raw response 或凭据。
- ConfigAudit 对 provider secret 只记录 `present`/`missing` 与不可逆 fingerprint；ADMIN 配置 GET 的 raw-read 例外仅限配置 API 响应本身，不得进入日志、trace、截图或 evidence。

## 7. 错误日志规范

异常日志约定维护在当前 workspace 的通用 skill 中。

核心原则：
- 每个 catch 必须有日志
- 异常日志必须包含 stacktrace（`exc_info=True` / `e` as parameter / `{e:?}`）
- 禁止 `except: pass` / `catch {}` / `catch (Exception ignored)`

## 8. 日志编写规范（LogRecord v1，PLAN-245）

### 8.1 字段契约

每条跨模块结构化日志（JSONL）至少包含必填字段；场景字段按需携带：

| 字段 | 必填 | 说明 |
|------|------|------|
| `timestamp` | ✅ | RFC 3339 UTC（或 Unix 毫秒） |
| `level` | ✅ | trace/debug/info/warn/error |
| `service` | ✅ | cp / agent / runtime / ui |
| `event` | ✅ | 稳定事件名（snake_case，如 `channel_connected`） |
| `requestId` | 场景 | 请求链路关联（CP 入口生成） |
| `runId` | 场景 | chat run 关联 |
| `sessionId` / `workspaceId` / `deviceId` | 场景 | 租户/设备上下文 |
| `operation` | 场景 | 被执行的操作名 |
| `outcome` | 场景 | ok / failed / cancelled |
| `durationMs` | 场景 | 耗时 |
| `errorCode` | 失败时 | 稳定错误码（大写，如 `AGENT_TIMEOUT`） |

### 8.2 级别使用场景

| 级别 | 场景 |
|------|------|
| `trace` | Runtime 内部细节（帧解析、exec 中间态） |
| `debug` | 解析回退、连接细节、正常取消、高频事件采样 |
| `info` | 启动/就绪、状态变更、操作成功、连接建立/断开 |
| `warn` | 重试、降级、可恢复失败、用户拒绝、心跳超时 |
| `error` | 操作失败、未处理异常、持久化失败 |

### 8.3 异常分类处理

| 异常类别 | 级别 | 要求 |
|---------|------|------|
| 正常取消 / 客户端断开 | info/debug | 记稳定事件 + reason，不带 stacktrace |
| 预期校验失败（4xx 类） | warn | 记稳定 errorCode + 脱敏 detail |
| 可恢复外部调用失败 | warn | 记 attempt/重试上下文；不记原始 body |
| 未预期异常 | error | 必须带 stacktrace |
| 任何异常 | — | 禁止静默吞掉（`catch {}` / `except: pass`） |

### 8.4 禁止清单（红线）

- Token、Cookie、密码、`Authorization` 原文、API key。
- Prompt / 消息正文 / 工具参数原文 / stdout 内容。
- 宿主机绝对路径、容器 IP、完整 env。
- 原始 provider error body（只记 status + errorCode）。

## 9. 日志采集边界（外部采集器，PLAN-245）

### 9.1 架构

```text
各模块 stdout / 本地 JSONL（LogRecord v1 字段）
   → 外部 collector（tail 文件或容器 stdout）
   → 本地磁盘缓冲 / 批量 / 压缩 / 重试
   → HTTPS / OTLP / 云厂商日志服务
```

CP 不做日志中心：不新增 CP 日志汇聚端点；`/api/v1/logs`、`/api/v1/telemetry/logs` 仅是客户端事件入口。采集失败不得阻塞业务请求；投递语义 at-least-once，下游按日志 ID 去重。

### 9.2 采集路径

| 模式 | 来源 | 说明 |
|------|------|------|
| `dev:host` | `logs/cp.log`、`logs/agent.log`、`logs/runtime.log.*` | collector tail 文件并维护 offset；日志轮转（Runtime 按日）后续读新文件 |
| Compose | 容器 stdout/stderr 或日志目录只读挂载 | 优先容器 stdout（`XIHE_LOG_DIR=/logs` 已落盘时挂只读卷） |
| 生产 | 平台采集器（DaemonSet/sidecar/主机 agent） | 启用 TLS + 服务认证 + disk buffer；collector 选型按部署环境定（推荐 OTLP 兼容） |

### 9.3 双重脱敏

应用侧脱敏（既有 RedactingWriter / RedactingLogstashEncoder / log_redact patcher）是第一道边界；collector 侧应再配置 drop/rewrite 规则兜底。`node scripts/scan-log-secrets.mjs` 为最终门禁，覆盖 channel/LogRecord JSON 字段。
