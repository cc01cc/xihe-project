# XH 授权模型

> 契约状态：`proposed`；实现状态：`implemented`（PLAN-0610，2026-11-01）；Profile：`security`；Owner：Security/CP；来源：PLAN-0386；PLAN-0407 T2.8 / PLAN-0610 写回；更新：2026-11-22（拆分 grant scope / visibility scope 术语，补资源命名空间、fs/phys 双轨与 `credential:*` 契约；同批新增 §2.2 条件、§2.3 审批、§2.4 上下文、§2.5 MVP 目标态十步链，判据本体见 `../docs/i18n/zh-Hans/DEV-037-authorization-model.md`）。
> 消费者：CP 授权/policy、Workspace API、MCP 工具调用门、UI 授权结果
>
> **supersede**：本文取代 PLAN-0580 §4「实例角色只有两种、MUST NOT 引入第三角色」与 PLAN-0585「grant 写入只有唯一受审计管理面 `/api/v1/principal-grants`」。二者均随 PLAN-0610 退役。

## 1. 决策输入

授权判据是 **`actionClass × resource` 两轴**，加上**主体派生链逐级持有**；`grant scope`（`AccessScope`，`instance` / `workspace`）只限定候选 grant 集与写入期可绑定性，**不是第三匹配维度**。另有 `principal`、**访问角色绑定**（角色 × 主体 × grant scope）、**能力原子**、workspace membership、approval 策略与 revision 等输入。

术语约定：`grant scope` 与 `visibility scope` 必须分开写。前者是 `AccessScope`（`instance` / `workspace`），后者是组织树 ltree 的 `OrgUnitAccess.Scope`（conditions / context，回答「能看见哪些组织单元」）；**禁止**裸用「scope / 作用域」。判据本体与九族成熟模型对比见 `../docs/i18n/zh-Hans/DEV-037-authorization-model.md`。

## 2. 当前评估链

1. 认证：校验签名与 epoch `tv`（§6），建立主体上下文；
2. **grant scope 解析**：请求被解析为 `instance` 或 `workspace:<id>`（不信任请求参数）；该值只用于候选集分区与写入期可绑定性，不进入 `(actionClass, resource)` 匹配；
3. **能力解析**：实例级 grant scope 绑定 → `cap:instance:super` / `cap:instance:admin`；工作区级 grant scope → `cap:workspace:admin`（按 workspace 判定，不进入全局 authority）；
4. Tool face / action class；
5. built-in hard guard（L0，任何模式/规则不可覆盖）；
6. **带 grant scope 的 grants 一跳查表**：主体 `source ∈ {assigned, spawn, template, credential_binding, agent_default, plugin_binding}` 且 `(scope_type='instance' OR (scope_type='workspace' AND scope_id=当前 ws))` 的原子并集 并按 `(actionClass × resource)` 逐对求值，**主体派生链每一级都必须持有该原子，任一级缺即拒**（path intersection；`policy/GrantIntersectionEvaluator.java:97` 的 javadoc 与 `:103-120` 三重循环一致）；命中 → 过，未命中 → deny（制度拒，**不进入 approval、不建 pending approval**）。其中 `assigned` = 一次**预设导入**的结果（V186 起取代 `preset`），导入后主体可独立微调；`preset` 自 V186 起**只保留在 provenance 词表**（历史行可解释），**不再参与判定**——改预设内容不会改变已导入主体的权限（R39 / D-1926）。另有**写入期**前置上限：绑定 cap 必须 ⊆ 主体已持原子且 ⊆ 操作者已持原子，越界 403 `AGENT_PERMISSION_SCOPE_EXCEEDED`（`service/AgentPrincipalService.java:539-563`）——这是落库前的边界校验，**不是读期语义**；判据本体见 `../docs/i18n/zh-Hans/DEV-037-authorization-model.md` §4；
    - **唯一的显式例外：会话级临时能力令牌（task-124 / DSD-1509 ②）**。它**不是第六个求值层**，只是在「本会话 + 本 leaf 主体 + 行未撤销未过期」的条件下，对行里列出的那些 `(actionClass, resource)` **替代各级持有判断**；未列出的动作类仍按上面逐级求交，资源前缀语义照旧。活跃性是 SQL 谓词（无定时任务、无缓存），写面要「会话创建者 + `session:permission:configure` + 原子子集」，生命周期随 `sessions` 级联。机制与判据见 `../docs/i18n/zh-Hans/DEV-037-authorization-model.md` §11；
7. **approval-policy `askActionClasses[]`**：在册且 `mode=manual` → `ASK`；`mode=auto` → 放行并记 `allowed_by`；不在册 → 授权过后直过；
8. audit：grant 决策与 `allowed_by` 记录。

本节是**当前**评估链；MVP 目标态的十步求值链（新增条件、审批权改判据）见 §2.5。

### 2.1 资源命名空间契约

- 资源串 **MUST** 采用「命名空间 + 值」形态；命名空间来自单一注册表。**未登记前缀出现在 grant 资源里 MUST fail-closed**。
- 当前资源族：`fs:<workspaceId>[/<rel>]`、`credential:*` / `credential:<uuid>`、`skill:*` / `skill:<uuid>`、`mcp:*` / `mcp:<canonicalServerId>`，以及裸路径 / URL / `*`；`phys:` 是求值键，不是可写资源族。
- **`mcp:` 是通道闸，不是被作用对象（task-870 / D-1921）**：经外部 MCP 网关的工具调用 **MUST** 在 `PolicyRequest.resources` **追加** `mcp:<canonicalServerId>`，与工具参数派生的对象资源**同时**求值（`(actionClass × 对象资源) AND (actionClass × mcp:<sid>)`），**MUST NOT** 用 `mcp:` 替换对象资源（替换会让 `write × mcp:server` 覆盖该 server 上任意对象，是放宽）。`*` 与路径通配 **MUST NOT** 覆盖 `mcp:`——否则任何持有 `write@*` 的预设（包括所有 agent 预设）都会静默穿过通道闸；只有 `mcp:*` / `mcp:<id>` 能覆盖 `mcp:<id>`。`mcp:` 的 canonical 形态为「UUID 优先；非 UUID 取稳定小写 slug，损失性归一化带 8 位 hash 后缀」；写面拒绝非 canonical 值并给出建议形态。
- **`mcp:` 只按 catalog 行正向枚举**：只有能解析到 `mcp_remote_servers`（UUID）或 `mcp_stdio_servers`（name）一行的 serverId 才追加；CP 自有网关 id（`__system__` / `__cp__`）没有 catalog 行，结构上天然不追加（内置 `write_file` / `read_file` 不受通道闸影响）。写面 **MUST** 拒绝 `__` 前缀的 server 名（否则持 `MANAGE_WORKSPACE_MCP` 者可注册一个叫 `__system__` 的 server 来继承内置排除）。默认集：`mcp:*` 只授予 `SUPER_ADMIN` / `ADMIN` / `WS_OWNER`；agent 预设不含通配，按 server 显式授权（升级后未显式授权的 agent 对 MCP 全拒，fail-closed）。
- 命名空间 **MUST NOT** 使用 `workspace:` 或 `session:`：二者是 context（workspace 由 grant scope 表达，session 是会话容器），不是对象身份。注意能力原子 `workspace:admin` 与 action atom `session:permission:configure` 是原子名，不是资源命名空间。
- **`fs:` / `phys:` 双轨**：授权 **MUST** 只书写 `fs:<声明键>`；`phys:` 只在求值期由声明键展开，**MUST NOT 落入 grants 表、MUST NOT 接受 API 提交**。提交 `phys:` grant **MUST** 返回 `400 INVALID_GRANT_RESOURCE`。理由是物理键是宿主绝对路径，换机器 / 容器 / 恢复备份都会变，写进长期授权会把权限绑死在某台机器上。求值期两侧都是 `fs:` 时 **MUST** 展开成 `phys:` 比物理身份，**MUST NOT** 回退成字符串比较。
- **`credential:*` 语义**：`credential:*` 只用于凭证**管理面**（`credential_manage` 等原子的 canonical resource），**MUST NOT** 被解释成「可使用全部凭证」的授权。使用请求 **MUST** 携带具体 `credential:<uuid>`；**判定请求的 resource** 为 `credential:*` 且 actionClass 为 `credential_use` 时 **MUST** 拒绝（`policy/ToolFaceRegistry.java:423-445`、`policy/PolicyRequest.java:28-37`）；grant 侧的宽行只是 ceiling 写法，**MUST NOT** 让请求跳过具体 uuid。
- **组织树**：`OrgUnitAccess.Scope`（ltree 路径）永久留在 conditions / visibility scope 面，**MUST NOT** 进入资源轴。资源注册表 **MAY** 预留 `tree` matcher 类型，但当前 **MUST NOT** 注册 `org:` 命名空间。理由：组织树回答「能看见哪些数据」，不是「能对哪个对象做哪个动作」；进资源轴会同时破坏 404 语义与「读取面按 ltree `<@` 过滤」的查询范围语义。将来确实要把某个单元当授权对象时，只加一行注册（`org:` + `tree` matcher + canonicalizer），不改表、不改解析器、不改求值器。

- **`agent-unit:` 是求值期派生的层级键，不是 `org:`（task-935 / D-1935）**：委派层级判据需要「这次 spawn 的目标是否落在调用方自己的单元子树内」，它注册为**独立命名空间** `agent-unit:`（`Matcher.TREE` + `Grantability.EVALUATION_ONLY`），值形如 `agent-unit:root/team`，由 `org_unit_members` 在求值时派生，**MUST NOT** 写入 `grants` 表、**MUST NOT** 接受 API 提交（与 `phys:` 同型）。`org:` 仍按上一条 **MUST NOT** 注册：两者并列不是笔误 —— `org:` 回答「能看见哪些单元」（visibility scope），`agent-unit:` 回答「能在哪个单元内派生」（action × resource）。层级判据 **MUST** 只经 `PolicyRequest.resources` 追加（`PolicyEngine.allowsByGrant` 的 `additionalResources` 形参，只追加不替换）进入求值，**MUST NOT** 另写 `if (isDescendant)` 之类旁路判断。`tree` matcher 按 `/` 分段覆盖后代，故 `agent-unit:root/team` 覆盖 `agent-unit:root/team/child`、不覆盖 `agent-unit:root/other`。

- **分身由动作原子 `action:clone` 控制（task-935）**：Agent 预设默认含、人类预设默认不含（人类账户不允许分身，智能体允许）。同一主会话内复用已有子实例 **MUST NOT** 要求 `clone`；只有派生第 2 个实例才要求。`spawn_agent` 未显式指定目标时语义即「分身」，因此自 spawn 路径 **MUST** 求值 `action:clone × agent-unit:<调用方子树>`。

**新增资源类别 playbook**：注册表加一行（namespace + matcher + canonicalizer）→ 提取器加一个 key → 校验器接受该前缀 → 单测 / golden 加用例 → 文档登记一行。**MUST NOT** 因此改表、改求值器或做迁移；真正的成本在确定 canonical 形态（什么算同一个资源），不在代码。

### 2.2 条件（condition）契约

条件是**授权之外的额外限制**，挂在 policy 层、与 grant 分开存，判定时读请求上下文里的字段。它**只能收窄，不能放宽**：条件永不授予权限，也不参与 `(actionClass, resource)` 匹配。

**MVP 底线（task-863 已实现）**：本阶段只实现两条 fail-closed 规则，五算子尚未实现。

- **未登记的条件 key ⇒ deny**：条件 key 必须来自单一注册表（`policy/condition/ConditionKeys.java`）。不在表中的 key（含 null、空白、大小写或空格不符）使承载该条件的 grant 行**不成立**；**MUST NOT** 忽略未知 key 或按通过处理。
- **缺字段 ⇒ 算不满足**：条件声明的上下文字段在请求上下文里不存在或为空时，该条件判为不满足 ⇒ 收窄失败 ⇒ deny。
- 两条规则按上述先后判定：混合条件集里「未登记 key」优先——它是配置错误，而「缺字段」可能是合法运行态。
- 条件按 grant 行（grant id）挂载，**MUST NOT** 写进 grant 的权限原子；同一原子的另一行无条件授予时，原子仍成立（并集语义）。条件载体当前为独立于 `grants` 表的结构；持久化表随算子一并落，**MUST NOT** 为此给 `grants` 增加条件列。
- 拒绝原因 **MUST** 可解释：`condition-key-unregistered` / `condition-field-missing` 作为 reason 码进 explain 的 `missingLevels`，并带层级索引（§2.5 第 7 步）。

**MVP 之后（未实现）**：值比较算子。

- 算子集 **MUST** 封闭为五种：`eq` / `neq` / `in` / `exists` / 时间窗（`before`–`after`）。**MUST NOT** 支持自定义算子或表达式语言。算子落地之前，条件形状只有 key（无算子、无值），因此底线的「满足」只代表「key 已登记且字段存在」，**不代表值已比较**。
- 改条件 **MUST NOT** 需要重发授权：条件与 grant 是两份数据，撤销条件不影响 grants 行。
- 端点级可见性检查（如组织树的「非成员得到 404」）**MUST NOT** 称为 condition，归 visibility guard，与本节判据分开实现。`in_subtree` 因此不属于算子集：树形包含是可见性语义，不是授权语义。

### 2.3 审批（approval）契约

审批是**风险模态**，不是权限集合的一员：它不授予任何权限，只决定「这次要不要先点头」。审批的请求身份、状态机、复用等级与重启对齐由 `approval.md` 承接，本节只定授权侧判据。

- 批准权 **MUST** 由权限判定，判据是 `(action:approve, 本次请求的 resource)` 同时命中；**MUST NOT** 用「是不是会话发起人」「是不是人类账户」这类硬编码分支决定。批准者可以是人类账户，也可以是持有该原子的 Agent。批准者资格的四条硬不变式见 `approval.md` §3.1。
  - `action:approve` 目前**不在内置动作原子目录内**（`policy/PermissionAtomCatalog.java:18` 指向 `ToolFaceRegistry#builtinActionClasses()`），属本契约要求新增的原子；其默认授予集与种子随预设重设计一并落。
- 当前 ASK 只按动作类命中（`policy/PolicyEngine.java:187-200` 的 `askActionClasses[]`），**MUST** 收窄为「动作类 + 资源」双条件，避免 `write` 一次入册就对所有路径要求审批。
- `ASK` **MUST NOT** 出现在授权求值失败的路径上：制度拒（缺原子）不建 pending approval，见 §2 第 6 步。

### 2.4 上下文（context）

工作区、组织单元、会话是**上下文**，回答「这次请求发生在哪儿」，不参与 `(actionClass, resource)` 匹配。其中实例与工作区由 grant scope 表达（§1），组织单元由 visibility scope 表达（§2.1），会话是容器身份。上下文 **MAY** 被 §2.2 的条件读取，但 **MUST NOT** 被当作第三匹配轴。

### 2.5 MVP 目标态十步链（proposed）

顺序与 DEV-037 §3 的求值链逐步对应，只多一步「条件」（第 7 步）。与 §2 的差异只有第 7–8 步（新增条件、审批权改判据），其余步骤是既有环节的重新表述。**MUST NOT** 把本节当作已实现事实引用——未实现项在最后一列点名。

| # | 步骤 | 判据 | 对应小节 | 实现状态 |
|---|---|---|---|---|
| 1 | 登录还有效吗 | 签名 + epoch `tv`，过期即按未认证处理 | §6 | 已实现（§2 第 1 步） |
| 2 | 这次请求发生在哪儿 | grant scope 派生：实例或工作区，由服务端解析、不信任请求参数 | §1、§2 第 2 步 | 已实现 |
| 3 | 是不是管理面 | 能力原子只判当前主体的持有情况，**MUST NOT** 逐级求交 | §2 第 3 步 | 已实现 |
| 4 | 要做什么、对什么做 | 工具面映射成 actionClass，配资源串解析 | §2 第 4 步、§2.1 | 已实现 |
| 5 | 硬闸 | built-in hard guard，先于一切授权，任何模式/规则不可覆盖 | §2 第 5 步 | 已实现 |
| 6 | 动作与资源同时命中 | `(actionClass × resource)` **唯一匹配点**，链上每级都持有，任一级缺即拒 | §2 第 6 步 | 已实现（三源快照未去重，见 task-834） |
| 7 | 条件 | §2.2 只收窄不放宽 | §2.2 | **部分**：fail-closed 两条底线已实现（task-863：未登记 key⇒deny、缺字段⇒不满足、拒绝带 reason 码 + 层级）；五算子未实现 |
| 8 | 审批 | 批准权走 `(action:approve, resource)` | §2.3、`approval.md` §3.1 | **部分**：ASK 只按动作类；批准者仍硬编码 run 属主；`action:approve` 原子不存在 |
| 9 | 执行 | 执行期不再判权限 | §2 第 8 步 | 已实现 |
| 10 | 记录 | 拒绝原因可解释 | §2 第 8 步、DEV-037 §10 explain | 部分：explain 已落，求值失败仍只有 WARN |

- 第 6 步是唯一做匹配的地方；第 3、5、7、8 步只加闸、加条件或加确认，**MUST NOT** 把已拒绝的调用改回放行。
- 三种结果的合成固定为拒绝优先、其次确认：任一处拒绝 → `DENY`；未拒绝但需审批 → `ASK`；全部通过 → `ALLOW`。

## 3. 模型

| 对象 | 语义 |
|---|---|
| `roles` | 全局权限目录（与作用域**无关**）：`SUPER_ADMIN`/`ADMIN`/`USER`（实例级）与 `WS_OWNER`/`WS_EDITOR`/`WS_VIEWER`（工作区级）与 `AGENT_DELEGATOR`/`AGENT_USER`（代理种子，`SystemAccessRoleCatalog.java:321`、`:330`），`is_system` 者不可删/不可改权限 |
| `role_permissions` | 角色 → 原子（**42 动作原子 + 3 能力原子**，2026-11-20 枚举实测；旧文写「15」已过期）；原子目录的唯一来源是代码 `PermissionAtomCatalog` |
| `role_bindings` | (角色, 主体, **grant scope**)：`scope_type ∈ {instance, workspace}`；**grant scope 在绑定上，不在角色上**；显式**不继承** |
| `grants` | 带 grant scope 的有效原子物化表（`scope_type`/`scope_id`）。来源为 `assigned`（预设**导入**一次的结果，V186 起；带 `origin_preset_id` 仅作展示/对比）、`spawn`、`template`、`credential_binding`、`agent_default`、`plugin_binding`；`preset`/`role` 是历史值，**只保留在 provenance 词表、不参与判定**；资源列 **MUST NOT** 出现 `phys:` |
| 原子 `scope_class` | `instance`（仅实例级 grant scope 可绑：`instance:super`/`instance:admin`/`CREATE_ACCOUNT`/`MANAGE_ROLES`/`SPAWN_AGENT`/`CREATE_TEMPLATE`/`credential_*`）或 `both`（其余，含 `workspace:admin`） |

- **能力原子不物化**：`instance:super`/`instance:admin`/`workspace:admin` 在认证期由绑定解析为 `cap:<atom>` authority，不写 `grants`。
- 绑定写入 **MUST** 校验 `∀ atom: scope_class ∈ {binding.scope_type, both}`，否则 `400 ROLE_SCOPE_MISMATCH`（写入期拒绝，不静默丢弃）。
- 系统角色权限集由迁移固定（V87 种子），**MUST NOT** 由运行时改写。

## 4. 规则

- 对缺少身份、缺少 grant scope、未知 action class、未知 resource 与未登记资源命名空间 **MUST** fail-closed；未分类工具 **MUST NOT** 继承 allow。
- `ALLOW` 不等于 approval；approval 与 capability check **MUST** 保持独立 gate。
- **写面只有两个**：`/api/v1/presets*`（角色 CRUD）与 `/api/v1/bindings`（grant scope 绑定全量替换），均要求 `MANAGE_ROLES` 动作原子；工作区级 grant scope 绑定**额外**要求该工作区 `MANAGE_WORKSPACE_AGENTS`。
- **MUST NOT** 存在逐主体直授（`source='direct'`）或 `/api/v1/principal-grants` 写面（已退役，`410 PRINCIPAL_GRANTS_RETIRED`）。
- 绑定写入 **MUST** 执行提权校验：调用者必须自持其所授予的原子（只对**新增**绑定对判定），否则 `403 PRIVILEGE_ESCALATION`。
- 错误码：`ROLE_SCOPE_MISMATCH` / `INVALID_GRANT_RESOURCE` / `PRIVILEGE_ESCALATION` / `SYSTEM_ROLE_IMMUTABLE` / `ROLE_IN_USE` / `LAST_SUPER_ADMIN` / `LAST_OWNER` / `CONCURRENT_MODIFICATION`；并发写冲突（`40P01`/`40001`）**MUST** 映射为 `409 CONCURRENT_MODIFICATION`（可重试），锁等待超时仍为 `503 OPERATION_LOCK_TIMEOUT`。
- **两套"角色"分域**：本文的「访问角色」与 `agent-templates.roles[]` 的「Agent 角色（模板内）」不同名不同义，**MUST NOT** 混用。
- **绑定 ≠ 组织归属**：把智能体主体绑到工作区（`workspace_agents`，落 `cap_source='baseline'`）只表达「该工作区可用该主体」，**不改变**该主体在组织树中的位置，也不等于成员（membership）成立。组织归属由 `agent_principals` 的单元归属（ltree）决定；候选读面（`GET /api/v1/workspaces/{id}/agents?includeBindable=true`）是「可绑定池 − 已绑集」，判据是 `MANAGE_WORKSPACE_AGENTS` 原子，缺原子整请求 403 且不泄名。

## 5. 实例所有权与 last-super-admin 不变式

| # | 不变式 | 判据 |
|---|---|---|
| I1 | 实例 **MUST** 至少有一个 ACTIVE 主体持实例级 `SUPER_ADMIN` 绑定 | 守卫为 `409 LAST_SUPER_ADMIN`；工作区侧同构守卫 `409 LAST_OWNER` |
| I2 | 任意时刻保留的 `WS_OWNER` 绑定**唯一**（每工作区至多一个） | 全量替换搬走最后一个 owner → `409 LAST_OWNER` |
| I3 | `instance_owner` 指针目标 **MUST** 持实例 `SUPER_ADMIN` 绑定；二者在同一事务内同步 | 转移 = 指针 + 交换绑定 + 两主体物化 + `token_version+1` + 审计 |
| I4 | 实例级 grant scope 绑定变更 **MUST** 与物化、缓存失效、受影响主体 `users.token_version + 1` 同事务提交；**工作区级 grant scope 变更只做物化 + 缓存双失效**（token 不含工作区角色） | 提交后旧 access token 下一次请求即 401 |
| I5 | 转移 **MUST** 由当前 owner 发起并通过口令复核，写 durable 审计，失败时四者零变化 | 失败注入用例证明 |

- **实例级写互斥**：改变 owner 或实例绑定的路径 **MUST** 先取 `instance_owner` 单例行的 `FOR UPDATE`（锁序 `instance_owner` → `users`），多主体加锁**MUST** 按 `subjectId` 全序排序（防 ABBA）；锁等待超 `cp.lock-timeout-ms` → `503 OPERATION_LOCK_TIMEOUT`（可重试）。
- **`users.role` 列已删除**（V89）：代码 **MUST NOT** 读写该列；建筑/注册只写绑定。

## 6. access token epoch（`tv`）

- access token **MUST** 携带 epoch claim `tv`（= 签发时刻 `users.token_version`）与 `sub`；**MUST NOT** 携带角色 claim（角色变更由绑定 + epoch 表达）。
- 每个认证请求 **MUST** 用签名校验后的 `sub` 读一次用户行并比对 `tv`，**MUST NOT** 仅凭签名有效期放行。
- **三态 fail-closed**：`sub` 非 UUID / 用户行不存在 / `tv` 缺失或不匹配 —— 一律按未认证处理（401 `AUTHORIZATION_REQUIRED`），**MUST NOT** 500。
- 认证过滤链与租户上下文拦截器 **MUST** 使用同一 epoch 判定；撤销后的 token 既不得建立 `Authentication`，也不得写入 `TenantContext`。
- `InternalTokenFilter` 的 `cp.agent-api-token` 是共享密钥、不是用户 access token，**MUST NOT** 写用户租户上下文；`/internal/v1/**` 仅认 `ROLE_INTERNAL_SERVICE`，**MUST NOT** 进入 `/api/v1/**` 的用户面。
