# Agent principal 与 Workspace 绑定

> 契约状态：`active`  
> amendment 承接：PLAN-0680（2026-11-07 登记并落章：技能绑定写入面双轴——workspace 轴仅授本工作区原子、服务端定档；新章见下方「技能绑定双轴」，既有正文条款未改）；PLAN-0689（2026-11-07：删除 Session 主体/快照列，Session 身份绑定 = `session_participants` PRIMARY，Chat 不再接受 per-run `agentPrincipalId`）  
> 实现状态：`partial`（PLAN-0374 principal/Workspace binding、T3.1b/T3.3、V5/V6/V7 已验收；**scope 三档 `PERSONAL`/`WORKSPACE`/`INSTANCE` 与三段授权由 PLAN-0622 承接，尚未实现**；fork/branch producer 归 PLAN-0409/0410，Agent 铸造/多层审批后置 BL-70/71）
> Profile：`security`  
> Owner：PLAN-0374（canonical binding；spawn caller amendment per PLAN-0407 #53）；scope 三档与三段授权 amendment per PLAN-0622；技能绑定双轴 amendment per PLAN-0680  
> 消费者：CP 授权/Session/Chat admission、Workspace Agent 管理 API、UI Agent 管理与 Session 选择、PLAN-0407/0409/0410、PLAN-0622/0623  
> 来源：PLAN-0374（原承接 BL-18/BL-29；2026-09-23 G2 已冻结入 PLAN-0407 承接，执行中；本地稿 `plans/PLAN-0374-XH-agent-workspace-scope/spec/agent/principal-workspace-binding.md`）  
> 更新日期：2026-11-07

## 范围

Agent 独立主体（`agent_principals`）、Workspace 绑定 cap（`workspace_agents`）、Session 身份绑定（`session_participants` PRIMARY；PLAN-0689 已删 `sessions.agent_principal_id`/`agent_permissions_snapshot` 两列），以及创建/绑定/撤销 API 与 UI 的授权、审计和失败语义。

## 非目标

- 授权模型 canonical（grant/路径交集/派生规则正文）归 `spec/security/principal-workspace-scope.md`（PLAN-0407）。
- 不修改 PLAN-0387 active `spec/agent/role-scope-binding.md` 与 Session 生命周期 SPEC。
- fork 创建/分支上下文归 PLAN-0409/0410；`agent-templates` config-layer writes、独立 `CREATE_TEMPLATE` 授权/审计和 `approval-policy.askActionClasses` Settings 字段归 PLAN-0374 T3.1b；principal 创建/管理表单归 T3.3。Agent 自助 `CREATE_ACCOUNT/CREATE_TEMPLATE`（BL-71）与多层审批（BL-70）后置。

## 静态模型

| 实体 | 关键字段 | 约束 |
|---|---|---|
| `agent_principals` | `id UUID PK, name, template_id?, template_snapshot JSONB?, created_by_user_id FK users, disabled_at` | 稳定授权主体；可多 Session/Workspace。新建必须冻结所选或 default snapshot；V42 legacy 无可信模板来源时 template 字段可 NULL |
| `agent-templates`（config 域） | `templates[].roleId` 引用同层 `roles[]` | 一个模板可建多个 principal；修改不回溯既有 snapshot；不存 provider secret |
| `sessions` | `agent_principal_id UUID NULL, agent_permissions_snapshot JSONB NULL` | Agent ChatRun 的 Session 必须有 principal 与 instance cap；`user_id` 仅 owner/visibility，不授权 Agent；每 Session 一个 Workspace |
| `workspace_agents` | PK `(principal_id, workspace_id)`，`permissions_snapshot JSONB NOT NULL`，双 FK RESTRICT | 该 Workspace 的 binding cap；principal grants 子集 |

principal grants、Workspace binding cap、Session instance cap 是三个独立约束面；不引入 `users.type` Agent 身份或 polymorphic membership。

Fork 实现归属：0374 定义并验证 stable principal 与独立授权 root 不变量；fork API、child Session producer 与复制流程由 PLAN-0409 唯一实现。

## scope 三档与三段授权（PLAN-0622 增补，实现状态 `partial`）

> 本节由 PLAN-0622 承接；**契约先定、实现随 M1 推进**。动作/atom 的 canonical 正文仍在 `spec/security/principal-workspace-scope.md`，本节只写 Agent 侧的档位与三段关系。

### scope 属于绑定，不属于 principal

**scope 是「绑定式 scope」（BL-29 冻结语义），不是 principal 自带的授权范围。**

- `PERSONAL` / `WORKSPACE` / `INSTANCE` 三档标注的是「这是谁的主体、默认给谁用」（列在 `agent_principals.scope`，属**归属/可见性**标注）；
- **它不授予任何 permission 原子**。主体的有效范围来自**绑定的位置**：`workspace_agents` 行（在哪用）× 该主体的 grants ∩ binding cap（允许什么）；
- 因此禁止把 `principal.scope` 读作 authorization scope（也不是 OAuth/provider scope）；「INSTANCE 档可全实例用」只描述**可被发现/可绑**，不描述「权限更大」——INSTANCE 主体的动作仍受其自身 grants 与 Session cap 收口。

| scope | 谁创建 | 可见 / 可用 | 绑定要求 | 禁用权 |
|---|---|---|---|---|
| `PERSONAL` | 主体 owner 本人（`CREATE_OWN_AGENT`，user scope；要求 `owner_user_id` 非空） | 仅 owner + 被绑到的 Workspace 成员 | owner 可绑到自己有绑定权限的 Workspace；绑定时 `owner_user_id` **必须**等于绑定操作者 | owner / instance ADMIN |
| `WORKSPACE` | 该 Workspace 内有 `MANAGE_WORKSPACE_AGENTS` 的人 | 该 Workspace 成员（现行语义不变） | **需要** `workspace_agents` 行 | Workspace OWNER / instance ADMIN |
| `INSTANCE` | instance ADMIN（`CREATE_ACCOUNT`，resource `*`） | 全实例可发现 | **不需要**绑定即可用 | 仅 instance ADMIN |

约束：`scope` 与 `owner_user_id` 成对限定——`PERSONAL` 必须非空、其余两档必须为空（`ck_agent_principals_owner`）；存量 principal 一次性回填 `WORKSPACE`（它们本就只能靠 binding 使用）。

### 三段授权（创建 / 绑定 / 使用）彼此独立

| 段 | 动作 | action | 作用域 | 说明 |
|---|---|---|---|---|
| **创建** | 建 `PERSONAL` | **`CREATE_OWN_AGENT`（新增）** | user | 普通用户建自己的主体；不得用它建 WORKSPACE/INSTANCE 档 |
| | 建 `WORKSPACE` | `MANAGE_WORKSPACE_AGENTS` | workspace | 在工作区内建 |
| | 建 `INSTANCE` | `CREATE_ACCOUNT` | instance（resource `*`） | 仅 ADMIN |
| **绑定** | 挂到 Workspace | `MANAGE_WORKSPACE_AGENTS` | workspace（具体 UUID，禁 `*`） | 可授予他人 ⇒ 被授予者能在别人的 Workspace 里绑**自己**的 `PERSONAL` 主体；**不能**绑别人的 `PERSONAL` |
| **使用** | 会话里选用 | **无额外 action** | — | = 成员身份 + 可见性（三档可见集）+ 该主体的 grants ∩ binding cap；不新增「使用」原子 |

不变式：

1. 三个创建 action 与绑定 action **默认 deny、彼此独立**，不得别名合并，也不得由 `CREATE_ACCOUNT`/模板写权限隐式覆盖（沿用本 SPEC 条款 #4）。
2. `PERSONAL` 绑定必须 owner 本人执行（`owner_user_id ==` 绑定操作者），否则拒绝——防止 A 把 B 的私有主体带进 Workspace。
3. `INSTANCE` 档无需绑定，但**使用仍受 cap 与 Session cap 收口**；「无需绑定」不等于「不受限」。
4. 授权判定仍唯一由 `GrantAuthorizationService` 内核承担；本 SPEC 不建第二裁决点。

## 技能绑定双轴（PLAN-0680 增补，实现状态 `partial`）

> 本节由 PLAN-0680 作为 **R-8 amendment** 追加：上方 PLAN-0622 章与既有条款正文不变。`skill_bindings` 的 DDL 与解析/快照链自 PLAN-0628 起即为双轴；本计划打开的是 **agent 主体技能绑定写入面**的 workspace 轴，并把「工作区轴只授本工作区原子」写成条款。角色轴显式不开放（见末段）。

### 双轴与定档

绑定档位 = **subject 轴 × scope 轴**（四档可达；不存在「全员共享」第五档）：

| subject | scope | 语义 | 写入面 |
|---|---|---|---|
| `agent_principal` | `instance` | **DEFAULT 绑定**：主体在任何工作区都携带该技能 | agent 绑定面，无授权工作区上下文 |
| `agent_principal` | `workspace` | **显式绑定**：只在该工作区内携带 | agent 绑定面，带授权工作区上下文 |
| `user` | 两轴 | 用户侧技能（PLAN-0628），不参与 agent 快照 | 用户面 `/api/v1/skill-bindings`（本计划不改） |

- **档位由服务端派生，客户端不可指定**：请求体只带 `skillId`；带授权工作区上下文 ⇒ 写 `workspace(caller.workspaceId)`，无上下文 ⇒ 写 `instance`。请求体出现 `scopeType`/`scopeId` ⇒ 400 `INVALID_REQUEST`，因此调用方不能把行写到自己无权覆盖的轴。
- **显式绑定优先于默认绑定**：解析顺序冻结为「`agent_principal` 先于 `user` → `workspace` 先于 `instance` → 技能名」；同一技能在 `instance` 行与 `workspace` 行并存时只列一次，取优先级最高的档。工作区外（无该工作区上下文）只能看到 `instance` 行，故显式绑定不波及他工作区。
- **同档唯一**：`(skill, subject, scopeType, scopeId)` 重复 ⇒ 409 `SKILL_BINDING_EXISTS`；跨档并存允许（`scope_id` NULL 的 instance 行与工作区行是不同唯一键）。解绑后下一会话的快照即不含该技能（无缓存预热、无后台任务）。

### 解绑语义

- 解绑按**行自身档位**授权，不按调用方上下文猜：`instance` 行需要 instance tier；`workspace` 行需要该行所属工作区的管理权，instance tier 可跨工作区删。
- workspace tier **只能删本工作区行**：删他工作区行或 instance 行 ⇒ 404 `SKILL_BINDING_NOT_FOUND`（与「行不存在」不可区分，防跨工作区探测）。
- 解绑只移除该行：不级联删技能定义、不影响同技能其他档位的行、不改历史 Session 已发的快照。

### 跨工作区不生效

- 解析同时过滤**绑定行**与**技能定义**两侧：行须 `scope_type='instance'` 或 `scope_id=当前工作区`；定义须 `definition_scope_type='instance'` 或 `definition_scope_id=当前工作区`。
- 因此 W1 的 workspace 绑定行在 W2 的注入中**不出现**，即便主体相同。
- 把**他工作区的私有技能定义**绑给主体 ⇒ 404 `SKILL_NOT_FOUND`（不是 403、也不是 400）：他工作区资产在本工作区按不存在处理。本工作区私有定义可绑（201），绑定行落本工作区轴。

### 原子来源限定（工作区轴只授本工作区原子）

- workspace 轴的绑定行**只授本工作区的原子**：可引用定义 = 本工作区私有定义 + instance 技能库定义；写入行固定 `scope_id=本工作区`，不产生 instance 行。
- instance 技能库定义本身实例级可见，工作区轴绑定只是**收窄生效范围**（不扩大可见面、不新增能力），因此不构成 cap 提权。
- 授权门不变（两道，缺一即 403）：instance tier = `MANAGE_AGENT_PRINCIPALS`；workspace tier = 在授权工作区持有 `MANAGE_WORKSPACE_AGENTS`。actor 不得是 subject 本身（403）。授权工作区可由 `X-Workspace-Id` 头或 `?workspaceId=` 传入，二者冲突 ⇒ 400 `WORKSPACE_CONTEXT_CONFLICT`。
- 用户面 `/api/v1/skill-bindings` 仍是**调用方指定档位**的旧面，其 `400 SKILL_DEFINITION_OUT_OF_SCOPE` 仍然存在；该错误码只在 agent 绑定面退役，不标全局废弃。

### 角色轴暂不开放

`role_bindings` 的 workspace 行只作为**可达性/cap 输入**（PLAN-0629 语义），agent 主体的角色绑定面**维持单轴**（instance 派生 + cap 天花板）：本轮只开技能轴，角色轴的 cap 按轴求值另案（BL-287 重证后）。因此「技能已双轴」不等于「角色可绕过 cap」——两轴共用同一授权门，但能力上限规则不同。

### 测试锚点

- CP 契约（装配级：真 interceptor + controller + service，mock 持久层）：`AgentPrincipalSkillBindingContractTest` —— 服务端定档、双档并存、他工作区私有定义 404、workspace tier 不能删 instance/他工作区行、无授权 403。
- 解析与快照：`SkillCatalogSourceServiceTest`、`SkillCatalogSnapshotServiceTest`（`tier` 三元组 `subjectType/scopeType/definitionScopeType` 与去重优先级）。
- 用户面回归：`SkillBindingServiceTest`（`/api/v1/skill-bindings` 契约不变）。
- UI：`packages/ui/src/features/workspace/components/__tests__/WorkspaceAgentsPanel.spec.ts`（档位徽标 `agent-skill-scope-{instance|workspace}`）。
- 真栈（待窗口）：host E2E 单 spec 断言 `skills_snapshot.items[].tier`；证据与窗口记录见 `plans/PLAN-0680-XH-spec13-skill-dual-axis/`。

### Spec Impact

- 承接 PLAN：PLAN-0680；同批同步 `docs/api/openapi.yaml` 的两条 agent-principal 技能绑定面与 `DEV-014` §14b/§14c。
- 不新增权限原子、不新增 Flyway 迁移；`spec/security/principal-workspace-scope.md` 只登记指针，principal/role/scope 授权正文仍归 Security。

## 规范条款与不变式

1. Agent action 判定 = principal grants ∩ 当前 Workspace binding cap ∩ Session cap ∩ spawn ancestor 链上每个 Session cap；fork 不沿 spawn ancestor 链（fork 是授权 root）。任一环缺失/撤销/非法路径 fail-closed。
2. `user_id` 不参与 Agent grants；user-only 路径与 Agent 路径互不替代，WorkspaceUser 成员关系与 WorkspaceAgent binding 独立生效。
3. cap 写入 subset 判据：actionClass 一致；ceiling resource `*` 可覆盖具体 resource，其余 resource pattern 必须全等；不推断一般 glob 包含。写入同时受操作者当前 grants 与 principal grants 限定。
4. `CREATE_ACCOUNT`、`CREATE_TEMPLATE`、`MANAGE_WORKSPACE_AGENTS` 是三个独立授权 action，默认 deny，不得别名合并或由模板 config 写权限替代。人类 USER 的 `CREATE_ACCOUNT`/`MANAGE_WORKSPACE_AGENTS` 授予只经 PLAN-0585 管理员最小写面（`GET/PATCH /api/v1/principal-grants/{username}`）：仅 instance ADMIN 可调用，允许 self-grant（响应不含 `self` 字段，仅审计记 `self=true`），写只落该 USER 的 `source='direct'` 行（`uq_grants_direct_subject`），**不改 `source='default'` 默认集**；`CREATE_TEMPLATE` 不在该写面（仍无授予路径）。
5. CP internal spawn service route（`POST /internal/v1/agents/spawn`）仅认 service Bearer；请求严格 `{parentRunId, toolCallId}`，principal/owner/workspace/tool 由 durable parent run + 匹配的 MCP invocation（`source='agent'`、`run_id=parentRunId`、`tool_call_id`）派生；忽略/拒绝任何注入字段（400/401/403/404/409）。该 route 不是 Agent 的 tool caller。
6. Agent 生产 spawn caller 必须是 CP logical MCP endpoint 发布的 CP-owned `spawn_agent` tool；`LCToolAdapter` 以 LangChain callback `run_manager.run_id` 贯通 EventStore、Agent SSE 和 MCP `X-Tool-Call-Id` header。provider ToolMessage ID 仅是 LangGraph 内部关联，不作为 CP MCP invocation key。CP 在 grant/approval gate 后本地派发，禁止 Agent 直调 internal spawn route。
7. `POST /api/v1/sessions` 必须显式 `agentPrincipalId` 并校验 binding；创建时在同一事务写入 `session_participants` PRIMARY 行（PLAN-0689 起会话不再有主体列）。Chat admission 只接受已有 PRIMARY 的 Session，**无 lazy-create、无 principal-null 占位首绑**；Chat 请求 MUST NOT 携带 per-run `agentPrincipalId`（wire 字段已删），回应者由显式 TO > `@` > PRIMARY 解析并落 `chat_runs.agent_principal_id`。PRIMARY 行不可移除/更换（409）。
8. 每项变更写 `audit_logs`（`agent_principal_created`、`workspace_agent_bound`/`workspace_agent_cap_updated`/`workspace_agent_unbound`，以及授权写面的 `principal_grant_added`/`principal_grant_removed`），含 actor、authorizationAction、object 与 permission diff；授权行审计以 `resource_id=<目标 userId>` 定位、`workspace_id` 对实例级 `CREATE_ACCOUNT` 为 null、对 `MANAGE_WORKSPACE_AGENTS` 为目标 Workspace；snapshot/API/audit 不含 systemPrompt 原文、provider secret 或 token。
9. 人类创建账户与创建模板是分离授权/审计的两种操作；可创建权限不得超出操作者当前权限子集。V1 仅 human 执行；Agent 自助与多层审批按 BL-71/BL-70 后置，不得由模板 CRUD、spawn 或 config 写权限旁路。

## 状态、失败与恢复

- binding 缺失、撤销、空 cap、principal disabled、非法 provenance 链 → 拒绝且不写入；撤权在下一工具边界生效，已返回的决策不被追溯修改。
- pending approval 不绕过重评：授权拒绝发生在审批评估之前。
- principal-null Session：附件占位/导入历史/user-direct MCP invocation fallback 保持 no Agent grant；记录 user-direct MCP invocation 或 tool ContextEvent 后不得升级为 Agent Chat。
- 解绑只影响本 Workspace：阻止该 Workspace 新 Session/Run，保留历史 Session 与其他 Workspace binding。

## 代表性场景

- 授权 human 创建 principal（`CREATE_ACCOUNT`）→ 单独绑定到 Workspace 并设 cap（`MANAGE_WORKSPACE_AGENTS`）→ Agent Session 创建/首绑 → 工具边界按四重交集判定 → 改 cap/解绑后下一工具调用按新事实重算。
- spawn 子 Session 复用 parent principal、cap 逐级只减不增；root cap 收窄在下一边界重新拒绝对应子级动作。
- 仅有 `CREATE_ACCOUNT` 的用户创建成功但绑定 403，DB 无 binding/audit 增量。

## 跨模块数据流

UI → `POST /api/v1/agent-principals`、`GET/PUT/DELETE /api/v1/workspaces/{id}/agents`、`GET/PATCH /api/v1/principal-grants/{username}`（仅 ADMIN 的授权写面，PLAN-0585）；Agent → CP logical MCP tool `spawn_agent`（MCPProxy gate 后 CP 本地执行）；`POST /internal/v1/agents/spawn` 保留为 CP internal service surface，不是 Agent caller。wire 字段、错误码与 schema 以 `docs/api/openapi.yaml` 与 `docs/api/inventory.md` 为准；本文件不复制字段表。

## 兼容与迁移

- V42（PLAN-0374）：schema + root-only backfill（仅 `kind IS NULL`、恰一条 Agent default grant 且被 owner User default 覆盖的 root；derived/orphan/越权 default 阻断），audit `agent_principal_backfilled`，失败整事务回滚。
- 迁移序列冻结：V42（0374）→ V43（0410）→ V44（0407）→ V45（0408）→ V46（0409）；下游不得改号或覆盖 V42。

## 验证映射

- 授权交集/链/独立性：`GrantAuthorizationServiceIntegrationTest`（真实 PostgreSQL；含多级 spawn 链、fork root、WorkspaceUser/WorkspaceAgent 双向独立、user_id-only deny、撤权边界）。
- Migration/schema：`DomainSchemaMigrationTest`、`AgentPrincipalMigrationTest`。
- Spawn route：`AgentSpawnPrincipalContractTest`；管理/创建 API：`WorkspaceAgentControllerContractTest`、`AgentPrincipalControllerContractTest`；授权写面：`PrincipalGrantAdminControllerContractTest`（读/写/幂等/审计/越权/并发）、`PrincipalGrantAuthorizationIntegrationTest`（授权后 create 201 + 绑定成功、撤销后 403）；Session entrypoint：`ChatSubmissionServiceIntegrationTest`、`ChatIntegrationTest`、`SessionIntegrationTest`。
- 真实浏览器：`packages/ui/e2e/real/workspace-agent-management.spec.ts`（PLAN-0374 evidence `t4-4-workspace-agent-browser.md`）。
- 技能绑定双轴（PLAN-0680）：`AgentPrincipalSkillBindingContractTest`（服务端定档 / 跨工作区 404 / 解绑授权）；解析与快照 tier 见 `SkillCatalogSourceServiceTest`、`SkillCatalogSnapshotServiceTest`；UI 档位徽标见 `WorkspaceAgentsPanel.spec.ts`；真栈证据见 PLAN-0680 evidence（待窗口）。

## 来源与变更关系

由 PLAN-0374 本地 spec 在实施波次晋升为 canonical；spawn caller 边界由 PLAN-0407 design #53 修订（Agent 经 CP-owned MCP tool；internal route 不变但不再作为 caller），caller 通道已随 0407 T2.10 交付（CP logical MCP `spawn_agent` + 既有 grant/approval gate）。技能绑定双轴章由 PLAN-0680 于 2026-11-07 追加（R-8 amendment）：DDL/解析链保持 PLAN-0628 双轴不变，只打开写入面 workspace 轴并把原子来源限定写成条款。实现状态仍为 `partial` 的后置项：fork 创建（PLAN-0409）、branch context（PLAN-0410）、Agent 自助铸造及多层审批（BL-71/BL-70）。PLAN-0374 T3.3/V5/V6/V7 当前实现与真实浏览器/审计证据见 `plans/PLAN-0374-XH-agent-workspace-scope/evidence/t3-3-template-ui.md`；本 SPEC 描述目标，不替代该证据。
