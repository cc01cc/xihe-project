# Control Plane 包指南

## 定位与技术栈

Control Plane（CP）负责公开 API、认证/租户边界、策略与审批、Chat/MCP 编排、Workspace Job 生命周期、Audit 读面，以及 Runtime/Agent 客户端调用。技术栈：Java 25、Spring Boot 4.0.6、Maven、PostgreSQL 17、Flyway 13.4.0、JPA、Spring Security、springdoc 3.1.0。

完整架构与 API 说明：
- [`DEV-014-control-plane-architecture.md`](../../docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md)
- [`DEV-015-runtime-architecture.md`](../../docs/i18n/zh-Hans/DEV-015-runtime-architecture.md)
- [`inventory.md`](../../docs/api/inventory.md)

## 源码布局

`src/main/java/com/cc01cc/p/xihe/cp/` 下按边界组织：

- `policy/`：分层策略、Tool Face、模式与 guard。
- `chat/`：ChatRun、SSE、审批与 checkpoint API。
- `mcp/`：MCP 代理、请求重写与工具面。
- `operation/`：Workspace Job API/start/state/transition services（目录名仅是现有包路径）。
- `event/`：Workspace 事件信封与 SSE 扇出（`WorkspaceEvent` 只携带相对路径，`WorkspaceEventManager` 负责按 workspace 订阅/发布、序列号定序与 `snapshot_required`）。
- `runtime/`：CP 到 Runtime 的客户端；没有独立 `agent/` Java 包，Agent 调用适配位于所属能力包。
- `context/`、`provider/`、`oauth/`、`config/`：Context EventStore/投影、Provider/OAuth 凭据能力及配置/认证边界。
- `service/`、`entity/`、`repository/`：应用服务、持久化模型与仓储。

Session、ChatRun、Workspace Job 与 MCP invocation 生命周期的项目级 proposed SPEC 见 `../../spec/`；Agent principal 与 Workspace 绑定契约见 `../../spec/agent/principal-workspace-binding.md`（PLAN-0374）。本文件和 DEV-014/OpenAPI/代码仍是当前实现事实源。

测试位于 `src/test/java/`，按同名领域包组织；跨模块测试在 `crossmodule/`。

## 命令

在本目录执行：

```bash
mvn -o -q test-compile
mvn -o test -Dtest=ApprovalServiceTest
mvn -o -q checkstyle:check
mvn -o -q test "-Dtest=CpArchitectureRuleProbeTest"
mvn -o -q test "-Dtest=CpArchitectureTest"
```

`-Dtest=...` 替换为具体测试类（必要时加 `#method`）。完整 `mvn -o test` 只在测试波次或里程碑执行；不要把全量测试当作每次小改的默认门禁。

`mvn checkstyle:check` 对 `checkstyle.xml` 全部规则按 severity=error 阻断（POM `violationSeverity=error` + `failOnViolation=true`）；基线为 0 违规，任何新增违规都会使命令失败。规则与项目约定的对齐取舍（单行 getter、测试方法下划线命名、logger 常量白名单）见 PLAN-0458 evidence，不得未经裁定回退为 warning 或加全局抑制。

ArchUnit 1.5.1 仅在 test scope。`CpArchitectureRuleProbeTest` 验证分类、正反向 bytecode 与逻辑归属，不代表生产边界已符合；`CpArchitectureTest` 严格检查实际生产类型，不使用存量忽略。当前重构基线会因既有违规失败，报告写入 `target/cp-architecture/baseline.json`；不得为求绿删除导入、冻结豁免或改为只跑探针。按领域切片修复后重新检查。归属图的类型循环诊断不直接宣称状态 writer 环，完整强连接分组与有上限的循环示例分开记录。

Compiler、Checkstyle 和架构规则用途互补。PMD 候选已实际试跑，但当前插件组合因依赖安全公告与维护成本未采用，POM 无其 profile/plugin，不作为默认构建门；不得用自动解析默认 PMD 全规则替代本包已确认检查。

## API 与跨层契约

- 公开接口统一 `/api/v1`、Bearer 认证、`TenantContext` 租户隔离与 RFC 9457 Problem Details（含 `code`、`requestId`）。
- 服务间接口统一 `/internal/v1` 与 Bearer service auth；禁止把公开 token 或用户上下文混作服务认证。
- Branch-aware context（PLAN-0410/V43）：internal snapshot 接受 `?branchId`/`?runId`（并存不一致 409、未知/外 Session 404、缺省=root），events 请求体禁带 `branch_id`（correlation 由 CP 派生）；分支只过滤上下文、不替代授权；公开 `ChatRequest.branchId`/compact `branchId`/branch CRUD/`BRANCH_LOCK` 归 PLAN-0409。内部面见 [`DEV-014 §8d`](../../docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md)。
- Context read/replay 的 events 使用显式read DTO，不直接返回Entity；对象payload与nullable键及整批错误见OpenAPI `ContextEventReadView`。replay原事务成功提交后映射，响应映射失败不新增projection回滚。定向真实CP+PG→实际Python客户端测试为 `ContextEventReadContractIntegrationTest`，通过非敏感property `xihe.context.python` 或 `PLAN0470_AGENT_PYTHON` 指定已准备的Python3.12/httpx环境；不自动安装或skip依赖。
- Route、OpenAPI、调用方 inventory、SSE/AgentEvent、Flyway durable record 必须在同一变更波次同步；以 [`inventory.md`](../../docs/api/inventory.md) 为清单，不复制完整规范。
- Provider 连接与请求模板（PLAN-0438/0439）：连接一个 API Type、模型身份 `connectionId+modelId`、`connectionKey` 逻辑槽 overlay；类型变更走 revision CAS + impact 预览；`api-request-templates` 域发布修订不可变；Chat-only 对 `operation=chat` fail-closed。Embedding profile 与 RAG 代理（PLAN-0485）按请求解析 owner/profile。契约细节见 [`DEV-014 §8g/8h`](../../docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md) 与 [`DEV-003 §3b`](../../docs/i18n/zh-Hans/DEV-003-config-management.md)。
- llm-provider profile（PLAN-0552）：解析按 profile 所在层选 owner（workspace→workspace、user→user、instance→消费用户 USER），无隐式 workspace→user 回退；`userId` 为空直接 409。过渡开关 `cp.llm.profile-legacy-connection-fallback`（默认 false）只用于短期回退。
- Provider 凭据（PLAN-0553）：`provider_connections` 只存 `credential_id`，无 ciphertext/encryption_key_version；key 由 `credentials` 域解密，link 与 use 分别受 `credential_use`/`credential_manage` 约束；连接引用的凭据删除返回 409 `CREDENTIAL_IN_USE`。
- 审批、checkpoint、revert 的当前契约以 [`DEV-014-control-plane-architecture.md`](../../docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md)、[`DEV-015-runtime-architecture.md`](../../docs/i18n/zh-Hans/DEV-015-runtime-architecture.md) 与 inventory 为准；本文件只列边界，禁止在此重复完整字段/状态机规格。

## 实现边界

- Chat RAG（PLAN-0416）：仅未转义 `xh.rag_context` 的 native 数据槽触发 authenticated profile 解析与独立 Run-bound embedding lease；变量发布校验必须阻止伪装路径、动态 authority role 和 foreign literal 内层 token。失败沿既有 durable Run/SSE 收敛，禁止继续 Chat dispatch。

- Policy、audit 记录不得写入原始 arguments/secret；仅保存必要的 canonical hash、摘要与脱敏元数据。MCP/审批 preview 只作**有界预览**（≤4096 裸前缀截断），不做正则脱敏/改写，也不参与授权或批准后执行；结构化审计仍用 hash/白名单字段，日志出口由序列化层统一脱敏（PLAN-0407 T1.3 措辞，收敛后落位于本节）。
- 不绕过状态机直接写入状态表或 durable 记录；状态变更必须经既有 service/transition 路径。
- CP→Runtime/Agent 调用保持显式超时与错误结果，禁止 host fallback 或静默降级。
- 禁止新增固定 `sleep`、`Thread.sleep` 或无诊断的等待循环；超时、就绪与清理规则见 [`command-execution-strategies`](../../../.agents/skills/command-execution-strategies/SKILL.md)。
- 跨协议/跨服务改动先按 [`xc-cross-cutting-checklist`](../../../.agents/skills/xc-cross-cutting-checklist/SKILL.md) 定契约，再落地代码、测试与证据。

## 验证与权限

优先执行受影响测试、checkstyle 与契约测试；完整测试仅按波次/里程碑执行。新增 API、SSE、Flyway 或认证边界需要同步测试与文档 inventory。允许修改本包源码、测试与本包构建配置；新增依赖、协议/架构变更和生产操作须先获批准。

父级指南：[`A03-xihe/AGENTS.md`](../../AGENTS.md)。

- 配置元数据（PLAN-0554）：per-key source/locked/writable/instanceEligible 由 ConfigService.meta 统一计算；UI 不复制规则；非 ADMIN layer=instance 403（explicit-only 模板域只读例外）；env 锁定键 PUT/DELETE 返回 409 CONFIG_ENV_LOCKED，导入跳过并 warning。
- 管理员锁定（PLAN-0556）：锁记录只存 flag+reason+actor，值落 instance 行（A2）；生效链 env > lock > workspace > user > instance > code，锁定键在 user/workspace 的 overrides 中被剔除；锁定键任何层写入/删除/导入均被拒（409 CONFIG_KEY_LOCKED），仅 `/api/v1/config-locks` 可写；锁域（config-locks）全部 ADMIN，403 不带键名；审计写 audit_logs 且不记值；job-policy 两键为 env 映射，不可锁。
