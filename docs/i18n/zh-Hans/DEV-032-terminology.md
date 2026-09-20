---
title: DEV-032 - 术语规范（一词多义与多词一义）
category: dev-guide
sidebar_order: 32
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-09-16
updated: 2026-09-17
---

# DEV-032: 术语规范（一词多义与多词一义）

> **定位**：XH 文档与未实施 PLAN 的**用词 SSOT**。解决两类问题：① 同一裸词多义 → **分义正名**；② 同一概念多词 → **单正名 + 别名表**。
> **适用**：`plans/PLAN-*-XH-*`（草稿与未开工包优先；已完成包仅在被再次编辑时对齐）、`A03-xihe/docs/`、项目 `AGENTS.md` 叙述。归档与 review 历史记录**不回写**。
> **不适用**：OpenAPI 路径字面、已合并且行为锁死的代码标识符（改名走独立 PLAN）。

## 0. 总规则

1. **裸词禁止歧义**：下列「一词多义」表中的词，**禁止无前缀单独使用**指向非正名义项。
2. **一概念一正名**：叙述与新任务标题用**正名**；别名可括注一次，不得当第二正名扩散。
3. **ID 不改**：`M-2`/`M-3`/`CTX-1`/`P0-5` 等 backlog ID 保留；ID 旁可附正名。
4. **中英成对**：中文行话与英文正名成对出现一次（见 §2），避免只写「收口」不说明 seam。
5. 新 PLAN README 建议加一行：`> 术语按 DEV-032。`

## 1. 一词多义 → 分义正名

| 冲突裸词 | 义项 | **正名（必须用这个）** | 禁止写法 | 备注 |
|---|---|---|---|---|
| **owner** | A. workspace **权限角色**（成员 owner/admin） | `workspace 角色 owner` 或 `角色=owner` | 裸 `owner` 指 lease | 与 RBAC 一致 |
| | B. 生命周期 **执行租约持有者** | **`execution lease holder`**（中文：**执行租约持有者**；可缩写 **lease holder**） | 裸 `owner`、`active owner` 无 lease 上下文 | PLAN-0345 起；「单 active owner」→「**单 execution lease holder**」 |
| | C. **资源归属**（连接、工作区、会话挂在谁名下） | **`资源归属 owner`**（英文：*resource owner*；字段写 `owner_type` / `owner_id`） | 用裸 `owner` 指归属；把归属与「workspace 角色 owner」混用 | 连接归属 ≠ 成员角色；目标态 `owner_type` 可含 `AGENT`（见 §1.1） |
| **role** | A. 平台身份 | **`平台角色`**（*platform role*，值 `ADMIN` / `USER`，来自 JWT `role` claim） | 裸 `role` 指 workspace 角色 | 判定入口 `@PreAuthorize`；见 §1.1 |
| | B. workspace 内身份 | **`workspace 角色`**（值 `OWNER` / `MEMBER`；`ADMIN` / `VIEWER` 为悬空枚举值，未落库） | 裸 `role` 指平台角色 | 见 §1.1 与 backlog「身份与权限模型」 |
| **L1 / L2 / L3** | 上下文注入槽 L0–L3 | **`context L1`**（中文：**上下文 L1 槽**） | 裸 `L1` | 0340 模型 |
| | 诊断分层 L0/L1/L2 | **`diagnostic L0` / `diagnostic L1` / `diagnostic L2`**（中文：**诊断 L0/L1/L2**） | 裸 `L1` | 0342；L1 工具族后置 |
| | checkpoint 恢复层 L1/L2/L3 | **`checkpoint L1`** 等（中文：**检查点 L1 层**） | 裸 `L1` | 0338 |
| **resume** | A. 会话 / ChatRun 恢复 | **`run resume`**（中文：**run 恢复**） | 裸 `resume` 指 unpause | 既有 chat 语义 |
| | B. 工作区从 `paused` 回到可用 | **`unpause`**（中文：**解除暂停**） | 裸 `resume` 指 workspace；`恢复消费者` 作唯一正名 | 见 §2 unpause 路径 |
| **job** | 现行后台任务 | **`durable job`**（中文：**持久后台任务**） | 混指已删表 | 0344 |
| | 历史表 | **`runtime_jobs`（历史，已删除）** | 当作现行 job | 0326 已删 |
| **snapshot** | 现行写前恢复点 | **`checkpoint`**（中文：**检查点**） | 活动文档用 `snapshot` 表恢复点 | 0356/0357 已切换 |
| | 遗留机制 | **`legacy snapshot`**（仅历史/退役叙述） | 与 checkpoint 混用 | 0357 |
| **收敛 vs 收口** | 多路径 → 单一权威状态/写路径 | **收敛（converge）** | 用「收口」指状态机双路径合并 | Registry/状态机 |
| | 散入口 → 唯一 seam 出口 | **收口（route-to-seam）** | 用「收敛」指 REST 改走 executor | REST 文件面 |

### 1.1 主体与角色（2026-09-17 增补）

XH 目标形态是**多主体协作**：Agent 是独立主体（有自己的账户与角色权限），与开发者**协作**，**不绑定某个 user**。**协作 ≠ 委托**——「Agent 代表某 user 执行」不是目标模型；若确需受托，另立显式 *delegation* 概念。

该段描述的是目标模型。当前 user-only schema 与独立 Agent principal 仍存在实现差距，认证、principal、授权、能力策略、审批和审计的统一契约见根级 `spec/security/`（PLAN-0386，当前为 proposed）。

| 术语 | 正名 | 取值 / 说明 | 禁止写法 |
|---|---|---|---|
| 主体 | **principal** | `human`（开发者/用户）、`agent`（独立账户与角色）、`service`（CP/Agent/Runtime 内部管道，非协作者）；`system` = 平台自身触发，非可登录主体 | 把 Agent 说成「代表 user 的 actor」；用 `user` 泛指 principal |
| 成员 | **membership** | `principal × workspace + 角色`；Agent 与开发者同为 workspace 成员 | 把成员表/字段永久写死为 `user_id` |
| 角色 | **平台角色 / workspace 角色** | 见 §1 `role` 两义 | 裸 `role` 不带域 |
| 归属 | **资源归属 owner** | `(owner_type, owner_id)`；目标态可含 `AGENT` | 与「workspace 角色 owner」「execution lease holder」混用 |

历史形态（不阻碍目标，但新代码不得加深）：`sessions.user_id`、`workspace_users.user_id`、`provider_connections.owner_id` 均为 user-only 形态；`ledger_operations.actor_type`（表名历史形态 `session_operations`，V33 改名）已含 `agent`（`V2`），方向一致。

不偏离约束与落地入口：workspace internal `xh-backlog-and-debt.md` 的 BL-18「身份与权限模型」（不入库分发）。

## 2. 多词一义 → 正名与别名

### 2.1 仍存活、待统一（未实施/实施中 PLAN 按正名写）

| 概念 | **正名** | 别名 / 旧说法 | 归属与状态 |
|---|---|---|---|
| 确保执行环境就绪（契约动词） | **`ensure`** | `物化`、`provision`（0329 散文） | 0329/0345；**测试与不变式用 ensure** |
| 同一 workspace 异步就绪的 **HTTP 路径** | **`materialize`（API 名）** | 不可用 ensure 替换 **URL 路径字面** | CP `POST .../materialize`；叙述：「触发 ensure（API：materialize）」 |
| 同 workspace 并发 ensure 合并为一次 | **`ensure single-flight`** | **M-3**（ID）、物化并发去重、并发去重 | 0345；ID `M-3` 保留，正文首现写 `M-3（ensure single-flight）` |
| 裁剪窗口外旧工具输出 | **`prune`** | mask、遮蔽、工具结果截断、`HISTORY_TRUNCATION` 职责 | 0341 归一中；20 条=装配层熔断，不叫 prune |
| 溢出后的规则分节摘要 + 一次重跑 | **`compaction`（压缩）** | 自动摘要、收缩（广义可含 prune） | 0341；**收缩**= prune∪compaction 的总称时需写明 |
| 使 `paused` 回到可用的代码路径 | **`unpause 激活路径`** | 恢复消费者、resume 消费者、resume consumer | 0345 M-2；「有 unpause 激活路径」替代「有恢复消费者」作验收句 |
| 绕过 executor 直连磁盘 | **`executor-bypass`** | host FS 直连、裸 bypass | 0329 分类；叙述可用「executor-bypass（REST 直连 host FS）」 |
| 后台任务断线后续看 | **`durable job 续看`** | 输出持久化续看、job resume | 0344 |

### 2.2 已完成切换（活动文档只保留正名）

| 概念 | **正名** | 已废弃别名 | 依据 |
|---|---|---|---|
| 写前恢复点 | **checkpoint** | `revert_snapshot`、活动代码里的 snapshot 恢复点 | PLAN-0356 |
| 旧快照面 | **legacy snapshot**（仅退役叙述） | 与 checkpoint 混称 | PLAN-0357 |

### 2.3 易混但**不是**同义（禁止合并）

| 词 A | 词 B | 关系 |
|---|---|---|
| 单写者 ledger（0326） | ensure single-flight（M-3） | 账本单写 vs 实体只建一次 |
| ensure single-flight | chat `409 CHAT_IN_PROGRESS` | 沙盒就绪 vs 会话单并发 run |
| execution lease holder | workspace 角色 owner | 执行租约 vs RBAC 角色 |
| run resume | unpause | 会话恢复 vs 容器解除暂停 |
| 收敛 | 收口 | 见 §1 两行 |

## 3. 推荐搭配（中英）

| 场景 | 推荐整句骨架 |
|---|---|
| 生命周期 | 「Runtime 经 **ensure** 保证执行环境就绪；CP 对外路径名 **materialize**。」 |
| 并发 | 「同 workspace **ensure single-flight（M-3）**，仅一次实体创建。」 |
| 租约 | 「至多一个 **execution lease holder**；destroy 后 lease 失效。」 |
| 暂停 | 「`paused` 须存在 **unpause 激活路径**，禁止无文档重建。」 |
| REST | 「REST 文件面 **收口到 executor**，消除 **executor-bypass**。」 |
| 上下文 | 「**context L1 槽** 注入；**diagnostic L1** 后置。」 |

## 4. 实施与追溯

| 阶段 | 动作 |
|---|---|
| 本文档发布（2026-09-16） | 未实施 XH PLAN README/spec 按 §1–§3 对齐；完成包不强制回写 |
| 2026-09-17 增补 | 新增 §1.1（principal / membership / 协作≠委托）、`owner` 第三义（资源归属）、`role` 分域；未实施 PLAN 与 docs 按新正名；实现归 backlog BL-18（不实施） |
| 已完成 PLAN / archive / review | **不改**历史证据用词；再次编辑该文件时顺带对齐 |
| 代码标识符 | 不在本文档批量改名；需改名另开 PLAN（参考 0356） |

## 5. 关联

- 契约层正名 `ensure`：DEV-031、PLAN-0329
- 生命周期 lease / unpause：PLAN-0345 `spec/workspace-lifecycle.md`
- 主体/成员/归属与 Agent 主体化：workspace internal `xh-backlog-and-debt.md` BL-18（不入库分发）
- prune / compaction：PLAN-0341
- checkpoint 命名：PLAN-0356
- 文档布局：DEV-030
