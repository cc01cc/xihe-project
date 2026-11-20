---
title: DEV-037 - 授权模型详解（交集授权）
category: dev-guide
sidebar_order: 37
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-11-20
updated: 2026-11-20
description: XH 自研授权模型的判据、选择理由与换型阈值：正名「交集授权」，给出为什么它不是「基于角色的权限系统」、与九族成熟模型的逐维对比、自研代价、九步求值链与三件工程机制。
tags:
  - authz
  - policy
  - security
---

# DEV-037: 授权模型详解（交集授权）

> 名称状态：**已定名（DSD-1499，2026-11-20 用户拍定）**。「交集授权（Intersection-grant Authorization）」由用户选定，非待定；改名单点只有三处：本篇标题、§1 的结论句、`A03-xihe/docs/i18n/zh-Hans/DEV-032-terminology.md` 的词条。
> 读者：要判断「这条路径能不能走」的开发者、要审「PEP（执行点）有没有漏」的审查者、要决定「要不要换现成件」的决策者。
> 事实口径：判据以 `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/` 的源码为准（2026-11-20 工作树读数）；证据等级标注沿用 `fact-verification` 的 [实测] / [源码] / [文档]。
> 决策记录：定名见 DSD-1492，换型阈值见 DSD-1497。

## 1. 一句话结论：它叫交集授权，别叫它「基于角色的权限系统」

**交集授权（Intersection-grant Authorization）**：一次工具调用能否通过，取决于 **(动作原子 × 资源前缀) 两轴是否同时被显式授予，且主体派生链的每一级都持有该原子**；缺省拒。角色只是把原子物化进 grants 的通道，求值阶段不读角色变量。

可当验收语用的判定句：*给定 principal、actionClass、resource，三者交集非空、资源前缀覆盖真实目标，且主体派生链每一级都持有该原子，才 ALLOW；否则 DENY。*

| 候选 | 主张 | 结论 |
|---|---|---|
| **交集授权（Intersection-grant Authorization）** | 名字直接指向不变式：两轴交集 + 缺省拒 | **采纳**（DSD-1499，2026-11-20 用户拍定） |
| 能力边界授权（Capability-boundary Authorization） | 强调「主体派生链每级都有上限」 | 备选：只说清 ceiling 一侧，没表达资源轴交集 |
| 原子授权 / 逐原子授权（Atom-grant） | 强调判据单位是原子 | 备选：容易被读成 ABAC 的「属性原子」 |

三条反例（为什么不能把它读成「基于角色的权限系统」）：

| 反例 | 事实 | 锚点 |
|---|---|---|
| 改角色不改授权面 | 角色只把原子物化进 `access_role_permissions`；求值输入是 `PermissionAtom(actionClass, resource)` 两字段，`parse` 遇到第三个键直接抛 `Unknown permission atom field` | `policy/RoleGrantMaterializer.java:376-393`；`policy/GrantIntersectionEvaluator.java:36-52`、`:46-50` |
| 能力原子根本不进 grants | 平台/实例级能力原子不是可授予动作，物化时返回 null 被跳过 | `policy/RoleGrantMaterializer.java:381-383`；`policy/PermissionAtomCatalog.java:414`、`:419` |
| 组合语义不是「多角色并集放大」 | 同主体多条 grants 确实并集（`union`，来源标签不产生优先级），但并集之后还要过资源前缀覆盖与**写入期**上限：绑定 cap 不得超出主体与操作者各自已持原子的集合，否则 403 `AGENT_PERMISSION_SCOPE_EXCEEDED` | `policy/GrantIntersectionEvaluator.java:152-165`；`service/AgentPrincipalService.java:539-563` |

**禁用词**（写作与评审一律不用）：`RBAC`、`基于角色的权限系统`、`作用域交集`（「作用域」在本仓专指 `scope_type` 的 instance / workspace 两档，与「资源前缀」不是一回事）。这个词只允许出现在「与成熟模型对比」表与来源链接里（对比语境），不得用来描述本模型。

## 2. 决策输入：一次判定只看四样东西

| 输入 | 取值来源 | 不许做的事 | 锚点 |
|---|---|---|---|
| **principal** | 会话叶子的参与者 + agent 绑定；`resolveAgent` 返回叶子自身主体与整条会话链 | 不信任请求里自带的主体；链上任何一环 tenant 不符、缺 principal、成环都 fail-closed | `policy/GrantPrincipalPathResolver.java:78-106` |
| **actionClass** | 工具到动作类的映射表（内置工具 + 第三方 MCP 工具的 extraFaces） | 不由调用方声明动作类；未分类工具落 `UNCLASSIFIED_ACTION` | `policy/ToolFaceRegistry.java:277-299`；`policy/PolicyRequest.java:24-27` |
| **resource** | 工具参数解析出的目标串（`fs:` 声明键、`phys:` 物理键、`credential:<uuid>` 等） | 凭据类请求必须带具体 `credential:<uuid>`；`credential:*` 与裸 `*` 直接抛错（fail-closed） | `policy/PolicyRequest.java:28-37` |
| **scope** | 由 `workspaceId` / `sessionId` 派生，**不是请求参数** | 请求体不得携带决定授权的 scope；跨工作区读写由 repository 的 scoped 查询裁决 | `spec/security/authorization.md` §2 第 2 步；`service/AgentPrincipalService.java:536-540` |

## 3. 求值链九步

<svg viewBox="0 0 660 400" width="100%" role="img">
  <title>DEV-037：一次工具调用经过的九道关卡</title>
  <defs><marker id="ar37" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#4f46e5"/></marker></defs>
  <rect x="16" y="26" width="336" height="360" rx="6" fill="#f9fafb" stroke="#d1d5db"/>
  <text x="32" y="46" font-size="12" fill="#374151">请求进入</text>
  <rect x="32" y="56" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="72" font-size="11" fill="#374151">1 认证与 tv</text><text x="248" y="72" font-size="11" fill="#6b7280">认证过滤链</text>
  <rect x="32" y="92" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="108" font-size="11" fill="#374151">2 scope 派生</text><text x="248" y="108" font-size="11" fill="#6b7280">CP 解析</text>
  <rect x="32" y="128" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="144" font-size="11" fill="#374151">3 能力原子</text><text x="248" y="144" font-size="11" fill="#6b7280">AuthzContext</text>
  <rect x="32" y="164" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="180" font-size="11" fill="#374151">4 工具面映射</text><text x="248" y="180" font-size="11" fill="#6b7280">ToolFace</text>
  <rect x="32" y="200" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="216" font-size="11" fill="#374151">5 L0 硬门</text><text x="248" y="216" font-size="11" fill="#6b7280">HardGuard</text>
  <rect x="32" y="236" width="200" height="24" rx="4" fill="#ffffff" stroke="#4f46e5"/><text x="44" y="252" font-size="11" fill="#312e81">6 原子与资源</text><text x="248" y="252" font-size="11" fill="#4f46e5">GrantAuthz</text>
  <rect x="32" y="272" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="288" font-size="11" fill="#374151">7 审批门</text><text x="248" y="288" font-size="11" fill="#6b7280">Approval</text>
  <rect x="32" y="308" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="324" font-size="11" fill="#374151">8 执行</text><text x="248" y="324" font-size="11" fill="#6b7280">Runtime</text>
  <rect x="32" y="344" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="360" font-size="11" fill="#374151">9 审计</text><text x="248" y="360" font-size="11" fill="#6b7280">AuditLogger</text>
  <path d="M400,60 L400,356" stroke="#4f46e5" stroke-width="1.5" marker-end="url(#ar37)"/>
  <text x="416" y="200" font-size="11" fill="#4f46e5">越往下越窄</text>
  <text x="416" y="220" font-size="10" fill="#9ca3af">缺省拒</text>
</svg>

| # | 步骤 | 谁判 | 锚点 | 判错会怎样 |
|---|---|---|---|---|
| 1 | 认证 + access-token epoch | 认证过滤链（token 的 `tv` 与 `users.token_version` 不一致即 401） | `auth/AuthService.java:196-200`；`spec/security/authorization.md` §6 | 旧 token 继续可用，撤销失效 |
| 2 | scope 派生（租户一致性） | CP 派生，非请求参数 | `policy/GrantAuthorizationService.java:83-102` | 跨租户读写 |
| 3 | 能力原子闸 | 能力缓存 `AuthzContext`（`cp.capability-cache-ttl-ms` 默认 30000 ms） | `policy/AuthzContext.java:106` | 越权进管理面 |
| 4 | 工具面到动作类 | `ToolFaceRegistry` 构造器 | `policy/ToolFaceRegistry.java:277-299` | 工具错分类，判据套错轴 |
| 5 | L0 硬门 | `HardGuard`（builtin 层，先于一切 grant） | `policy/HardGuard.java:59`、`:98-112`；`policy/PolicyEngine.java:111-112` | 对关键路径的不可逆删除被放行 |
| 6 | 原子与资源（主体派生链候选） | `GrantAuthorizationService.allows` 取源与快照 → `GrantIntersectionEvaluator.allows` 判定 | `policy/GrantAuthorizationService.java:83-123`；`policy/GrantIntersectionEvaluator.java:211-240` | 越权执行 |
| 7 | 审批门（要不要 ASK） | `PolicyEngine.approvalVerdict`，按 ask 动作类列表 | `policy/PolicyEngine.java:198-213` | 该问的没问，或全问成打扰 |
| 8 | 执行 | Runtime（`job_host_adapter.rs` 明确不做 sandbox、不做 policy） | `packages/runtime/src/job_host_adapter.rs:1-5` | 以为 Runtime 兜底，实际无兜底 |
| 9 | 审计 | 审批链写 `audit_logs`；授权求值自身只打 WARN | `policy/GrantAuthorizationService.java:119-121` | 拒了说不出理由 |

## 4. 判据本体（源码锚点）

| 判据 | 内容 | 锚点 |
|---|---|---|
| 原子两字段 | `PermissionAtom(actionClass, resource)`；未知字段即抛错，不允许夹带第三维 | `policy/GrantIntersectionEvaluator.java:36-52`、`:46-50` |
| 缺省拒 | 主体链为空、动作类为空、资源空白、动作类不在闭集内，一律 false | `policy/GrantIntersectionEvaluator.java:265-309` |
| 两轴同时命中 | 逐个 (actionClass × resource) 组合判定，任一组合无命中即 false | `policy/GrantIntersectionEvaluator.java:326-362` |
| 资源匹配 | 两侧都是 `fs:` 声明键时归一成 `phys:` 比物理身份（永不比字符串），其余交分层匹配器 | `policy/ResourceIdentity.java:104-130`；`policy/GrantIntersectionEvaluator.java:202-208` |
| 来源闭集 | 参与判定的 grant 来源是闭集 `EVALUATION_SOURCES`（6 个来源），来源标签不产生优先级 | `policy/GrantSources.java:59-63`；`policy/GrantIntersectionEvaluator.java:152-165` |
| 写入期上限 | 绑定 cap 必须 ⊆ 主体已持原子且 ⊆ 操作者已持原子，否则 403 并点名越界原子 | `service/AgentPrincipalService.java:539-563` |

**一条必须说清的实现细节**：`GrantIntersectionEvaluator.allows` 的 javadoc（`:97`「Every requested atom must be granted by every principal in the operation path.」）与实现一致——`principalPath` 里**每一级**快照都必须持有该 `(actionClass × resource)` 原子，任一级 `noneMatch` 即整体 `return false`（`:103-120`），所以「逐级求交」在**求值期**就成立，不是只在写入期成立。评审读法：`path` 由 `policy/GrantPrincipalPathResolver` 按主体派生链解出（`:78-106` 对 agent 链逐级校验），链上任一环缺原子整条调用即拒，放宽单独一级不生效。写入期另有**前置上限**（cap ⊆ 主体已持原子且 ⊆ 操作者已持原子，`service/AgentPrincipalService.java:539-563`，越界 403 `AGENT_PERMISSION_SCOPE_EXCEEDED`）：它是落库前的边界校验，不能替代读期判定。

## 5. 资源与原子目录

- 原子目录：**42 个动作原子 + 3 个能力原子**（`policy/PermissionAtomCatalog.java`；[实测] 枚举计数见 `internal/A03-xihe/evidence/2026-11-20-permission-atom-matrix/README.md`）。
- 有工具面入口的动作类 **7 个**：`read`、`write`、`exec`、`network`、`credential_use`、`spawn_agent`、`team_task_manage`（`policy/ToolFaceRegistry.java:280-296`）。`delete` 动作类存在，但当前没有任何工具映射到它，`WRITE_TOOLS` 也不含删除工具（`policy/ToolFaceRegistry.java:193-195`、`:254`）——即该原子在工具链上不可达。

8 个内置角色的默认动作原子数（[实测]，同一份证据）：

| 角色 | 默认动作原子数 | 类别 | 定义处 |
|---|---|---|---|
| SUPER_ADMIN | 45 | 平台 | `policy/SystemAccessRoleCatalog.java` |
| ADMIN | 32 | 平台 | 同上 |
| USER | 10 | 平台 | 同上 |
| WS_OWNER | 17 | 工作区 | 同上 |
| WS_EDITOR | 12 | 工作区 | 同上 |
| WS_VIEWER | 2 | 工作区 | 同上 |
| AGENT_DELEGATOR | 1 | 代理 | `policy/SystemAccessRoleCatalog.java:374` |
| AGENT_USER | 7 | 代理 | `policy/SystemAccessRoleCatalog.java:385` |

PEP 覆盖面：42 个原子里只有 7 个（约 17%）有工具面入口；Windows host 通道既无 sandbox 也无 policy 门（`packages/runtime/src/job_host_adapter.rs:1-5`）。覆盖清单与缺口见 `internal/A03-xihe/evidence/2026-11-20-pep-coverage/README.md`。

## 6. 与成熟模型对比

| 族（代表实现） | 判据形态 | 组合语义 | 资源标识 | 缺省态 | 显式 Deny | 条件属性 | 可解释性 | 部署成本 | 迁移成本 | 对仓内实现的耦合 |
|---|---|---|---|---|---|---|---|---|---|---|
| AWS IAM 策略族 [文档] | 策略语句 Allow/Deny on Action × Resource | 多策略并集，SCP 作边界逐层收窄 | ARN（层级前缀） | Deny | 有，且 Deny 优先 | 有 Condition | 中（策略模拟器） | 云托管 | 高（绑云） | 高 |
| 云 IAM 与 SCP（GCP IAM 范式）[文档] | 角色绑到资源树节点 | 沿资源树向下并集；另有 deny 策略 | `projects/...` 资源名 | Deny | 有（deny policy） | 有（条件表达式） | 中 | 云托管 | 高 | 高 |
| Kubernetes RBAC [文档] | Role / ClusterRole 的 rules（verbs × resources） | 多绑定并集，只加不减 | 资源类型 + 名称，**无路径前缀** | Deny | 无 | 无 | 低（`kubectl auth can-i`） | 自托管 | 中 | 低 |
| GitHub 细粒度 PAT [文档] | 仓库 × 权限集（read/write） | 并集 | 仓库 + 权限名 | Deny | 无 | 无 | 低 | SaaS | 高 | 中 |
| Zanzibar 关系族（OpenFGA / SpiceDB）[文档] | 关系元组 + userset 重写，`check` 走图 | 图求值（union / intersection / exclusion 表达式） | relation + object id | Deny | 只能靠 exclusion 间接表达 | 弱（无属性） | 低（图可查） | 需新服务 + 新库 | 高（要建图） | 高 |
| Cedar / AVP [文档] | `permit` / `forbid` 策略 + 实体属性 | forbid 覆盖 permit；无跨层交集原语 | 实体属性 | Deny | 有（forbid） | 有（属性 / 上下文） | 高（可形式化分析） | 引擎可嵌，AVP 托管 | 高 | 高 |
| OPA / Rego [文档] | 任意 Rego 决策函数 | 由策略作者自定 | 任意 | 由策略定 | 由策略定 | 有（data 文档） | 中（`explain`） | 需 sidecar 或服务 | 高（双写一致性） | 中 |
| Casbin [文档] | model 的 matcher + policy 行 | 多策略并集 | 由 model 定 | 由 model 定 | 只能由 matcher 间接表达 | 弱 | 低 | 库内嵌 | 中 | 低 |
| **本模型（交集授权）** | `PermissionAtom(actionClass, resource)` + 资源前缀覆盖 | 同主体多源并集 + **写入期 ceiling 收窄** + 求值缺省拒 | `fs:` 声明键归一成 `phys:` 前缀；`credential:<uuid>` | Deny | **无显式 Deny** | 无（纯原子，不带属性） | 低（只有 WARN 日志，explain 在办） | 纯仓内，零外部件 | — | — |

两句结论：

- 与 AWS IAM 最接近的是三件事：**Action × Resource 两轴**、**缺省拒**、**边界式上限**（SCP 之于 IAM，对应本模型的写入期 ceiling 之于 grants）；最不像的是本模型没有显式 Deny。
- 与 Zanzibar 关系族最远：本模型没有关系图，也没有 userset 重写，判据是「原子 + 前缀」而不是「关系」。所以凡是「需要授权关系图推理」的需求（共享、委派链上的可传递性），本模型都只能用显式 grant 行铺出来，铺不动就说明该换族了（见 §9）。

来源（[文档] 级，官方文档）：

- AWS IAM 策略元素与 SCP 边界语义：<https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies.html>
- GCP IAM 允许策略与拒绝策略：<https://cloud.google.com/iam/docs/deny-overview>
- Kubernetes RBAC：<https://kubernetes.io/docs/reference/access-authn-authz/rbac/>
- GitHub 细粒度 PAT 权限：<https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens>
- OpenFGA 关系模型：<https://openfga.dev/docs/concepts>；SpiceDB：<https://authzed.com/docs>
- Cedar 语言与 AVP：<https://docs.cedarpolicy.com/>
- OPA 决策模型与 `explain`：<https://www.openpolicyagent.org/docs/latest/>
- Casbin 模型语法：<https://casbin.org/docs/overview>

## 7. 为什么不用现成件

| 现成件 | 能带来什么 | 为什么不用 | 硬冲突 |
|---|---|---|---|
| Amazon Verified Permissions（AVP） | Cedar 引擎 + 托管策略存储 + 分析器 | 判定要走网络、绑账号与配额 | 部署口径是单机、离线优先，判定不能依赖外部服务 |
| Cedar 库（直接嵌入） | 形式化语义、`forbid` 覆盖、可做分析 | 语义原语是 permit / forbid，没有「逐级 ceiling」这一维；要表达本模型的收窄，只能把每级上限翻译成 forbid 集合，策略条数随层级组合膨胀 | 需要在 CP 内重写全量判据语言与 42 个原子的映射，且禁止照搬现有语义 |
| OPA / Rego | 通用策略语言、`explain` 决策链 | 必须引入 sidecar 或独立服务，判定与业务数据跨进程 ⇒ 双写一致性成本 | 无 sidecar 约定，且要求判定与 grants 同库同事务可查 |
| Casbin | 库内嵌、模型可配、上手快 | matcher 语义里没有资源前缀树，也没有 ceiling，权限集合等价于「角色并集」 | 资源前缀（目录子树）是硬需求 |
| OpenFGA / SpiceDB | 关系图求值、可横向扩展 | 关系模型不表达「路径前缀」；引入新服务与新数据库 | 单机部署边界 + 图迁移成本 |

反事实推演（把需求压回角色模型会怎样）：「让某个 agent 只对 `/w/<id>/src` 子树有 write」在纯角色模型里只有两条路——把「路径前缀」提升成权限类型（权限条目随目录数增长，且每次新增目录都要配权），或按「工作区 × 目录 × 动作 × 档位」造角色（组合爆炸，撤销时改的是角色定义而不是一条 grant 行）。本模型把这两者压成一个二元组 `(原子, 资源前缀)`，撤销 = 删或改一条 grant 行。

<svg viewBox="0 0 660 320" width="100%" role="img">
  <title>DEV-037：并集越加越宽，交集越深越窄</title>
  <rect x="16" y="24" width="306" height="122" rx="6" fill="#f9fafb" stroke="#d1d5db"/>
  <text x="32" y="44" font-size="12" fill="#374151">多角色并集</text>
  <rect x="40" y="58" width="70" height="18" fill="#ffffff" stroke="#9ca3af"/>
  <rect x="40" y="82" width="130" height="18" fill="#ffffff" stroke="#9ca3af"/>
  <rect x="40" y="106" width="200" height="18" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="252" y="120" font-size="10" fill="#4f46e5">越加越宽</text>
  <rect x="338" y="24" width="306" height="122" rx="6" fill="#f9fafb" stroke="#d1d5db"/>
  <text x="354" y="44" font-size="12" fill="#374151">原子与资源</text>
  <rect x="362" y="58" width="200" height="18" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="362" y="82" width="130" height="18" fill="#ffffff" stroke="#9ca3af"/>
  <rect x="362" y="106" width="70" height="18" fill="#ffffff" stroke="#9ca3af"/>
  <text x="574" y="120" font-size="10" fill="#4f46e5">越深越窄</text>
  <rect x="16" y="158" width="628" height="146" rx="6" fill="#f9fafb" stroke="#d1d5db"/>
  <text x="32" y="178" font-size="12" fill="#374151">纯角色设前缀要造多少角色</text>
  <rect x="40" y="196" width="120" height="26" rx="4" fill="#ffffff" stroke="#9ca3af"/>
  <text x="100" y="214" font-size="11" fill="#374151" text-anchor="middle">工作区</text>
  <text x="172" y="214" font-size="12" fill="#6b7280">x</text>
  <rect x="186" y="196" width="120" height="26" rx="4" fill="#ffffff" stroke="#9ca3af"/>
  <text x="246" y="214" font-size="11" fill="#374151" text-anchor="middle">目录</text>
  <text x="318" y="214" font-size="12" fill="#6b7280">x</text>
  <rect x="332" y="196" width="120" height="26" rx="4" fill="#ffffff" stroke="#9ca3af"/>
  <text x="392" y="214" font-size="11" fill="#374151" text-anchor="middle">动作</text>
  <text x="468" y="214" font-size="11" fill="#4f46e5">组合爆炸</text>
  <text x="40" y="252" font-size="11" fill="#374151">撤销 = 改角色定义</text>
  <text x="40" y="276" font-size="11" fill="#4f46e5">一条 grant 行搞定</text>
</svg>

## 8. 自研的代价与优势

| 坑 | 后果 | 状态（2026-11-20） |
|---|---|---|
| 1 判据在求值器、不在角色 | 审查者若以为「改角色定义 = 改授权面」，会漏掉真正决定放行的两样东西：`grants` 里 `source='role'` 的物化行，与主体派生链每一级的快照；绕过 `RoleGrantMaterializer` 手改 `grants`，或只改角色而快照未追平，都会出现「改了角色不动授权面」 | 设计如此：改角色/绑定走 `/api/v1/roles`、`/bindings` 与物化器；快照追平见坑 4 |
| 2 无显式 Deny | 写不出「永远不许」的绝对禁令；目前只有 HardGuard 的硬编码规则兜住关键路径 | 设计如此 |
| 3 拒了说不出理由 | 判定失败只有 WARN 日志（`policy/GrantAuthorizationService.java:119-121`），没有「哪一级缺哪个原子」的决策链 | explain 设计在办（task-110） |
| 4 三源快照不同步 | grants 行、binding 的 `permissionsSnapshot`、session 的 `agentPermissionsSnapshot` 三处副本；改了 grant 不追平快照，就会出现「改了没生效」或「撤了还在」 | 未动 |
| 5 撤销有延迟 | 能力原子走 `cp.capability-cache-ttl-ms`（默认 30000 ms）短 TTL 缓存，撤权最坏晚 30 s 生效 | 设计如此（可配） |
| 6 PEP 覆盖不全 | 42 个原子只有 7 个有工具面入口；`delete` 原子在工具链上不可达；Windows host 通道无 sandbox 也无 policy 门 | 已留证据（`internal/A03-xihe/evidence/2026-11-20-pep-coverage/README.md`），修法未裁 |
| 7 路径前缀边界语义 | `fs:` 声明键必须归一成物理身份再比（永不比字符串），`*` 通配仍交分层匹配器 —— 写错一处就是越界 | 设计如此 |
| 8 委派可能提权 | 会话档位放宽需「持有 `session:permission:configure` 原子 + 是会话创建者」；收紧任意参与者可做 | 已实现（`policy/SessionPermissionGuard.java:20-34`） |
| 9 原子目录膨胀 | 原子名与动作类持续演进（本仓已从十余条长到 42 条），新增原子没有强制流程 | 未动 |
| 10 缺模型分析工具链 | 没有 Cedar analyzer 一类的「证明无漏洞」手段，只能靠 golden 用例与人工审查 | golden 设计在办（task-110） |

优势（选中自研的正面理由，逐条可核）：

- **判据面窄且可机械核**：一次判定的输入是 `(principal, actionClass, resource)` 三元组，容易铺 golden 基线。
- **零额外基础设施**：不引 sidecar、不引策略分发服务；判定与 grants 在同一库同一事务边界内。
- **离线可跑**：判定无外部调用，单测能覆盖全判据面，不需要先搭一个策略服务。
- **撤权同源**：`tv` epoch、角色物化、快照三件都在 CP，撤销不依赖下游传播窗口。
- **演进自由**：新增动作原子只改 `PermissionAtomCatalog` 与分类规则，不必迁移策略语言或改引擎版本。

## 9. 换型阈值与三件机制

| 触发条件 | 门槛 | 换型动作 |
|---|---|---|
| grants 行数 | 超过 2000 行 | 先补 explain 与 golden，再评估外部引擎 |
| 角色数 | 超过 50 个角色 | 同上 |
| 需要模型级证明 | 任一条「无漏洞」要被形式化证明 | 引入 Cedar / AVP 一类引擎 |
| 出现第二个非租户维度 | 例如按时间窗、按审批流的策略维度 | 重新定名（不再是两轴交集），并重评阈值 |

| 机制 | 作用 | 现状（2026-11-20） |
|---|---|---|
| explain（决策链解释） | 说清「哪一级命中、哪一级缺哪个原子」 | **已落地（task-125 / DSD-1497 机制①，2026-11-20）**：`POST /api/v1/authorization/explain`，与判据共用一个内核，判据见本篇 §10 |
| golden（判据回归基线） | 固化的三元组到 ALLOW / DENY 用例集 | **已落地（task-110 / DSD-1497）**：`packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/policy/authz-golden-baseline.json` 59 行（放行 30 / 拒绝 29），`AuthzGoldenBaselineTest` 逐行裁决；task-125 起 explain 对同一 59 行复算 |
| PEP 清单 | 哪些工具面与通道真的连了判据 | 已产出证据（`internal/A03-xihe/evidence/2026-11-20-pep-coverage/README.md`） |

## 10. 可解释性：explain 面（DSD-1497 机制①，task-125）

「为什么这次被拒」在 XH 不是靠读日志猜，而是有一个只读端点当场回答：`POST /api/v1/authorization/explain`，请求 `{actionClass, resource, sessionId?}`，响应 `{allowed, deepestMissingLevel, missingAtom, missingLevels[], matchedGrantRefs[], evaluatedLevels[]}`。

### 10.1 一条判据，两副面孔

explain 不是第二套判据。`GrantIntersectionEvaluator` 里只有一个 `decide(request, levels, record)`：

- 授权实际调用的是 `allows(...)` ≡ `decide(..., record=false).allowed()`；
- explain 是 `explain(...)` ≡ `decide(..., record=true)`（同一份守卫、同一套 `matchesResource`、同一次交集扫描，只是顺手把命中行与缺失级记下来）。

为什么值得为此改内核而不是在控制器里重算：重算就是第二份判据，两份判据分叉时「explain 说放行、真实调用被拒」会变成一个永远查不清的 bug。防分叉的证据是 `ExplainMatchesGoldenBaselineTest` —— 它把基线里 49 条 gate=intersection 的行逐条同时喂给 `allows` 与 `explain`，断言两侧结论逐行相同，并要求放行行 `deepestMissingLevel = -1`、`missingAtom = null`、`matchedGrantRefs` 非空。

### 10.2 字段怎么读

| 字段 | 含义 | 判读要点 |
|---|---|---|
| `allowed` | 与真实放行同一个布尔 | 被拒也是 HTTP 200（端点已回答问题，不是端点失败） |
| `deepestMissingLevel` | 缺失级里索引最大者，`-1` = 放行 | 也算「求值前就被拒」（见 `missingAtom.reason`） |
| `missingAtom` | 最深的那条缺失（放行时为 null） | 带 `reason`：`level-without-grants`（该级根本没有 grants）与 `no-matching-atom`（有 grants 但都不覆盖）是两回事，这正是可操作的那一半信息 |
| `missingLevels[]` | 所有缺失级 | 多级同时缺时不会只告诉你最深那条 |
| `matchedGrantRefs[]` | 真正授权的那些行 | 每条带 `grantId` 与 `grantSource`（role / template 等），可回查到来源 |
| `evaluatedLevels[]` | 每个被扫过的级 | 带 `atomCount` 与 `matched`：`atomCount=0` 与「有原子但不匹配」在这里能区分开 |

`reason` 词表：`empty-request` / `empty-principal-path` / `no-subject` / `unknown-action-class` / `blank-resource` 属求值前的拒绝；`level-without-grants` / `no-matching-atom` 属级内拒绝。

### 10.3 能力原子不在 explain 面

`actionClass` 只接受动作类词表（`ToolFaceRegistry.builtinActionClasses()`）。把能力原子当 `actionClass` 传（例如 `instance:admin`）会在任何级被扫之前被拒，返回 `allowed=false` + `reason=unknown-action-class` + `deepestMissingLevel=-1`。这是刻意的：能力原子不在交集里求值，explain 若假装能解释它就是编答案。

### 10.4 暴露边界

- **主体不可选**：subject 取 `TenantContext` 的当前用户，不是请求字段 ⇒ 结构上无法解释他人，响应里也只可能出现调用者自己路径上的 grant 行（id + 来源），不含他人 grants、成员名单或资源细节。
- **不写任何东西**：不落行、不缓存（DSD-1497 M2-10a 禁求值侧缓存）、响应体不进审计明细（审计只留 requestId）。
- **scope**：`sessionId` 可选，用于把请求放进该会话的 workspace 上下文，且必须对该调用者可读（否则 404 `SESSION_NOT_FOUND`，与其他会话读面同样是「不区分」式 404，不做存在性探针）；不带则用当前 workspace 上下文。
- **租户门**：面本身非 GET，但写门分类器不把 `/api/v1/authorization/**` 视为工作区写面 ⇒ 任何已解析出 workspace 成员身份的角色都过；没有 workspace 上下文的调用者会被租户门挡在 `403 WORKSPACE_FORBIDDEN`，与其它非豁免路由一致。

### 10.5 源码锚点

| 位置 | 作用 |
|---|---|
| `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy/GrantIntersectionEvaluator.java` | 唯一内核 `decide` + `allows` / `explain` 两副面孔 + `GrantExplanation` 一带记录 |
| `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy/RequesterAuthority.java` | `explainForUser` 装配用户路径；`allowsForUser` 就是它的 `.allowed()` |
| `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy/AuthorizationExplainController.java` | HTTP 面（`POST /api/v1/authorization/explain`）与 wire 形状 |
| `packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/policy/ExplainMatchesGoldenBaselineTest.java` | 59 行基线与 explain 的对齐证明 |
| `packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/policy/GrantExplanationKernelTest.java` | 六类缺失面（交汇 / 父链两级 / fs 前缀 / instance-only / 能力原子 / 空 grants）的级号与 reason 断言 |
## 11. 会话级临时能力令牌（task-124 / DSD-1509 ②）

- **一句话**：交集授权只有这一处显式例外——一张按**叶子会话**键控的临时表，把有限几个 `(actionClass, resource)` 在**这一个会话里**变成可达；它不是第六个求值层，而是在那几对上**替代**「每一级都要持有」的判断，其余动作类照常逐级求交。
- **为什么需要它**：DSD-1500 R2 把 exec 从 `AGENT_USER`（实例级）与 `WS_EDITOR`（工作区级）同时撤掉，而会话快照在创建时冻结，旧会话无法事后补原子；没有这条令牌，「已在跑的会话需要一次性执行」就只剩「给主体常驻 exec」一条路，等于把 DSD-1500 撤掉的东西装回去。
- **判定怎么参与**：`GrantAuthorizationService.allows` 构造完 `permissionPath` 后追加 `liveSessionTokens(...)`（按 `request.sessionId()` + 解析出的 leaf principal + workspace 三键直读），`GrantIntersectionEvaluator.decide` 在 `actionClass × resource` 循环里先查令牌：命中即跳过逐级扫描（explain 记为 `level=-1`、`levelLabel=session-token`），未命中仍走原三重循环；资源匹配仍是 `matchesResource`，`fs:` 声明键前缀语义不绕过。
- **为什么没有缓存与定时任务**：活跃性就是 SQL 谓词（`revoked_at IS NULL AND expires_at > now()`）；`cp.capability-cache-ttl-ms` 只缓存主体系能力，不缓存这张表 ⇒ 撤销与过期都在下一次判定立即生效。
- **写面三道门**（`SessionTemporaryGrantService.issue`）：会话创建者（`sessions.user_id`）+ 在该工作区持有 `session:permission:configure` + 子集门（每个原子都要被调用者在该工作区持有的同 actionClass 原子覆盖，`fs:` 按根内前缀比较；能力原子一律拒绝）。TTL `[60, 28800]` 秒、默认 900，越界 400 而非静默截断。
- **读面与撤销面**：读与撤销都不设新原子——任一能读该会话的人（创建者或已邀请的人类）都可读列表、可撤销（与 tier 面「收紧不需要额外授权」同口径）；撤销只写 `revoked_at`/`revoked_by_user_id`，重复撤销或撤销他人会话的行一律 404 `TEMPORARY_GRANT_NOT_FOUND`。读不到该会话的人先拿 404 `SESSION_NOT_FOUND` 再看创建者判定，**不把 403 当作存在性预言**。
- **生命周期**：`session_temporary_grants`（V180）的 `session_id` 外键 `ON DELETE CASCADE`，会话删行即清；撤销打 `revoked_at` 而不删行（审计留痕）。审计动作 `session.temporary_grant.granted` / `session.temporary_grant.revoked`。
- **边界**：只对 leaf 会话生效（祖先、子、兄弟会话都不继承）；主体必须是该会话自己的 PRIMARY agent principal，绝不由调用方指定；`source=session_temp` 不进 `GrantSources.EVALUATION_SOURCES`（它读的是另一张表），只用于 explain 归因。
- **源码锚点**：`policy/SessionTemporaryGrantService.java`、`policy/SessionTemporaryGrantStore.java`、`policy/SessionTemporaryGrantController.java`、`resources/db/migration/V180__dsd1509_session_temporary_grants.sql`、`policy/GrantIntersectionEvaluator.java`（`allows(…, sessionTokens)` / `explain(…, sessionTokens)`）。

## 12. 读者地图

| 你要做的事 | 读哪里 | 本篇的角色 |
|---|---|---|
| 看授权契约本身（输入、步骤、错误码） | `spec/security/authorization.md` | 本篇给判据理由，不复述契约字段 |
| 看认证与 token 路径 | `A03-xihe/docs/i18n/zh-Hans/DEV-024-authentication-and-security.md` | 本篇只讲第 1 步 |
| 看 CP 架构里的策略子系统 | `A03-xihe/docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md` §8e、§8e-2 | 本篇补「为什么这样设计」 |
| 查术语该写哪个词 | `A03-xihe/docs/i18n/zh-Hans/DEV-032-terminology.md` | 本篇是词条的依据文档 |
| 审 PEP 覆盖或换型 | 本篇 §5、§8、§9 | — |
| 查「为什么这次被拒」怎么回答 | 本篇 §10 与 `A03-xihe/docs/api/openapi.yaml` 的 `explainAuthorization` | 本篇给判据理由，契约字段以 OpenAPI 为准 |
