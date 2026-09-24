# xihe — 通用 Agent 运行时平台

> 四模块 Hub-Module 架构：多 Agent 编排、工具调用、沙盒执行、权限控制。

## Scope

| 包 | 描述 | 语言 |
|----|------|------|
| `packages/ui/` | 前端界面 (Vue 3 + Vite) | TypeScript |
| `packages/control-plane/` | 路由 + 认证 + MCP 反向代理 | Java 25 / Spring Boot 4 |
| `packages/agent/` | LLM 编排 + 工具调用 + RAG | Python 3.12 / LangChain |
| `packages/runtime/` | 文件系统 + 沙盒 + 进程管理 | Rust 1.97.1 / rmcp 3.1.4 (edition 2024) |

## Tech Stack

各包技术栈与版本以 package manifest/toolchain 为准；全局架构和模块边界见 `DEV-001` 与对应模块 DEV 文档。

## Setup

- 使用 `mise install` 和 `mise run setup` 安装固定工具链与依赖；前置条件及模块命令见 DEV-002。
- 日常 host 开发运行 `mise run dev:host`：仅 PostgreSQL 在 Docker 中，CP、Agent、Runtime、UI 由 mise 原生启动。
- `mise run dev:full` 仅用于一次性 Compose 场景，不替代 host E2E 或 Runtime 创建的 Workspace/Sandbox 验证。
- `mise run dev:reset` 默认 dry-run；显式重置前检查备份与数据范围。`reset-admin` 输出临时开发密码，不得写入脚本、源码或日志。

## Commands

- 单文件/包级命令见对应包指南；里程碑和 PLAN 收尾运行 `mise run validate`，仅按改动边界增加集成/E2E profile（DEV-020/021/022/023）。
- Compose E2E 使用 `mise run test:e2e`；Sandbox/host E2E 使用 `mise run test:e2e:host`，由 host runner 管理每轮隔离环境。清理/就绪要求见 [`DEV-020`](docs/i18n/zh-Hans/DEV-020-e2e-test-strategy.md) / [`DEV-021`](docs/i18n/zh-Hans/DEV-021-integration-test-strategy.md)。
- 环境搭建、模块任务、资源清理和全栈排障见 [`DEV-002`](docs/i18n/zh-Hans/DEV-002-developer-guide.md)。

## Architecture

四模块 Hub-Module。全局架构见 [`DEV-001`](docs/i18n/zh-Hans/DEV-001-system-architecture.md)；当前实现与项目目标契约分别按模块查阅 DEV、OpenAPI/inventory 和根级 `spec/README.md`。

- 配置边界见 [`DEV-003`](docs/i18n/zh-Hans/DEV-003-config-management.md)：bootstrap/deployment env 与 ConfigService 业务配置不是同一层；凭证只走受控加密通道，env/DB 冲突必须显式呈现，secret 不得写入仓库或日志。
- Agent、CP、Runtime、MCP 当前实现分别见 [`DEV-013`](docs/i18n/zh-Hans/DEV-013-agent-architecture.md)、[`DEV-014`](docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md)、[`DEV-015`](docs/i18n/zh-Hans/DEV-015-runtime-architecture.md)、[`DEV-016`](docs/i18n/zh-Hans/DEV-016-mcp-architecture.md)；API wire 以 `docs/api/openapi.yaml` / `inventory.md` 为准。SPEC 是目标契约入口，`proposed` 不代表已经实现。
- Runtime/Sandbox 后端与生命周期契约见 [`DEV-031`](docs/i18n/zh-Hans/DEV-031-sandbox-backend-contract.md)。未知 Workspace、后端不可用或超时必须显式失败；MXC/Docker 故障不得自动回退到宿主执行。`windows-host/unrestricted` 只能由用户显式选择；进程沙盒只约束受其管理的进程，不得据此宣称宿主 Workspace 外写入安全。host execution 仍受原有授权/审批约束；删除执行实体不得删除 WorkspaceStorage。
- Runtime 的实现字段（如 pid、wrapperPid、policyPath、mxcTier）不得透传到 API；CP/API view 必须显式过滤内部与敏感字段。
- Workspace/Session、ChatRun 与 Operation 不变量见 [`DEV-017`](docs/i18n/zh-Hans/DEV-017-session-architecture.md)、DEV-014 和对应 SPEC；模块间变更必须按下方跨协议门禁同步。

## SPEC Contract Layer

- `spec/README.md` 是项目契约入口；涉及 XH 架构/数据/API/安全边界时先读入口和关联 SPEC。`AGENTS.md` 只定义工作规则，DEV/OpenAPI/代码分别承载实现解释、wire schema 和当前事实。
- `proposed` 是目标草案，不得当作运行事实。Security 是 authentication/principal/role/scope/authorization 的唯一正文 owner；Agent 规范只写自身绑定、传播和消费。
- 一个根 SPEC 同时只能由一个 active PLAN 承接；不得由 Agent 自动改写 active SPEC。XH PLAN 声明 Spec Impact，并按 `spec/README.md` 同步 DEV、OpenAPI/事件 schema 与测试。
- SPEC 是 Agent/GitHub-only，不走文档站 frontmatter。详细规则见 `spec/README.md`、`spec/writing-guide.md` 和 [`DEV-030`](docs/i18n/zh-Hans/DEV-030-documentation-layout-and-frontmatter.md)。

## Code Style and Cross-Boundary Rules

- 命名遵循语言惯例；领域术语见 [`DEV-032`](docs/i18n/zh-Hans/DEV-032-terminology.md)。`catch` 必须记录、转换或重抛异常（`exception-audit`）。
- UI 组件与交互规则见 [`DEV-010`](docs/i18n/zh-Hans/DEV-010-ui-architecture.md)、[`DEV-011`](docs/i18n/zh-Hans/DEV-011-ui-checklist.md) 和 `packages/ui/AGENTS.md`；Chat/Session 细节见 DEV-013/014/017。
- Service 层保留纯函数边界：配置由所属调用方解析并注入；要改变 ConfigClient 依赖方向时，先核对该模块的当前 DEV/调用者。
- 配置 key 变更须同步 schema、导入模板、UI 表单和 store 域白名单；env/DB 冲突必须显式呈现，禁止静默合并，详见 DEV-003。
- 文件操作不得静默失败或绕过 `apply_patch` best-effort rollback；仍须经过正常授权/审批 gate。
- 跨协议改动涉及 route、SSE/AgentEvent、durable record、OpenAPI、Flyway、env 或多个模块时，按 `../.agents/skills/xc-cross-cutting-checklist/SKILL.md` 先定契约、同批同步消费者并验证真实链路。

## Environment and Secrets

- Bootstrap/deployment env 与运行时业务配置是不同配置面；loader、优先级和覆盖透明度以 DEV-003 与各模块实现为准。
- `.env*` 入库文件只能放非敏感占位值；真实凭证用受保护的本机/部署注入，不写入 git、脚本或日志。MCP session-id HMAC secret 必需且无硬编码 fallback，见 DEV-016。
- Config import、dev admin password 和 host/Compose 导入差异见 DEV-002/003；不得因配置未导入而绕过认证或写入明文 secret。

## Testing

- 跨服务契约按受影响边界跑真实集成链路；全量验证只在里程碑或 PLAN 收尾执行。
- UI/浏览器消费者必须做真实 Playwright 验证。Sandbox/direct-attach/WorkspaceStorage 使用隔离 DB/root 的 host profile；每次结果都 teardown，不可达依赖必须失败而非静默通过。
- Compose E2E 不证明 Runtime-created Sandbox 行为；Mock/Compose/Host E2E profile 串行运行，避免本机 Docker/浏览器资源 OOM。profile/命令见 DEV-020/021/022/023。
- Route/SSE/Flyway/tool-surface 变更须同批更新 OpenAPI/inventory 和受影响包文档，按 `xc-cross-cutting-checklist` 执行。

## Telemetry and Logging

禁止记录原始 token、凭证、私钥或不可信请求正文；保留脱敏和 secret 扫描门禁。日志与 request ID 规则见 [`DEV-004`](docs/i18n/zh-Hans/DEV-004-logging.md)。

## Runtime and MCP Boundaries

- E2E readiness、host/Compose profile、隔离数据根、teardown 和失败证据见 DEV-002/020/021；端口按 workspace SSOT，不在 XH 另建 registry。
- Agent 仅经 CP logical MCP endpoint 访问工具；CP 管 OAuth 凭证/策略，Runtime host connector 校验出网 allowlist/私网。协议、retry 和 endpoint 见 DEV-014/016 与 OpenAPI/inventory。
- 用户直连 MCP mutation 与 Agent-mediated approval 是不同授权路径；变更前先在 DEV-014/016 核对 actor 和 gate owner。Fake OAuth/MCP 单独通过不等于真实链路完成。

## Known Issues

[`DEV-018`](docs/i18n/zh-Hans/DEV-018-known-issues.md) 是 XH 当前 Known Issues/技术债入口；其未关闭条目按具体模块 DEV/承接 PLAN 核对，不能仅根据此指南或旧 PLAN 快照推断当前状态。

- 用户反馈文本中的 Vue `t()` placeholder 不得包含 `{...}`；UI 测试和封装规则见 `packages/ui/AGENTS.md`。
- MCP session-id 签名与密钥轮换行为见 DEV-016；轮换后客户端必须重新初始化。
- Chat 若显式要求 workspace tools 才初始化 MCP；纯 Chat 不因携带 workspaceId 自动发现工具，MCP context 不得跨 Workspace 复用（DEV-013）。

## Plan and Release Rules

- 遵循 workspace `plan-mode`/`plan-completion`；XH Spec Impact 和 DEV/OpenAPI 同批同步按 `spec/README.md`、DEV-030 执行。PLAN 是目录工作包，不是单文件 `PLAN-XXX.md`。
- 本指南不授权 package 发布、版本 bump、commit 或 push；任何 release 动作先核对当前项目依据并遵循 workspace permissions。

## Skills

项目特有 skill（按需 Read `.agents/skills/<name>/SKILL.md`）：

- `ai-chat-ui-design`：AI 聊天界面设计（MessageScroller 流式/自动滚动）
- `dev-host-verification`：host readiness / M1 / E2E profile 与可恢复清理

## Permissions

- **Allowed**：在已批准 PLAN 范围内修改本项目文档、源码和配置；本规则不豁免 workspace 授权与验证流程。
- **Require Approval**：架构级变更（新增模块/通信协议）、破坏式 API 变更、生产部署。
