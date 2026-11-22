# XH 授权模型

> 契约状态：`proposed`；实现状态：`implemented`（PLAN-0610，2026-11-01）；Profile：`security`；Owner：Security/CP；来源：PLAN-0386；PLAN-0407 T2.8 / PLAN-0610 写回；更新：2026-11-22（拆分 grant scope / visibility scope 术语，补资源命名空间、fs/phys 双轨与 `credential:*` 契约，判据本体见 `../docs/i18n/zh-Hans/DEV-037-authorization-model.md`）。
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
6. **带 grant scope 的 grants 一跳查表**：主体 `source ∈ {role, spawn, template, credential_binding, agent_default}` 且 `(scope_type='instance' OR (scope_type='workspace' AND scope_id=当前 ws))` 的原子并集 并按 `(actionClass × resource)` 逐对求值，**主体派生链每一级都必须持有该原子，任一级缺即拒**（path intersection；`policy/GrantIntersectionEvaluator.java:97` 的 javadoc 与 `:103-120` 三重循环一致）；命中 → 过，未命中 → deny（制度拒，**不进入 approval、不建 pending approval**）。另有**写入期**前置上限：绑定 cap 必须 ⊆ 主体已持原子且 ⊆ 操作者已持原子，越界 403 `AGENT_PERMISSION_SCOPE_EXCEEDED`（`service/AgentPrincipalService.java:539-563`）——这是落库前的边界校验，**不是读期语义**；判据本体见 `../docs/i18n/zh-Hans/DEV-037-authorization-model.md` §4；
    - **唯一的显式例外：会话级临时能力令牌（task-124 / DSD-1509 ②）**。它**不是第六个求值层**，只是在「本会话 + 本 leaf 主体 + 行未撤销未过期」的条件下，对行里列出的那些 `(actionClass, resource)` **替代各级持有判断**；未列出的动作类仍按上面逐级求交，资源前缀语义照旧。活跃性是 SQL 谓词（无定时任务、无缓存），写面要「会话创建者 + `session:permission:configure` + 原子子集」，生命周期随 `sessions` 级联。机制与判据见 `../docs/i18n/zh-Hans/DEV-037-authorization-model.md` §11；
7. **approval-policy `askActionClasses[]`**：在册且 `mode=manual` → `ASK`；`mode=auto` → 放行并记 `allowed_by`；不在册 → 授权过后直过；
8. audit：grant 决策与 `allowed_by` 记录。

### 2.1 资源命名空间契约

- 资源串 **MUST** 采用「命名空间 + 值」形态；命名空间来自单一注册表。**未登记前缀出现在 grant 资源里 MUST fail-closed**。
- 当前资源族：`fs:<workspaceId>[/<rel>]`、`credential:*` / `credential:<uuid>`、`skill:*` / `skill:<uuid>`，以及裸路径 / URL / `*`；`phys:` 是求值键，不是可写资源族。
- 命名空间 **MUST NOT** 使用 `workspace:` 或 `session:`：二者是 context（workspace 由 grant scope 表达，session 是会话容器），不是对象身份。注意能力原子 `workspace:admin` 与 action atom `session:permission:configure` 是原子名，不是资源命名空间。
- **`fs:` / `phys:` 双轨**：授权 **MUST** 只书写 `fs:<声明键>`；`phys:` 只在求值期由声明键展开，**MUST NOT 落入 grants 表、MUST NOT 接受 API 提交**。提交 `phys:` grant **MUST** 返回 `400 INVALID_GRANT_RESOURCE`。理由是物理键是宿主绝对路径，换机器 / 容器 / 恢复备份都会变，写进长期授权会把权限绑死在某台机器上。求值期两侧都是 `fs:` 时 **MUST** 展开成 `phys:` 比物理身份，**MUST NOT** 回退成字符串比较。
- **`credential:*` 语义**：`credential:*` 只用于凭证**管理面**（`credential_manage` 等原子的 canonical resource），**MUST NOT** 被解释成「可使用全部凭证」的授权。使用请求 **MUST** 携带具体 `credential:<uuid>`；**判定请求的 resource** 为 `credential:*` 且 actionClass 为 `credential_use` 时 **MUST** 拒绝（`policy/ToolFaceRegistry.java:423-445`、`policy/PolicyRequest.java:28-37`）；grant 侧的宽行只是 ceiling 写法，**MUST NOT** 让请求跳过具体 uuid。
- **组织树**：`OrgUnitAccess.Scope`（ltree 路径）永久留在 conditions / visibility scope 面，**MUST NOT** 进入资源轴。资源注册表 **MAY** 预留 `tree` matcher 类型，但当前 **MUST NOT** 注册 `org:` 命名空间。

**新增资源类别 playbook**：注册表加一行（namespace + matcher + canonicalizer）→ 提取器加一个 key → 校验器接受该前缀 → 单测 / golden 加用例 → 文档登记一行。**MUST NOT** 因此改表、改求值器或做迁移；真正的成本在确定 canonical 形态（什么算同一个资源），不在代码。

## 3. 模型

| 对象 | 语义 |
|---|---|
| `roles` | 全局权限目录（与作用域**无关**）：`SUPER_ADMIN`/`ADMIN`/`USER`（实例级）与 `WS_OWNER`/`WS_EDITOR`/`WS_VIEWER`（工作区级）与 `AGENT_DELEGATOR`/`AGENT_USER`（代理种子，`SystemAccessRoleCatalog.java:321`、`:330`），`is_system` 者不可删/不可改权限 |
| `role_permissions` | 角色 → 原子（**42 动作原子 + 3 能力原子**，2026-11-20 枚举实测；旧文写「15」已过期）；原子目录的唯一来源是代码 `PermissionAtomCatalog` |
| `role_bindings` | (角色, 主体, **grant scope**)：`scope_type ∈ {instance, workspace}`；**grant scope 在绑定上，不在角色上**；显式**不继承** |
| `grants` | 带 grant scope 的有效原子物化表（`scope_type`/`scope_id`），仅由物化器写入 `source='role'`；资源列 **MUST NOT** 出现 `phys:` |
| 原子 `scope_class` | `instance`（仅实例级 grant scope 可绑：`instance:super`/`instance:admin`/`CREATE_ACCOUNT`/`MANAGE_ROLES`/`SPAWN_AGENT`/`CREATE_TEMPLATE`/`credential_*`）或 `both`（其余，含 `workspace:admin`） |

- **能力原子不物化**：`instance:super`/`instance:admin`/`workspace:admin` 在认证期由绑定解析为 `cap:<atom>` authority，不写 `grants`。
- 绑定写入 **MUST** 校验 `∀ atom: scope_class ∈ {binding.scope_type, both}`，否则 `400 ROLE_SCOPE_MISMATCH`（写入期拒绝，不静默丢弃）。
- 系统角色权限集由迁移固定（V87 种子），**MUST NOT** 由运行时改写。

## 4. 规则

- 对缺少身份、缺少 grant scope、未知 action class、未知 resource 与未登记资源命名空间 **MUST** fail-closed；未分类工具 **MUST NOT** 继承 allow。
- `ALLOW` 不等于 approval；approval 与 capability check **MUST** 保持独立 gate。
- **写面只有两个**：`/api/v1/roles*`（角色 CRUD）与 `/api/v1/bindings`（grant scope 绑定全量替换），均要求 `MANAGE_ROLES` 动作原子；工作区级 grant scope 绑定**额外**要求该工作区 `MANAGE_WORKSPACE_AGENTS`。
- **MUST NOT** 存在逐主体直授（`source='direct'`）或 `/api/v1/principal-grants` 写面（已退役，`410 PRINCIPAL_GRANTS_RETIRED`）。
- 绑定写入 **MUST** 执行提权校验：调用者必须自持其所授予的原子（只对**新增**绑定对判定），否则 `403 PRIVILEGE_ESCALATION`。
- 错误码：`ROLE_SCOPE_MISMATCH` / `INVALID_GRANT_RESOURCE` / `PRIVILEGE_ESCALATION` / `SYSTEM_ROLE_IMMUTABLE` / `ROLE_IN_USE` / `LAST_SUPER_ADMIN` / `LAST_OWNER` / `CONCURRENT_MODIFICATION`；并发写冲突（`40P01`/`40001`）**MUST** 映射为 `409 CONCURRENT_MODIFICATION`（可重试），锁等待超时仍为 `503 OPERATION_LOCK_TIMEOUT`。
- **两套"角色"分域**：本文的「访问角色」与 `agent-templates.roles[]` 的「Agent 角色（模板内）」不同名不同义，**MUST NOT** 混用。

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
