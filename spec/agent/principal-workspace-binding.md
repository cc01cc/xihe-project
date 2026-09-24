# Agent principal 与 Workspace 绑定

> 契约状态：`active`  
> 实现状态：`partial`  
> Profile：`security`  
> Owner：PLAN-0374（唯一；Security principal/grant canonical 归 PLAN-0407）  
> 消费者：CP 授权/Session/Chat admission、Workspace Agent 管理 API、UI Agent 管理与 Session 选择、PLAN-0407/0409/0410  
> 来源：PLAN-0374（承接 BL-18/BL-29；本地稿 `plans/PLAN-0374-XH-agent-workspace-scope/spec/agent/principal-workspace-binding.md`）  
> 更新日期：2026-09-25

## 范围

Agent 独立主体（`agent_principals`）、Workspace 绑定 cap（`workspace_agents`）、Session principal 绑定（`sessions.agent_principal_id`/`agent_permissions_snapshot`），以及创建/绑定/撤销 API 与 UI 的授权、审计和失败语义。

## 非目标

- 授权模型 canonical（grant/路径交集/派生规则正文）归 `spec/security/principal-workspace-scope.md`（PLAN-0407）。
- 不修改 PLAN-0387 active `spec/agent/role-scope-binding.md` 与 Session 生命周期 SPEC。
- fork 创建/分支上下文归 PLAN-0409/0410；`agent-templates` CRUD 路由开放归 PLAN-0374 T3.1（依赖 0407 V44 canonical action）；Agent 自助 `CREATE_ACCOUNT/CREATE_TEMPLATE`（BL-71）与多层审批（BL-70）后置。

## 静态模型

| 实体 | 关键字段 | 约束 |
|---|---|---|
| `agent_principals` | `id UUID PK, name, template_id?, template_snapshot JSONB?, created_by_user_id FK users, disabled_at` | 稳定授权主体；可多 Session/Workspace。新建必须冻结所选或 default snapshot；V42 legacy 无可信模板来源时 template 字段可 NULL |
| `agent-templates`（config 域） | `templates[].roleId` 引用同层 `roles[]` | 一个模板可建多个 principal；修改不回溯既有 snapshot；不存 provider secret |
| `sessions` | `agent_principal_id UUID NULL, agent_permissions_snapshot JSONB NULL` | Agent ChatRun 的 Session 必须有 principal 与 instance cap；`user_id` 仅 owner/visibility，不授权 Agent；每 Session 一个 Workspace |
| `workspace_agents` | PK `(principal_id, workspace_id)`，`permissions_snapshot JSONB NOT NULL`，双 FK RESTRICT | 该 Workspace 的 binding cap；principal grants 子集 |

principal grants、Workspace binding cap、Session instance cap 是三个独立约束面；不引入 `users.type` Agent 身份或 polymorphic membership。

## 规范条款与不变式

1. Agent action 判定 = principal grants ∩ 当前 Workspace binding cap ∩ Session cap ∩ spawn ancestor 链上每个 Session cap；fork 不沿 spawn ancestor 链（fork 是授权 root）。任一环缺失/撤销/非法路径 fail-closed。
2. `user_id` 不参与 Agent grants；user-only 路径与 Agent 路径互不替代，WorkspaceUser 成员关系与 WorkspaceAgent binding 独立生效。
3. cap 写入 subset 判据：actionClass 一致；ceiling resource `*` 可覆盖具体 resource，其余 resource pattern 必须全等；不推断一般 glob 包含。写入同时受操作者当前 grants 与 principal grants 限定。
4. `CREATE_ACCOUNT`、`CREATE_TEMPLATE`、`MANAGE_WORKSPACE_AGENTS` 是三个独立授权 action，默认 deny，不得别名合并或由模板 config 写权限替代。
5. CP-Agent internal spawn（`POST /internal/v1/agents/spawn`）仅认 service Bearer；请求严格 `{parentRunId, toolCallId}`，principal/owner/workspace/tool 由 durable parent run + `(operation_id, source='agent', tool_call_id)` item 派生；忽略/拒绝任何注入字段（400/401/403/404/409）。
6. `POST /api/v1/sessions` 必须显式 `agentPrincipalId` 并校验 binding；Chat admission 只接受已绑定 Session，无 lazy-create。principal-null 空 Session 首绑条件：显式 `agentPrincipalId` + 无 ChatRun/message/user-direct Operation/ContextEvent，row CAS 与 ChatRun/Message/Operation 同事务；已绑定 Session 换 principal → 409。
7. 每项变更写 `audit_logs`（`agent_principal_created`、`workspace_agent_bound`/`workspace_agent_cap_updated`/`workspace_agent_unbound`），含 actor、authorizationAction、object 与 permission diff；snapshot/API/audit 不含 systemPrompt 原文、provider secret 或 token。
8. 人类创建账户与创建模板是分离授权/审计的两种操作；可创建权限不得超出操作者当前权限子集。V1 仅 human 执行；Agent 自助与多层审批按 BL-71/BL-70 后置，不得由模板 CRUD、spawn 或 config 写权限旁路。

## 状态、失败与恢复

- binding 缺失、撤销、空 cap、principal disabled、非法 provenance 链 → 拒绝且不写入；撤权在下一工具边界生效，已返回的决策不被追溯修改。
- pending approval 不绕过重评：授权拒绝发生在审批评估之前。
- principal-null Session：附件占位/导入历史/MCP user-ledger fallback 保持 no Agent grant；记录 user-direct Operation 或 tool ContextEvent 后不得升级为 Agent Chat。
- 解绑只影响本 Workspace：阻止该 Workspace 新 Session/Run，保留历史 Session 与其他 Workspace binding。

## 代表性场景

- 授权 human 创建 principal（`CREATE_ACCOUNT`）→ 单独绑定到 Workspace 并设 cap（`MANAGE_WORKSPACE_AGENTS`）→ Agent Session 创建/首绑 → 工具边界按四重交集判定 → 改 cap/解绑后下一工具调用按新事实重算。
- spawn 子 Session 复用 parent principal、cap 逐级只减不增；root cap 收窄在下一边界重新拒绝对应子级动作。
- 仅有 `CREATE_ACCOUNT` 的用户创建成功但绑定 403，DB 无 binding/audit 增量。

## 跨模块数据流

UI → `POST /api/v1/agent-principals`、`GET/PUT/DELETE /api/v1/workspaces/{id}/agents`；Agent → `POST /internal/v1/agents/spawn`（service Bearer）。wire 字段、错误码与 schema 以 `docs/api/openapi.yaml` 与 `docs/api/inventory.md` 为准；本文件不复制字段表。

## 兼容与迁移

- V42（PLAN-0374）：schema + root-only backfill（仅 `kind IS NULL`、恰一条 Agent default grant 且被 owner User default 覆盖的 root；derived/orphan/越权 default 阻断），audit `agent_principal_backfilled`，失败整事务回滚。
- 迁移序列冻结：V42（0374）→ V43（0410）→ V44（0407）→ V45（0408）→ V46（0409）；下游不得改号或覆盖 V42。

## 验证映射

- 授权交集/链/独立性：`GrantAuthorizationServiceIntegrationTest`（真实 PostgreSQL；含多级 spawn 链、fork root、WorkspaceUser/WorkspaceAgent 双向独立、user_id-only deny、撤权边界）。
- Migration/schema：`OperationLedgerFreshMigrationTest`、`AgentPrincipalMigrationTest`。
- Spawn route：`AgentSpawnPrincipalContractTest`；管理/创建 API：`WorkspaceAgentControllerContractTest`、`AgentPrincipalControllerContractTest`；Session entrypoint：`ChatSubmissionServiceIntegrationTest`、`ChatIntegrationTest`、`SessionIntegrationTest`。
- 真实浏览器：`packages/ui/e2e/real/workspace-agent-management.spec.ts`（PLAN-0374 evidence `t4-4-workspace-agent-browser.md`）。

## 来源与变更关系

由 PLAN-0374 本地 spec 在实施波次晋升为 canonical；无 supersede。契约状态 `active`、实现状态 `partial` 的差距项：fork 创建（PLAN-0409）、branch context（PLAN-0410）、`agent-templates` CRUD 路由与 `askActionClasses` UI（0374 T3.1，待 0407 V44/T2.8）、0407 T2.10 真实 Agent spawn caller。
