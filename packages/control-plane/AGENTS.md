# Control Plane 包指南

## 定位与技术栈

Control Plane（CP）负责公开 API、认证/租户边界、策略与审批、Chat/MCP 编排、Operation 账本，以及 Runtime/Agent 客户端调用。技术栈：Java 25、Spring Boot 4.0.6、Maven、PostgreSQL 17、Flyway 13.4.0、JPA、Spring Security、springdoc 3.1.0。

完整架构与 API 说明：
- [`DEV-014-control-plane-architecture.md`](../../docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md)
- [`DEV-015-runtime-architecture.md`](../../docs/i18n/zh-Hans/DEV-015-runtime-architecture.md)
- [`inventory.md`](../../docs/api/inventory.md)

## 源码布局

`src/main/java/com/cc01cc/p/xihe/cp/` 下按边界组织：

- `policy/`：分层策略、Tool Face、模式与 guard。
- `chat/`：ChatRun、SSE、审批与 checkpoint API。
- `mcp/`：MCP 代理、请求重写与工具面。
- `operation/`：Operation ledger 与投影。
- `runtime/`、`agent/`、`config/`：Runtime/Agent 客户端及配置/认证边界。
- `service/`、`entity/`、`repository/`：应用服务、持久化模型与仓储。

测试位于 `src/test/java/`，按同名领域包组织；跨模块测试在 `crossmodule/`。

## 命令

在本目录执行：

```bash
mvn -o -q test-compile
mvn -o test -Dtest=ApprovalServiceTest
mvn -o -q checkstyle:check
```

`-Dtest=...` 替换为具体测试类（必要时加 `#method`）。完整 `mvn -o test` 只在测试波次或里程碑执行；不要把全量测试当作每次小改的默认门禁。

## API 与跨层契约

- 公开接口统一 `/api/v1`、Bearer 认证、`TenantContext` 租户隔离与 RFC 9457 Problem Details（含 `code`、`requestId`）。
- 服务间接口统一 `/internal/v1` 与 Bearer service auth；禁止把公开 token 或用户上下文混作服务认证。
- Route、OpenAPI、调用方 inventory、SSE/AgentEvent、Flyway durable record 必须在同一变更波次同步；以 [`inventory.md`](../../docs/api/inventory.md) 为清单，不复制完整规范。
- 审批、checkpoint、revert 的当前契约以 [`DEV-014-control-plane-architecture.md`](../../docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md)、[`DEV-015-runtime-architecture.md`](../../docs/i18n/zh-Hans/DEV-015-runtime-architecture.md) 与 inventory 为准；本文件只列边界，禁止在此重复完整字段/状态机规格。

## 实现边界

- Policy、audit 记录不得写入原始 arguments/secret；仅保存必要的 canonical hash、摘要与脱敏元数据。
- 不绕过状态机直接写入状态表或 durable projection；状态变更必须经既有 service/transition 路径。
- CP→Runtime/Agent 调用保持显式超时与错误结果，禁止 host fallback 或静默降级。
- 禁止新增固定 `sleep`、`Thread.sleep` 或无诊断的等待循环；超时、就绪与清理规则见 [`command-execution-strategies`](../../../.agents/skills/command-execution-strategies/SKILL.md)。
- 跨协议/跨服务改动先按 [`xc-cross-cutting-checklist`](../../../.agents/skills/xc-cross-cutting-checklist/SKILL.md) 定契约，再落地代码、测试与证据。

## 验证与权限

优先执行受影响测试、checkstyle 与契约测试；完整测试仅按波次/里程碑执行。新增 API、SSE、Flyway 或认证边界需要同步测试与文档 inventory。允许修改本包源码、测试与本包构建配置；新增依赖、协议/架构变更和生产操作须先获批准。

父级指南：[`A03-xihe/AGENTS.md`](../../AGENTS.md)。
