# XH 权限面原子契约（Authz Atom Contract）

> 契约状态：`active`（由 PLAN-0651 冻结，2026-11-04）；实现状态：`partial`（P0 原子见 M1，P1 原子见 M2）；Profile：`security`；Owner：Security owner（CP `policy/`）；来源：PLAN-0651（BL-208）决策 D51-25/D51-26/D51-27；更新：2026-11-04。
> 消费者：CP `PermissionAtomCatalog` / `AuthzContext` / `RequesterAuthority` / `SystemAccessRoleCatalog`、Flyway 种子迁移、UI `/me/permissions` 消费方、后续权限面 PLAN。

本契约只冻结「面 → action atom → 默认授予集」的目标态；实现事实仍是 `packages/control-plane/src/main/java/com/cc01xx/.../policy/*.java`，wire 事实是 `docs/api/openapi.yaml`。

## 1. 不变式（MUST）

1. 可见性 / 投递受众 / 操作面 MUST 在 action atom 层求值；业务代码 MUST NOT 以 `isInstanceAdmin()`、`role === 'ADMIN'`、`WorkspaceRole.canWrite(role)` 之类**角色名**回答面问题（白名单见 §6）。
2. 每个面 MUST 有一个显式原子；新增面 MUST 同批定义 `scope_class` 与**默认授予集**（管理员 MUST 显式列入，不得依赖隐含）。
3. `capability atom` 值域 MUST 保持 3（`instance:super` / `instance:admin` / `workspace:admin`）；capability atom MUST NOT 进入 `grants`（PLAN-0610 决策 #23）。
4. 新原子 MUST 显式回答「是否可授 agent principal」；`both` 只表示可绑作用域，**不等于**可授 agent。
5. 拒绝形态 MUST 保持既有三态（403 / 404 掩蔽 / 掩码），迁移 MUST NOT 制造新的信息泄露面。
6. 名单类结果 MUST 落请求内快照，MUST NOT 事后回溯；放行审计 MUST 记 `atom` + 绑定来源，拒绝审计 MUST 记 `atom`/`subject`/`workspaceId`/`source=none`，MUST NOT 记他人 `grantId`。

## 2. 作用域与求值语义

| 事实 | 契约 |
|---|---|
| `scope_class` | 只有 `instance` / `both` 两类（PLAN-0610 决策 #27）；定义 SSOT 在 `PermissionAtomCatalog`，`role_permissions` 只存原子名 |
| instance 绑定 | 覆盖**全部**工作区（等价于「全域」） |
| workspace 绑定 | 只覆盖该工作区，MUST NOT 跨工作区生效 |
| 一次求值 | `holdsActionAtom(subject, atom, workspaceId)` MUST 返回「instance 行 ∪ 该 workspace 行」的并集；`workspaceId=null` 时 MUST 只返回 instance 行。**实现不得**把它拆成两次「取或」（语义重复且易被误读成可单判 workspace 行） |
| 成员资格 | 不是角色判据，MUST 原样保留（例如会话参与者的 `isWorkspaceMember` 前置条件）；MUST NOT 用原子替代 |
| 请求内一致 | 同一请求内的读权判据与掩码/视图判据 MUST 同源（请求级 memo），MUST NOT 一边读 30s 缓存、一边读实时 grants |
| fail-closed | 求值异常 MUST 视为拒绝（沿用 `RequesterAuthority` 的 fail-closed 语义） |

## 3. 原子目录（10 个新 action atom）

| # | 原子 | 语义（面） | `scope_class` | 默认授予集 | 可授 agent principal | 拒绝形态 |
|---|---|---|---|---|---|---|
| N1 | `MANAGE_AGENT_PRINCIPALS` | 实例级 Agent principal 生命周期（禁用他人 PERSONAL、绑定 INSTANCE scope） | `instance` | SUPER_ADMIN, ADMIN | **禁** | 403 `FORBIDDEN` / `INSTANCE_ADMIN_REQUIRED` |
| N2 | `READ_INSTANCE_CONTENT` | 读实例层配置与实例模板 | `instance` | SUPER_ADMIN, ADMIN | **禁** | 403 |
| N3 | `WRITE_INSTANCE_CONTENT` | 写实例层配置 / 实例模板 / API 请求模板 | `instance` | SUPER_ADMIN, ADMIN | **禁** | 403 |
| N4 | `VIEW_SECRET_CONTENT` | 未掩码查看凭据类配置值 | `instance` | SUPER_ADMIN, ADMIN | **禁** | 掩码（非拒绝） |
| N5 | `MANAGE_SKILL_LIBRARY` | 技能库定义写 + 技能绑定 | `both` | SUPER_ADMIN, ADMIN + WS_OWNER | **禁** | 403 `SKILL_IMPORT_FORBIDDEN` |
| N6 | `MANAGE_PROVIDER_CONNECTIONS` | Provider 连接创建/更新/删除（工作区范围） | `both` | SUPER_ADMIN, ADMIN + WS_OWNER, WS_EDITOR | **禁** | 403 |
| N7 | `USE_WORKSPACE_RUNTIME` | 读环境快照 + 触发 runtime release | `both` | SUPER_ADMIN, ADMIN + WS_OWNER, WS_EDITOR, WS_VIEWER | **禁** | 404 `WORKSPACE_NOT_FOUND` 掩蔽 |
| N8 | `MANAGE_WORKSPACE_RUNTIME` | 切换执行模式（owner 语义） | `both` | SUPER_ADMIN, ADMIN + WS_OWNER | **禁** | 404 掩蔽 |
| N9 | `MANAGE_WORKSPACE_POLICY` | workspace 层策略规则 / 工具面 | `both` | SUPER_ADMIN, ADMIN + WS_OWNER, WS_EDITOR | **禁** | 403 `FORBIDDEN` |
| N10 | `MANAGE_WORKSPACE_MEMBERS` | 成员列表 / 增 / 改 / 移除（含紧急移除） | `both` | SUPER_ADMIN, ADMIN（instance 行）；**WS_OWNER 不授**（产品待定） | **禁** | 403 `FORBIDDEN`；成员域名 404 掩蔽 |
| **N11** | `GRANT_ANY_ATOM`（2026-11-05 由 PLAN-0673 T4.4 补录） | **授予侧子集绕过**：持有者可授予自己未持有的原子（"授予任意原子"能力） | `instance` | **仅 SUPER_ADMIN**（V125 起；ADMIN 不授） | **禁**（不得授予 agent 主体） | 授予者无该原子且无 `GRANT_ANY_ATOM` ⇒ 403 `PRIVILEGE_ESCALATION`；**不绕过其他门** —— 上限 cap 超限仍 409 `ROLE_BINDING_EXCEEDS_CAP`、禁授原子仍 409 `AGENT_PRINCIPAL_FORBIDDEN_ATOMS` |

> **N11 说明**：本节原称"10 个新 action atom"，`GRANT_ANY_ATOM` 实为紧随其后的第 11 个（PLAN-0673 M1 引入代码与 OpenAPI/inventory/DEV-014，当时漏补本节）。它与 `MANAGE_ROLES` 的区别：`MANAGE_ROLES` = **能改角色定义与绑定**；`GRANT_ANY_ATOM` = **能突破"授予者必须持有该原子"的子集校验**，是纯度更高的提权面，故 scope 限 `instance`、默认授予集只到 SUPER_ADMIN、且对 agent 主体禁授（V4.2 已断言它不构成禁授旁路）。

**复用（不新增）**：实例层角色/工具面 = `MANAGE_ROLES`（instance-only）；会话参与者管理 = `MANAGE_WORKSPACE_AGENTS`（both，已知瑕疵：A8 借用成员管理原子，后续拆原子时再收）；"管理员 ⇒ workspace admin" = `workspace:admin` 进默认授予集。

## 4. 隐含关系（唯一一条）

- `instance:super ⇒ instance:admin`、`instance:admin/instance:super ⇒ workspace:admin` **MUST** 只由 `RequesterAuthority.mayGrantCapability`（授予校验）表达；**MUST NOT** 扩展为「内置角色对 N1–N10 的隐含授予」——那部分 MUST 用显式种子（可 grep、可审计）。
- **自定义角色 MUST NOT 享受任何隐含**（避免隐式提权）；自定义角色的原子只能由显式 `role_permissions` 行给出。

## 5. 默认授予集的交付方式（MUST 三处同批）

1. Flyway 迁移：`role_permissions` 行（`ON CONFLICT … DO NOTHING`）+ **两段** `grants` 回填：
   - instance 段：`role_bindings` 中 `scope_type='instance'` 的主体，逐原子一行，`DISTINCT ON (subject_id)`；
   - workspace 段：`scope_type='workspace'` 的主体，逐原子一行，`DISTINCT ON (subject_id, scope_id)`，写 `scope_type='workspace', scope_id=绑定.scope_id`。
   - 回填 MUST 幂等（`NOT EXISTS` + 唯一索引 `uq_grants_role_atom`）；MUST 在迁移文件头写可逆步骤；**MUST 同批提供「零遗漏」校验查询并以自动化断言测试落地**（不得只写在文档里）。
2. 代码侧镜像：`SystemAccessRoleCatalog.roleSeeds()`（H2/entity 建库靠 `ensureSeeded()`）。
3. head 双向 parity：`AgentPrincipalScopeMigrationTest#headSeedsMatchTheCodeSideCatalog` MUST 绿（`DynamicAccessRoleMigrationTest` 固定 V87 且单向，**不得**作为本契约的护栏）。

## 6. 判据（审查者用）

| 判据 | 命令 | 白名单 |
|---|---|---|
| V1 `isInstanceAdmin` 收口 | `rg -n 'isInstanceAdmin' packages/control-plane/src/main` | 13 行 = 能力层本体 11 + `CapabilityProjectionService:90`（wire 字段）+ `WorkspaceController:320`（defer） |
| V15 角色名收口 | `rg -n 'WorkspaceRole\.|"ADMIN"\|"OWNER"\|"VIEWER"\|"EDITOR"'` | defer 项 + `WorkspaceRole` 定义本体 + 成员面两步成员角色判据（`WorkspaceMemberService:74,143`）+ `ToolFaceService:171` |
| 原子集合 | `actionAtoms().size()` / `capabilityAtoms().size()` / `builtinActionClasses().size()` | 32 / 3 / 32（三集合一致，差集 ∅；BL-312 移除 CREATE_OWN_AGENT 前为 33；M1 时为 19） |
| agent 禁授 | `agentPrincipalForbiddenAtoms()` | MUST 含全部新原子 |
| 种子零遗漏 | 迁移校验查询（§5.1） | 0 行 |

## 7. 失败史（为什么需要本契约）

- 一个粗粒度 `instance:admin` 原子承担十来个面，导致「管理员算不算某个面」由代码临时回答，同一方法内出现两套判据（`AgentTemplateService:246` vs `:266`）。
- 复用「agent 管理」原子承担成员管理，会把实例管理员专属的成员紧急移除放宽到任何持原子者（PLAN-0651 审查 R9-1）。
- 新原子标 `both` 若不显式禁 agent，会让 agent principal 获得管理面（PLAN-0651 审查 R4-2）。
