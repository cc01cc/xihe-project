# XH MVP 三面设计：agent 主体 / skill 绑定 / 会话指挥

> 任务卡 task-188 · 2026-11-18 · design-mvp 产出，**设计先行，批准前不写产品代码**。
> 输入：task-183 DSH 调研（`docs/research/dsh-feature-design-input-2026-11-18.md`，341 行）+ XH 四包现状源码盘点。
> 用户锚点：D-1815 MVP 锚③④⑤。
> 证据等级：**[实测源码]** = 本轮读 XH 实现源码（路径:行号）；**[DSH 对照]** = task-183 源码级调研结论；**[推导]** = 由事实推导、未实测。
> 保守默认取舍一律标注 **【待用户醒后追认】**，不擅自定死。

## 0. 一句话结论（给 Lead 的摘要）

三面里**两面地基已存在**：agent 主体（`agent_principals`，PLAN-0374 起）与 skill 绑定（`skill_bindings` 2×2 双轴，PLAN-0628/0667/0680）的数据模型、CP API、admission 求值链路都已落地 [实测源码]。锚③④的真实缺口收敛为 **UI 配置投影 + 少量字段 wire 收口**；锚⑤（会话指挥）的 teammate=独立 ChatRun 基座也已存在（`spawn_agent`，PLAN-0407），真正的新增只有两件：**共享任务板（`team_tasks` 新表 + 8 动作 CAS + 只读面板）**与 **Lead→teammate 中途指挥消息（steer 通道）**。本设计以「复用优先、新增最少」为主线，每个新增概念都过了膨胀门。

## 1. 现状事实源盘点（设计的出发点）

### 1.1 已有资产 [实测源码]

| 面 | 现状 | 关键证据 |
|---|---|---|
| 主体实体 | `agent_principals` 表：name / template_id+template_snapshot（persona）/ hooks / context_policy / delegation_policy(maxCount,maxDepth) / default_model_provider+default_model_name / allowed_models / ownership(USER\|INSTANCE) / origin / preset_id | packages/control-plane/.../entity/AgentPrincipal.java 全文件 |
| 主体 API | `GET/POST /api/v1/agent-principals`、`PATCH/DELETE /{id}`、`POST /{id}/disable`、`GET/POST/DELETE /{id}/roles`（grants 绑定）、`GET/POST/DELETE /{id}/skills`、`GET /{id}/memories`；instance 门 `/api/v1/instance/agent-principals` | docs/api/openapi.yaml:512/701/795/878/964/1007/5160 |
| 绑定 SPEC | `spec/agent/principal-workspace-binding.md`（active）：`workspace_agents` 双 FK RESTRICT cap、`session_participants` PRIMARY 承载会话身份、三段授权（创建/绑定/使用）彼此独立 | spec 文件全量 |
| skill 库 | `SkillLibraryService` / `SkillRepository` / `SkillImportService` / `SkillAccessGuard`：skill 定义已有库与导入面，`skill_id` UUID 有主 | cp/skill/SkillLibraryService.java:30；SkillController.java:32 |
| skill 绑定 | `skill_bindings` 表：subject_type(user\|agent_principal) × scope_type(instance\|workspace) 2×2 双轴（D28-14），唯一键 `UNIQUE NULLS NOT DISTINCT (skill_id, subject_type, subject_id, scope_type, scope_id)`；「全员共享」第五档 v1 明确不做 | cp/skill/SkillBinding.java 类注释与字段 |
| skill 求值 | `SkillCatalogSourceService.resolve()`：每 Run 按 AGENT 绑定优先于 USER、workspace 窄于 instance 的序取列表，截断带诊断；admission 时冻结进 `chat_runs.skills_snapshot`；Agent 侧渲染 `${xh.skill_catalog}`（CP 定「哪些」，Agent 定「装多少」） | cp/skill/SkillCatalogSourceService.java:36-100；ChatRun.java:97；agent api/chat.py:719-746 |
| teammate 基座 | CP-owned logical MCP `spawn_agent`（PLAN-0407 T2.10）：child Session `kind=spawn`、`spawned_from_session_id/run_id/spawned_at`（V37）、`chat_runs.parent_run_id`（V105）、`DelegationChainWalker` 现算委托/唤醒深度、委派预算在 principal.delegation_policy | DEV-017 §1 派生来源表；openapi.yaml:1532/5087 |
| 收尾投递 | child 终态写 parent Inbox 为 durable source（PLAN-0408），父 ChatRun 创建事务可领取；`GET /sessions/{id}/derived-state` + SSE `derived_state_changed` hint | DEV-017 §1 派生协作通知；openapi.yaml:1518/2736 |
| 中途排队 | Session follow-up 队列（V49）：`session_follow_up_items` FIFO 上限 5，child Run 终态后才 admission，settlement 同事务推进；`409 FOLLOW_UP_QUEUE_NOT_EMPTY` | DEV-017 §1.3；openapi.yaml:1303-1349 |
| 能力原子 | `PermissionAtomCatalog`：40 action atoms + 3 capability atoms；相关既有原子 `MANAGE_AGENT_PRINCIPALS` / `MANAGE_WORKSPACE_AGENTS` / `MANAGE_SKILL_LIBRARY` / `SPAWN_AGENT`（workspace-executable，2026-11-04 裁定）/ `CREATE_OWN_AGENT`；agent 禁持集 `AGENT_FORBIDDEN_ATOMS` | cp/policy/PermissionAtomCatalog.java 全文件 |
| UI 基建 | settings 两层模型（instance/user）、workspace 设置 5 tab（general\|mcp\|members\|credentials\|knowledge）、shadcn-vue vendor 34 族 187 文件、reka-ui 原语、委派投影（会话树 kind=SPAWN + spawnedFromSessionId、delegation-usage 预算/深度） | xh-settings-ui-design SKILL §1-2；DEV-017 §1 委派投影 |
| Agent 编排 | 星型结构 CP 居中：Agent 无状态、只经 CP 端点；Agent 包当前**无 subagent 概念**（grep 0 命中） | DEV-013 §2.1/§3；agent 包 grep |

### 1.2 真正的新增清单

1. `team_tasks` 共享任务板（数据 + 工具 + 只读 UI）——DSH agent team 面核心件，XH 全仓无对应物 [实测源码·grep]。
2. Lead→teammate 中途指挥消息（steer）——既有投递是 child→parent 单向终态通知；parent→child 在途插话无通道 [推导·基于 DEV-017 全景]。
3. 三面各自的 UI 配置/投影面（主体详情编辑、skill 绑定管理、TeamBoard 面板）。
4. 配套 Flyway 迁移、OpenAPI/inventory、AgentEvent/SSE 登记、agent 工具注册（按 xc-cross-cutting-checklist）。

## 2. 面①：agent 主体（principal）模型

### 2.1 膨胀门：能否用既有概念表达？

能。DSH 的「profile」是**进程级配置 bundle**（launcher flags + patch 层）[DSH 对照·task-183 §5]；XH 的对应物早已是 **CP DB 持久资产** `agent_principals`（跨 session、跨 workspace 可绑，PLAN-0374 完整授权链）[实测源码]。引入「profile」层属于自造机制，被否决。锚③「身份/模型/persona/能力 可配置」逐项对位：

| 锚③要求 | 既有载体 | 缺口 |
|---|---|---|
| 身份 | `name` + `ownership`(USER\|INSTANCE) + `origin`(USER\|SYSTEM_PRESET) | 无（创建两扇门已分） |
| 模型 | `default_model_provider/default_model_name` + `allowed_models`（null=不限） | **UI 编辑面缺**；wire 暴露完整性待实施期核对 [推导] |
| persona | `template_id/template_snapshot`（context-template 钉住 + systemPrompt，PLAN-0414/0416） | **选择/切换模板的 UI 缺** |
| 能力 | grants 经 `/{id}/roles` 绑定 ∩ `workspace_agents` cap ∩ session snapshot 三段收口 | **grants 编辑 UI 缺**（API 已在） |

### 2.2 数据模型

**不改表，只补 UI 投影 + wire 核对**。保守默认：**【待用户醒后追认】** 维持「主体=CP DB durable 资产」，不加 persona 独立表（persona 即 template snapshot，已有 context-templates 域），不加模型连接（principal 只表达 provider+model 意图，凭证运行时解析——DEV-013 既定边界）。

### 2.3 CP API 面

全部已存在（openapi.yaml:878-1021, 5160-）。实施期只需：核对 `defaultModelProvider/allowedModels/delegationPolicy` 是否已出 wire（Jackson-2 节点禁出 wire，PLAN-0633 C1），缺则按既有 PATCH 面补字段——属**收口而非新面**。

### 2.4 UI 投影

- 落点：workspace settings 的 agents 管理面（既有「Workspace Agent 管理 API」消费者位）+ 主体详情抽屉。遵守 xh-settings-ui-design 五硬判据（H1 字段集只来自 CP schema、H3 内容列 1152px、H5 字段级编辑闭环六件套）。
- 字段分组：身份（name/ownership 只读徽标）/ 模型（provider+model 选择器 + allowed_models 列表编辑）/ persona（template 选择与版本快照展示）/ 能力（grants 列表 + cap 交集预览，只读 + 跳转 roles API）。
- 组件：栈内 vendor（Select/Combobox/Badge/Dialog），禁手搓。

### 2.5 备选与代价

| 取舍 | 备选 | 代价 | 保守默认 |
|---|---|---|---|
| 主体形态 | A. CP DB durable（现状） | 无新增 | **A【待追认】** |
|  | B. 引入 DSH 式 profile 配置层 | 新增一层抽象 + 与 CP DB 双真相源 | 否决（膨胀门） |
| persona 载体 | A. template_snapshot（现状） | persona 修改不回溯既有 snapshot（既定语义） | **A【待追认】** |
|  | B. principal 级独立 persona 字段 | 与 context-template 体系分叉 | 否决 |

## 3. 面②：skill 绑定

### 3.1 膨胀门

绑定关系已落 CP DB（`skill_bindings`），求值已分层（CP 定列表 → admission 冻结快照 → Agent 按预算渲染）[实测源码]。锚④「哪个主体可用哪些 skill」的答案已经存在；缺口是 **UI 管理面**与**求值语义的文档化确认**。不新增表、不新增求值层。

### 3.2 数据模型与求值（确认既有语义）

- 绑定四档：`user×instance` / `user×workspace` / `agent_principal×instance` / `agent_principal×workspace`；「全员共享」第五档 v1 不做（CHECK 拒绝，SkillBinding.java 类注释）[实测源码]。
- 每 Run 求值：`SkillCatalogSourceService` 按 AGENT→USER、workspace→instance 优先级去重，`maxSkills`（默认 40，上限 200）截断**必带诊断**（empty/truncated/collision/resolve_failed）[实测源码]。admission 事务内冻结 `chat_runs.skills_snapshot`，在途 Run 不受后续绑定变更影响 [实测源码]。
- 「绑定 .agents/skills」的两层含义要分清：skill **定义**进库（`SkillImportService`，库 + 导入面已有）→ 绑定是定义（`skill_id`）× 主体 × 作用域的三元关系。**D-1815 锚④ = 后者，已成立**；若用户还想要「从 workspace .agents/skills 目录导入」的产品化入口，那是 SkillImportService 的 UI 壳，S 期一并补 [推导]。

### 3.3 CP API 面

已存在：`GET/POST /api/v1/skill-bindings`、`DELETE /{id}`、`GET/POST/DELETE /api/v1/agent-principals/{id}/skills`（openapi.yaml:5796/5813/795/859）[实测源码]。授权走既有原子 `MANAGE_SKILL_LIBRARY` + 双轴写入面（PLAN-0680：workspace 轴仅授本工作区原子、服务端定档）[实测源码·spec amendment 行]。

### 3.4 UI 投影

- 主体详情内 skills 段：已绑定列表（名称 + 来源 tier 徽标 + scope）+ 添加（从库选 skill × 选 scope）+ 删除。
- workspace 级视图：skill 库列表（导入入口）+ 各绑定统计。
- 只读呈现 per-run 生效集：ChatRun 详情可展示 `skillsSnapshot`（`SkillSnapshotView` 已出 wire，ChatRunReadService.java:112）[实测源码]。

### 3.5 备选与代价

| 取舍 | 备选 | 代价 | 保守默认 |
|---|---|---|---|
| 绑定粒度 | A. 维持 2×2 双轴 + admission 冻结 | 运行中改绑定不即时生效（快照语义，与 context-template 同） | **A【待追认】** |
|  | B. 新增 per-session/per-run 覆盖档 | 破坏既有 2×2 CHECK 与冻结不变式 | 否决（S 期） |
| 绑定求值层 | A. CP 求值 + 快照冻结（现状） | — | **A【待追认】** |
|  | B. Agent 运行时动态求值 | 破坏在途不变式 + 双真相源 | 否决 |
| .agents/skills 导入 | A. SkillImportService UI 壳（S 期纳入） | 需定义导入冲突语义 | **A【待追认】** |
|  | B. 不做导入 UI，只 CP API | 用户无入口 | 备选 |

## 4. 面③：会话指挥通信

### 4.1 总体形态（DSH 同构）

- **Team 隐式**：TeamId = 根 Session id（无独立实体）[DSH 对照·task-183 §2.1]。XH 对应：根 Session + `kind=spawn` 子 Session 树（既有列已够表达，不加列）[推导]。
- **teammate = 独立 ChatRun/Session**（与 DSH teammate=独立 subagent session 同构）：`spawn_agent` 已建 child Session + 独立上下文 + 独立授权根 [实测源码]。**不自造 LangGraph 内多 agent 编排**（膨胀门：agent 包无 subagent 概念；图内多 agent 会使授权/审计/会话资产全部新建，被否决）。
- **任务板 + 指挥消息 + 状态投影**三件，逐件设计如下。

### 4.2 数据模型：`team_tasks`（唯一新表）

```sql
CREATE TABLE team_tasks (
  id            uuid PRIMARY KEY,
  team_root_session_id uuid NOT NULL REFERENCES sessions(id),  -- Team = 根 Session，隐式
  task_no       int  NOT NULL,                                  -- 组内单调编号，surfaced as "task-<n>"
  revision      int  NOT NULL DEFAULT 1,                        -- CAS 身份，每次持久变更 +1
  subject       text NOT NULL CHECK (char_length(subject) <= 200),
  description   text CHECK (description IS NULL OR char_length(description) <= 16384),
  status        text NOT NULL CHECK (status IN ('pending','in_progress','completed','deleted')),
  owner_session_id  uuid REFERENCES sessions(id),               -- teammate 会话；NULL = unowned
  owner_name        text,
  blocked_by    jsonb NOT NULL DEFAULT '[]'::jsonb,             -- uuid[] 依赖任务 id
  write_scopes  jsonb NOT NULL DEFAULT '[]'::jsonb,             -- text[] workspace 相对路径前缀
  created_by_session_id uuid NOT NULL REFERENCES sessions(id),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  UNIQUE (team_root_session_id, task_no)
);
```

设计要点（照抄 DSH 成熟形态，全部 [DSH 对照·task-183 §2.1]）：
- **全量快照行 + 行级 CAS**：八动作 `claim/release/edit/set_dependencies/complete/reopen/reassign/delete` 统一走 `UPDATE ... WHERE id=? AND revision=?`，0 行 ⇒ 409 `TEAM_TASK_REVISION_CONFLICT`（对齐 DSH 错误码词汇 + RFC 9457）。
- `deleted` 是墓碑不物理删；有未删依赖者禁删（409 `TEAM_TASK_HAS_DEPENDENTS`）。
- `ready` 是纯派生：`pending && blockedBy 全 completed`（不落列）。
- `set_dependencies` 同事务做依赖图无环校验（DSH task-graph assertTaskGraphCandidate）。
- `write_scopes` 校验照抄 DSH validation：禁绝对路径/盘符/`..`，统一斜杠去尾斜杠；**advisory-only**——仅与**其它 in_progress 任务**前缀重叠产 warning（`write scopes overlap with task-x`），不锁文件不拒写。XH runtime 沙盒协同升级留 L 期。
- **Lead 判定 = 关系判定不是角色特判**：当前调用者 session 的 spawn 祖先链（`spawned_from_session_id` 递归 + `chat_runs.parent_run_id`，`DelegationChainWalker` 现成）为空 ⇒ 是 Lead。reassign 仅 Lead，且目标必须是本树 continuable descendant（XH：本树 child session）。**禁 `isInstanceAdmin` 式角色名特判**（workspace 规则）；claim/reassign/lead-check 的命中来源写 audit。
- **默认授予集**：board 读写原子（建议名 `TEAM_TASK_MANAGE`，scope_class=both）默认授予 agent principal（workspace 绑定内）+ 会话 human owner；agent 禁持集不加它（它是 workspace 域动作，遵循 MANAGE_SKILL_LIBRARY 的 N5-N9 论证先例，PermissionAtomCatalog.java 类注释）。**【待用户醒后追认】** 原子命名与默认集。

### 4.3 CP API 面

任务板 HTTP 面（给 UI 读；写主路径是 agent 工具，见 4.5）：

```http
GET /api/v1/sessions/{sessionId}/team-tasks           # 投影列表（含 ready 派生 + writeScopeWarnings）
GET /api/v1/sessions/{sessionId}/team-tasks/{taskId}  # 单卡详情
```

写路径不暴露独立 UI mutation（DSH「面板纯只读、单一写路径」取舍照抄；M 期若 Lead 要 UI 可写，复用同一 CAS 服务，不开第二条写通道）[DSH 对照·task-183 §3.5]。

steer 通道（Lead→teammate 中途指挥消息）：

```http
POST /api/v1/sessions/{childSessionId}/steers
Content-Type: application/json

{ "text": "<指挥内容>", "expectedRevision": 0 }  -- expectedRevision 可选，防陈旧插话
```

steer 落点**复用既有 follow-up 队列**（V49）：作为一条 durable item 进 `session_follow_up_items`，child run 在途则排队、终态后由既有 settlement 自动 admission——**零新队列机制、零新 admission 语义** [推导·复用 V49]。item 需要标注来源：新可空列（或 payload 字段）`source_kind`（`human`/`agent_steer`）+ `from_session_id`，让 child 侧渲染「来自 Lead 的指挥」并做归因审计。授权：调用者必须是 child 所在树的祖先 session 的持有者（Lead）或 human owner；agent 自发 steer 走工具面（4.5）。

**通信任 CP 还是经 agent 的取舍**：保守默认 = **CP 居中**（星型结构既有裁决，DEV-013 调用链全局结构）：steer/投递/队列全在 CP durable，Agent 无状态经 relay；不经 agent 直传、不经 runtime。**【待用户醒后追认】**。

### 4.4 UI 投影

- **TeamBoard（只读面板）**：落 ChatPanel 头部区（会话内嵌组件，遵守 ai-chat-ui-design 流式区约定）。行 = 状态点（pending 灰 / blocked 警告 / in_progress 进行 / completed 勾，照 DSH 映射）+ subject + owner 名 + 展开 description；头部 = completed/active/pending 计数（纯前端派生）+ projection failure 横幅。组件：栈内 vendor Collapsible/Accordion + Badge + Tooltip + ScrollArea，**禁手搓**。
- **状态投影**：成员树/委派 DAG **不新建投影**——复用 PLAN-0655/0659 既有投影（`kind=SPAWN` + `spawnedFromSessionId`、derived-state、delegation-usage 预算/深度）[实测源码·DEV-017 §1 委派投影行]。SSE 沿用 `derived_state_changed` hint + 重读 derived-state 的既有口径。
- **指挥消息 UI**：child session 视图内标注 steer 来源（「来自 Lead」徽标 + 源 session 跳转）；Lead 侧在会话树节点上出「插话」入口（Composer 复用）。
- **计数带量词与图例**：遵守 settings 判据 H4 精神（聊天面内同样执行）。

### 4.5 Agent 工具面（写路径）

四个工具对齐 DSH 词汇，Python 侧注册进既有 tool registry，经 CP logical MCP 通道（与 spawn_agent 同模式，Agent 不直调 CP 内部面）[推导·沿用 PLAN-0407 T2.10 模式]：

```text
team_task_create(subject, description?, blocked_by?, write_scopes?)
team_task_list()                     -- isConcurrencySafe：只读不 append
team_task_get(task_id)
team_task_update(task_id, expected_revision, action, ...)   -- 八动作 CAS
```

`send_message`（agent 自发指挥）S 期不做，M 期补：工具入口 → 同一 CP steer API（4.3），不建新通道。**【待用户醒后追认】** S 期指挥入口仅 UI/CP 是否可接受。

### 4.6 备选与代价

| 取舍 | 备选 | 代价 | 保守默认 |
|---|---|---|---|
| 任务板持久化 | A. CP DB 新表 | 与 XH 跨会话资产惯例一致（decision 面同理）；DSH 的 session-log 形态在 XH 无通用投影消费面 | **A【待追认】** |
|  | B. 存 Lead session event log（DSH 原样） | XH EventStore 是 context 域不是通用投影；需新建折叠/读模型全套 | 否决 |
| 指挥消息载体 | A. 复用 follow-up 队列 + source 标注 | item 表加可空列；语义完全复用 | **A【待追认】** |
|  | B. 新 `session_steers` 表 + 独立 admission | 第二套队列/结算语义 | 否决（S 期） |
|  | C. DSH inbox 投递（deliverToMember 同构） | XH 无 inbox 概念，需新建 | 留 M 期再评 |
| UI 可写卡 | A. 只读起步（DSH 取舍） | 人 claim/complete 要在对话里 @agent | **A【待追认】** |
|  | B. 同 CAS RPC 开放 UI 写 | 多一条调用入口，需同批授权审计 | M 期备选 |

## 5. 跨协议契约清单（xc-cross-cutting-checklist 落点，实施期执行）

- **Flyway**：`team_tasks` + `session_follow_up_items` 加列，迁移号按合并时刻 develop 最大号 +1（禁止预留号）；开发期数据可清库重建（D-215）。
- **OpenAPI/inventory**：4.3 全部新路由同步 `openapi.yaml` + `inventory.md`；RouteContractParityTest 两侧 unexpected=0。
- **SSE/AgentEvent**：steer admission 与 team task 变更是否推 SSE——保守：**不新增事件类型**，复用 `derived_state_changed` hint + 重读投影（低频写，面板读投影即可）。【待追认】若要求实时刷新，登记新事件进 `spec/protocol/event-stream.md` ownership 表（producer=CP，consumer=UI）。
- **UI store**：team tasks 投影挂 chat/session store 既有 SSE 刷新模式，不建并行机制。
- **env**：本设计新增 0 个 `XIHE_*` 变量（无进程级配置面）。
- **错误码**：`TEAM_TASK_REVISION_CONFLICT` / `TEAM_TASK_ALREADY_CLAIMED` / `TEAM_TASK_HAS_DEPENDENTS` / `STEER_FORBIDDEN`（命名沿 DSH 词汇 + CP code 风格，最终形状以 OpenAPI 为准）。[推导]
- **测试**：CP 侧 CAS/授权矩阵/无环校验单测 + H2；UI mock 矩阵 + real 单 spec（L0）；agent 工具契约测试沿既有 tool registry 模式。

## 6. 分阶段实施建议

| 阶段 | 内容 | 依赖 | 先行度 |
|---|---|---|---|
| **S1（纯 UI，可立即开工）** | 主体详情设置页（模型/persona/grants 投影编辑）+ skill 绑定管理 UI + per-run skillsSnapshot 展示 | 零（API 全在） | **最高：先做** |
| **S2（任务板）** | `team_tasks` Flyway + CAS 服务 + 授权矩阵 + 四工具（agent 侧）+ TeamBoard 只读面板 + OpenAPI/inventory/契约测试 | 与 S1 并行；依赖 Flyway 定号三查 | 高 |
| **S3（指挥通道）** | steer API + follow-up item 加 source 列 + admission 复用 + Lead/child 两侧 UI + 归因审计 | S2（先板后指挥，命令有处挂） | 中 |
| **M** | `send_message` agent 工具（同 steer API）+ UI 可写卡（若追认）+ 行内筛选/进度统计增强 | S3 | — |
| **L** | fork（上下文继承，PLAN-0409 复用）+ 写面 advisory→runtime 沙盒协同 + 跨 session 团队 | 独立 | — |

关键路径：S1 无阻塞可先行；S2/S3 是锚⑤主体，建议在 S1 收尾后集中做（同一波次契约变更少）。

## 7. 待裁取舍清单（全部保守默认，【待用户醒后追认】）

1. **主体形态** = CP DB durable 资产（非 DSH profile 进程配置）。
2. **skill 绑定粒度** = 维持 2×2 双轴 + admission 冻结快照，不新增 per-session/per-run 档。
3. **会话通信任 CP 居中**：steer 复用 follow-up 队列；agent 工具 `send_message` 推迟到 M 期；S 期指挥入口仅 UI/CP。
4. **任务板落 CP DB**（非 session event log）。
5. **reassign Lead-only 用 lineage 关系判定**（禁角色名特判）；新原子建议名 `TEAM_TASK_MANAGE`（both scope），默认授予集与命中来源审计同批。
6. **面板只读起步**（单一写路径 = agent 工具）。
7. **Team 隐式**（TeamId=根 Session id），不建成员实体表。
8. **不新增 SSE 事件类型**（复用 derived_state_changed hint）。
9. **.agents/skills 导入 UI 壳**是否纳入 S1（SkillImportService 已在，只差 UI 与冲突语义）。

## 8. 证据索引

| 断言 | 位置 | 等级 |
|---|---|---|
| agent_principals 字段全集（模型/persona/能力/ownership） | packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/entity/AgentPrincipal.java | [实测源码] |
| 主体/skill/roles/memories API 面 | docs/api/openapi.yaml:512/701/795/878/964/1007/5160/5796/5813 | [实测源码] |
| 三段授权与绑定式 scope | spec/agent/principal-workspace-binding.md | [实测源码] |
| skill_bindings 2×2 双轴与唯一键 | packages/control-plane/.../cp/skill/SkillBinding.java | [实测源码] |
| per-run skill 求值 + admission 冻结 | cp/skill/SkillCatalogSourceService.java:36-100；entity/ChatRun.java:97；packages/agent/src/xihe_agent/api/chat.py:719-746 | [实测源码] |
| skill 库/导入/访问守卫 | cp/skill/SkillLibraryService.java:30；SkillController.java:32 | [实测源码] |
| spawn_agent / spawn lineage / 委派预算 | DEV-017 §1；openapi.yaml:1532/5087；AgentPrincipal.delegationPolicy | [实测源码] |
| child→parent 终态投递与 derived-state | DEV-017 §1；openapi.yaml:1518/2736 | [实测源码] |
| follow-up 队列语义 | DEV-017 §1.3；openapi.yaml:1303-1349 | [实测源码] |
| 能力原子词表与 agent 禁持集 | cp/policy/PermissionAtomCatalog.java | [实测源码] |
| Agent 包无 subagent 概念 | packages/agent/src grep 0 命中 | [实测源码] |
| DSH team task 8 动作 CAS / advisory scopes / Team 隐式 / 面板只读 | task-183 文档 §2/§3（dsh-agent-team 包 file:line 表） | [DSH 对照] |
| steer 复用 V49 队列的可行性 | 由 V49 语义推导（item 为唯一事实源、settlement 自动接续） | [推导] |
| model/persona/grants 字段的 wire 暴露完整性 | 未逐字段核对 OpenAPI 请求/响应 schema | [推导·待实施期核对] |
