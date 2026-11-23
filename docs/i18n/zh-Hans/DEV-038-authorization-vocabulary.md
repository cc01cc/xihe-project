---
title: DEV-038 - 授权词汇类型学
category: dev-guide
sidebar_order: 38
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-11-22
updated: 2026-11-22
description: XH 授权词汇的四层类型学：42 个动作原子、3 个能力原子、11 个内置授权预设与资源族。每层给出「是什么 / 从哪读 / 求值期是否读」与设计理由，并标注 ORG_LEADER 仅有注释、没有种子。
tags:
  - authz
  - policy
  - security
  - terminology
---

# DEV-038: 授权词汇类型学

> 定位：本篇只回答「授权词汇有哪几层、每层是什么、从哪里读、求值期读不读」。判据本体、求值链与 scope 语义在 [DEV-037](DEV-037-authorization-model.md)，本篇不复制。
> 词汇口径：对外主名是 **授权预设 / grant preset**；旧词只在本篇 §4 作为历史名说明一次，不作为对外名称。
> 事实口径：源码按 2026-11-22 的 `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/` 核对；证据等级沿用 `fact-verification` 的 [实测] / [源码]。

## 1. 一张表看完四层

| 层 | 当前数量 | 判据职责 | 求值期是否读 | 权威来源 |
|---|---|---|---|---|
| 动作原子 | 44 | 判据单位（`actionClass × resource`） | 读，逐级求交 | `policy/PermissionAtomCatalog.java` |
| 能力原子 | 3 | 入口闸（管理面准入） | 读，但不进交集 | `policy/PermissionAtomCatalog.java`、`policy/AuthzContext.java` |
| 授权预设 | 11（8 个基础 + 3 个执行档） | 物化包（把原子写进 grants） | **不读** | `policy/SystemGrantPresetCatalog.java` |
| 资源族 | 6 个已登记命名空间（另有裸形态，见 §5） | 第二轴（前缀匹配的目标） | 读，做前缀覆盖 | `policy/ResourceIdentity.java`、`policy/ToolFaceRegistry.java` |

一句话：**求值只读动作原子、能力原子（入口闸）与资源；授权预设只在写入期被物化成 grants 行。**

## 2. 动作原子（44）

**是什么**：授权判据的最小单位，代码形态是 `PermissionAtom(actionClass, resource)`。44 个动作原子是闭集，名字定义在 `PermissionAtomCatalog.ACTION_ATOM_NAMES`；每个原子还带一个 `scopeClass`：`instance` 表示只能绑在实例档，`both` 表示实例档与工作区档都可绑。该类别由 `INSTANCE_ONLY_ATOMS`（16 个）派生，不另设 `ActionScope` 类型。

**从哪读**：

- 原子清单：`policy/PermissionAtomCatalog.java` 的 `ACTION_ATOM_NAMES`（当前 44 个，[源码]）。
- scope 类别：同文件 `INSTANCE_ONLY_ATOMS`；不在名单内即 `both`。
- canonical resource：`PermissionAtomCatalog.actionResource`；默认 `*`，凭证类动作是 `credential:*`。
- 工具面到动作类的映射：`policy/ToolFaceRegistry.java`。

**求值期是否读**：读。请求的每个 `(actionClass, resource)` 都要在主体派生链的**每一级**命中；未知 `actionClass` 直接 fail-closed。

**为什么这么设计**：原子是**判据闭集**——可以枚举、可以逐条测试、可以在新增时审视影响面。若判据写成自由文本或预设名，新增一条权限就无法知道它和既有规则的交集，也无法用 golden 用例锁住。闭集还让「工具面映射」和「授权判据」分开：工具改名不影响原子名，原子扩张必须显式改目录。

## 3. 能力原子（3）

**是什么**：`instance:super`、`instance:admin`、`workspace:admin` 三个平台/工作区管理准入标记。它们回答「这个主体是不是管理员」，不是「能对某个对象做什么」。

**从哪读**：`PermissionAtomCatalog.CAPABILITY_ATOM_NAMES`；`policy/AuthzContext.java` 在认证期为当前主体解析出能力快照，并按 `cp.capability-cache-ttl-ms`（默认 30000 ms）短缓存。`instance:super` 蕴含 `instance:admin` 与 `workspace:admin`，`instance:admin` 蕴含 `workspace:admin`（`PermissionAtomCatalog.IMPLIES`）。

**求值期是否读**：读，但在**入口闸**读，不进入 `(actionClass, resource)` 的交集扫描。它们**不可物化**：`PresetGrantMaterializer.materializableAtom` 遇到能力原子返回 `null` 并跳过，因此永远不会出现在 `grants` 表里；也不能通过 grant 提交。

**为什么这么设计**：能力原子是**入口闸**。管理面的问题是「能不能进这个房间」，不是「能不能对这个资源做这个动作」。把 `instance:admin` 当成一条可授予资源，会让管理员权限变成可以由普通 grant 组合出来的东西；物化期直接剔除，保证它只能由预设/绑定在认证期推导。另一个必须点明的撞名：`workspace:admin` 是**原子名**，不是资源命名空间；资源串禁止 `workspace:` 前缀（见 [DEV-037](DEV-037-authorization-model.md) §5.1）。

## 4. 授权预设（11）

**是什么**：一组原子的命名集合，作用是把原子**物化**成 `grants` 行。对外主名是「授权预设 / grant preset」；历史文档与旧代码里的 `role` / 「角色」指的就是这一层，task-832 起对外不再使用该词，代码类名已改为 `GrantPreset`、`PresetGrantMaterializer`、`SystemGrantPresetCatalog`。

### 4.1 内置预设与原子数

| 预设 | 动作/能力原子数 | 域 | 说明 |
|---|---:|---|---|
| `SUPER_ADMIN` | 45 | 实例 | 全部 42 个动作原子 + 3 个能力原子 |
| `ADMIN` | 32 | 实例 | 用户默认集 + 凭证管理 + 实例管理面 |
| `USER` | 10 | 实例 | 注册默认集 |
| `WS_OWNER` | 17 | 工作区 | 工作区管理与编辑 |
| `WS_EDITOR` | 11 | 工作区 | 读写与工作区配置 |
| `WS_VIEWER` | 2 | 工作区 | 只读 |
| `AGENT_DELEGATOR` | 1 | 工作区 | 仅 `SPAWN_AGENT`，需显式绑定 |
| `AGENT_USER` | 6 | 实例 | agent 默认集（不含 exec） |
| `AGENT_READER` | 2 | both | 只读 agent 档 |
| `AGENT_WORKER` | 3 | both | 读写 agent 档 |
| `WS_RUNNER` | 2 | both | 显式执行档（exec + 工作区运行时） |

前 8 个是基础内置预设；后 3 个由 DSD-1500 增加，用来把「执行」从默认集里拆出来。两个数字与旧卡片不同，原因是 DSD-1500 的 exec 退役：`WS_EDITOR` 从 12 降到 11，`AGENT_USER` 从 7 降到 6（[源码] `SystemGrantPresetCatalog`）。

**从哪读**：`policy/SystemGrantPresetCatalog.java` 的 `presetSeeds()`；Flyway 迁移只做投影（V88 / V111 / V114 / V127 / V153 / V156 / V157 / V162 / V172 / V178 等），`DefaultSetMigrationParityTest` 保证代码目录与种子一致。

**求值期是否读**：**不读**。求值器只看 `grants` 行（`source='preset'` 的物化结果）与各级快照；预设定义本身不参与匹配。改预设定义不会自动改既有 grants，必须重新物化；快照不同步就会出现「改了没生效 / 撤了还在」。

**为什么这么设计**：预设是**物化包**，不是判据维度。判据要可枚举、可测试，所以留在原子层；预设只是「一次绑定一组常用原子」的便利封装。把它当判据会产生两个后果：预设定义一改，所有判定语义跟着变；新增一种组合就要造一个新预设。现在的形态让「组合」与「判据」分开：组合可以很多，判据始终是 42 + 3。

`ORG_LEADER` 当前**只有代码注释与迁移注释，没有种子行（M2-3）**；它不是可绑定预设，不得在 UI/文档里当成已可用项。

## 5. 资源族

**是什么**：资源是判据的第二轴，规范形态是「命名空间 + 值」的可前缀匹配串。当前有 6 个命名空间 + 裸形态，共 7 行：

| 资源族 | 形态 | 能进 grants | 求值期怎么用 |
|---|---|---|---|
| 文件声明键 | `fs:<workspaceId>[/<rel>]` | 能，且路径类只能写这个 | 展开成 `phys:` 比较物理身份 |
| 文件物理键 | `phys:<归一化绝对路径>` | **永不**；API 提交即 400 | 只在求值期由 `fs:` 展开 |
| 凭证 | `credential:<uuid>` / `credential:*` | 能 | 使用凭证必须具体 uuid |
| 技能 | `skill:<uuid>` / `skill:*` | 能 | 技能面按前缀匹配 |
| MCP server | `mcp:<canonicalServerId>` / `mcp:*` | 能 | 网关调用与对象资源同时求值；`*` 不覆盖 `mcp:` |
| 智能体单元 | `agent-unit:<ltree path>`（`/` 分段） | **不能**（`EVALUATION_ONLY`） | spawn 判据追加调用方自身单元子树；`tree` matcher 覆盖后代 |
| 裸形态 | 裸路径 / URL / `*` | `*` 能 | 交分层匹配器 |

**从哪读**：`policy/ResourceNamespaces.java` 是命名空间、matcher 与 canonicalizer 的单一注册表（task-830 建、task-870 增 `mcp:`）；`policy/ResourceIdentity.java` 解析 `fs:` / `phys:`；`PermissionAtomCatalog.actionResource` 给默认 `*` 与凭证类 `credential:*`。登记与 matcher 口径见 [DEV-037](DEV-037-authorization-model.md) §5.1，`mcp:` 的通道闸语义见 §5.5。

**求值期是否读**：读，且是唯一的第二轴。`fs:` 两侧都展开后比物理身份，绝不回退成字符串比较；`credential:*` 只表示管理面的宽口径，不能替代 `credential_use` 的具体 uuid。

**为什么这么设计**：资源是**可前缀匹配的第二轴**。判据若只有动作，无法表达「只允许这个目录子树」；若把目录、工作区、组织路径都塞进资源串，资源身份会随上下文漂移。所以只把「对象身份的一部分」放进资源串，工作区与组织树留在 grant scope / visibility scope（见 DEV-037）。`workspace:` 与 `session:` 禁止作为资源命名空间——它们是上下文，不是对象。

## 6. 为什么是这四层

| 层 | 设计职责 | 如果合并到别的层会怎样 |
|---|---|---|
| 动作原子 | 判据闭集 | 判据变成开放集合，无法枚举与测试 |
| 能力原子 | 入口闸 | 管理员准入被当成可授予资源，组合即可提权 |
| 授权预设 | 物化包 | 改组合就改判据语义，预设数量爆炸 |
| 资源 | 第二轴 | 只有动作，无法表达对象范围 |

四层各管一件事：**原子决定「能不能做」，资源决定「对哪个对象」，能力原子决定「能不能进管理面」，预设决定「一次给哪些原子」**。求值链只读前三层中的原子与资源；预设是写入期的搬运工。

## 7. 读法与边界

- 判据、九步求值链、scope 语义与换型阈值：[DEV-037 授权模型（交集授权）](DEV-037-authorization-model.md)。
- 术语该写哪个词：[DEV-032 术语规范](DEV-032-terminology.md)。
- 授权契约的输入、步骤与错误码：`spec/security/authorization.md`。
- 本篇不定义 scope，也不复制资源匹配算法；出现分歧时以 DEV-037 与源码为准。
