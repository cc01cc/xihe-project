---
title: DEV-036 - 在 DSH 上跑 XH Lead 工作流
category: dev-guide
sidebar_order: 36
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-11-20
updated: 2026-11-20
description: XH 交付线在 DSH（DeepSeek Harness）上的 Lead 编排规范：三个角色、两条硬边界、派工四步、卡面模板、chief-1 提交、巡检自我校准、验收假绿形态、复用清单。全部条目来自 2026-11-20 那次会话的实证。
tags:
  - workflow
  - orchestration
  - lead
---

# DEV-036: 在 DSH 上跑 XH Lead 工作流

本文是 **XH 项目在 DSH 上的 Lead 编排规范**：Lead 只拆任务与裁定，派工走卡板执行体，提交走提交执行体。

**为什么不写进 `.agents/skills/`**：这里的每条机制都绑在 DSH 的 teammate 原语（`team_task_*` / `send_message` / `list_agents` / `schedule_create`）与其会话模型（durable teammate 可中途 steer、一次性 subagent 不可寻址、后台 job 完成不唤醒）上，属于**XH 在 DSH 上的编排形态**，不是跨项目通用规则。Kilo / Codex / OpenCode / Claude Code 上的编排按 workspace 根池 `.agents/skills/subagent-orchestration/` 执行；DSH 机制事实正文见 `internal/A03-xihe/docs/orchestration-primitives-dsh.md`。

**本文与既有文档的关系**：角色分层与工位命名以 `A03-xihe/.agents/skills/team-roles/SKILL.md` 为准（本文不重复工位定义）；轮询判据以 `internal/A03-xihe/docs/xh-monitor-protocol.md` 为准（本文只讲"怎么用"）；交接档契约以 `scripts/validate-handoff.mjs` + `scripts/handoff-contract.json` 为准。**本文只补"Lead 这一侧该怎么动作"，不复制上述三处的判据本体。**

## 1. 三个角色与两条硬边界

角色三分：Lead 负责拆任务与裁定，squad-1 负责卡板与派工，chief-1 负责提交，实施成员按领域固定席位接卡干活。

| 角色 | 职责 | 不做什么 |
| --- | --- | --- |
| Lead | 拆任务、定写域、解决依赖、审 diff、裁定口径、落 DSD/Q&A/inflight 记录、最终答复用户 | 不亲自写实现、不改业务代码、不跑长循环 |
| squad-1 | 维护卡板、建卡与派工、跟踪在办项、把"派了几件活"与"建了几张卡"对齐 | 不做技术裁定、不实施 |
| chief-1 | 按指定路径与消息文件执行 `xh-commit.mjs`，回报提交 sha 与守卫输出 | 不改文件内容、不自行决定提交范围 |
| 实施成员 | 按卡面 write_scopes 与验收口径落改动，留工作树不改 git，回报真实门读数 | 不提交、不碰卡面之外的路径、不越界改他人 WIP |

**硬边界 1：Lead 不亲自实施。** 用户 2026-11-20 两次明令「你是 XH & DSD LEAD 不要亲自实施细节」。允许 Lead 亲自动手的只有三类：审 diff、裁定口径、写持久记录（DSD 条目、当日 Q&A 档、`internal/A03-xihe/handoff/inflight.md`）。判据是"这件事产出的东西会不会直接进 develop"——会，就必须派出去。

**硬边界 2：Lead 不陷入长循环。** 禁止 `wait_agent` 干等、禁止 `job_output(wait:true)` 长超时、禁止 `Start-Sleep`、禁止无用户输入的自动推进（workspace `AGENTS.md:213` 与 `:216`）。等待一律交异步回报 + `schedule_create` 到点自查；每轮结束按「谁在跑 / 等什么信号 / 下一步动作」三块分列，每块 1–3 条，不得混成一行（混写会把待用户裁定项埋进句尾）。

## 2. 派工四步（缺一步就不算派工）

派工是四步而不是一步：只建卡不启动、只发消息不建卡，两种都会让活空挂。

1. **建卡** `team_task_create`：subject 带 `task-NN · ` 前缀便于追溯；description 含验收口径与不做项；`write_scopes` 写真实目录前缀；有前置就写 `blocked_by`。
2. **归属** `team_task_update(action:"reassign", owner:"<成员名>")`。**这一步不启动 agent**——实证 task-22 reassign 后成员一直 `inactive`，卡空挂约 20 分钟，最后是 monitor 的"编排利用率 20%"把这件事揪出来的（协议 §5.1 第 ④ 问）。
3. **唤醒** `send_message` 带 task id + 自包含 brief：背景、已实锤事实（带 `文件:行`）、范围与不做项、验收判据、纪律、回报格式。brief 不引用 Lead 上下文里的"上面说过"——成员看不到。
4. **解锁** 收活时若前置已完成，必须 `team_task_update(action:"set_dependencies", blocked_by: [])` 手动清空。**completed 前置不会自动清 blockedBy**——实测 task-15 前置都已完成后 `ready` 仍为 `false`，卡面上没有任何提示。

派工回执必须贴三件：task id、reassign 结果、send_message 确认。缺任一件就无法证明派工链完整——"我派了"不是证据。

另有一条不变量：**「派了几件活」与「建了几张卡」数字必须相等**（workspace `AGENTS.md:214`）。数字不等即违规，不需要解释。

## 3. 卡面必须写什么

卡面是成员唯一的信息来源，缺一项就会变成来回问答。

| 字段 | 要求 | 反例 |
| --- | --- | --- |
| subject | `task-NN · <对象> · <动作>`，一眼看出归属与目标 | 「修一下文档」 |
| 来源 | 谁在什么时候提的什么问题，带用户原话或任务 id | 「上面说的那个」 |
| 验收口径 | 编号判据：正 1 / 正 2 / 反 1 / 反 2，每条可执行 | 「确保质量」 |
| write_scopes | 真实目录或文件前缀，禁通配符 | `A03-xihe/**` |
| 不做项 | 明确禁止越界的事（禁 git 写 / 禁装依赖 / 禁起服务 / 禁碰他人 WIP） | 留空 |
| 回报格式 | 一句话结论 + 证据路径 + 门真实 exit code + 改动清单 | 「完成后告诉我」 |

**铁律**：自称"通过"但没给真实 exit code 与命令原文的回执，一律退回重报。判据不是"他说绿了"，而是"我照抄他给的命令能复现同一个 exit code"。

## 4. 提交由 chief-1 执行，Lead 只复核

提交是独立环节：成员留工作树不改 git，Lead 审 diff 与自跑门，chief-1 只执行原语提交。

流程四步：成员交付工作树改动 → Lead 逐文件核 diff（只认文本与注释改动，断言强度与期望值不得被削弱）→ Lead 自跑门并记读数 → chief-1 写消息文件并调 `xh-commit.mjs` → Lead 复核提交回执里的 sha、parent、文件清单。

机制要点全部来自 `internal/A03-xihe/scripts/xh-commit.mjs` 的 `HELP`（`:150-210`），每一条都对应一次真实事故：

| 要点 | 判据 | 依据 |
| --- | --- | --- |
| 消息必须走文件 | 不认 `-m`，必须 `--message-file <绝对路径>` | `xh-commit.mjs:178` |
| 首行宽度 | ≤72 列（CJK 记 2 列），禁 emoji、禁以句号结尾 | `A03-xihe/scripts/check-commit-msg.mjs` 头部实测：近 100 条中位 85 列、p90 114 |
| body 段名 | 只用白名单段名；`node xh-commit.mjs --msg-diff-labels` 直接打印两组段名 | 守卫 ⑦′（`:218-248`），非白名单段会打 `BODY_NO_CHANGE_SECTION` |
| body 路径 | 写仓库根相对路径，不写带仓前缀的路径 | 守卫 ⑦′ 对账按本条 diff 判 |
| 目标仓与分支 | one=`.` + `main`；A03=`A03-xihe` + `develop`；A12=`A12-DSH-decision` + `main`；A01 与 FB02 是 `develop` | 各仓 `git rev-parse --abbrev-ref HEAD` 实测（2026-11-20） |
| 删除与移索引 | 删文件用 `--delete`，只移索引保工作树用 `--drop`（须显式 `--repo`） | `xh-commit.mjs:171-175` |
| 声明文件数 | `--expect` 必须等于实际涉及文件数（含 move 展开） | `xh-commit.mjs:179-180` |
| 取退出码 | 禁走管道——管道读到的是 `tail` 的 0 | 同族实测：`cmd \| tail` 恒 0 |
| 绝对禁止 | `git reset` 任何形式、`checkout --`、`clean -fd`、目录级暂存、`push` | workspace `AGENTS.md` §Git 操作约束 |

`xh-commit.mjs` 是十三条守卫的 CAS 原语：消息门禁 ⑦ 物理上最先跑（`commit-tree` 不触发任何钩子，所以门禁只能由原语自检），其后是临时索引隔离、空提交拒绝、CR 归一、祖先证明、三重校验、gitignore 预检、嵌套仓拒绝、直提与窗口判定。**它没有绕过开关**——能事前拦的不要事后补。

## 5. 巡检与自我校准

轮询是三层节拍，不是一条定时器：轻量 `*/10`、监督 `*/30`（10 问必答）、每小时 `:07` 回溯。

三条 prompt 逐字取自 `internal/A03-xihe/docs/xh-monitor-protocol.md` §5.0 / §5.1 / §5.2，**每条都必须写自删除条件**（否则会话结束后定时器还在跑）。另配 `create_goal` 的 objective 重臂，让自动续轮有边界。

读数纪律（每条都踩过）：

- `xh-monitor.mjs` 的退出码是 `warnings>6 ⇒ exit 2`（`xh-monitor.mjs:60`，实现唯一一份在 `lib/lane-signals.mjs`）⇒ **exit 2 不等于"没跑成功"**，要看输出完整性再判读。`--retro` 是全量扫描，本轮实测单次可能超过 120 秒，跑它要给足超时。
- `cpBuild` 有**两套词表不可互推**：`verdict` 是 commit 维度、`treeVerdict` 是子树维度（`xh-monitor.mjs:160`）。`verdict=behind` 而 `treeVerdict=equal` 表示"提交号落后、CP 子树内容没变"，这是**唯一可降级**的组合（`:3232-3248`）⇒ 能当"当前 CP 内容是否最新"口径的是子树那一层，不是 commit 那层。
- 编排利用率算不出时写 `unknown` + 原因，**不是 0%**（协议 §5.1 第 ④ 问）：板龄不可信、板上无 running 槽都属这一类；把 `unknown` 读成 0% 会凭空造出 P1。
- `.tmp` 欠账与可重建缓存分开报：可重建缓存（`target/`、`node_modules`、构建产物）不算欠账，混在一起报会让真实欠账淹没在噪音里。

自校准：每轮结束按三块分列（谁在跑 / 等什么信号 / 下一步动作）。"我盯着等结果"是空转占位，算编排事故（workspace `AGENTS.md:216`）。

## 6. 验收纪律：本会话实证的假绿形态

绿是"可复跑命令 + 真实 exit code"，不是"看起来对"。以下六种形态本次会话全部出现过。

| 形态 | 实例 | 正确做法 |
| --- | --- | --- |
| 单类测试绿 ≠ 整包绿 | CP 单类 `76/0/0` 通过而整包红 | 报"哪一类、多少例"，不报"测试通过" |
| mock 端点桩兜住不存在的前端调用 | UI 打 `/sessions/{id}/tier` 而 CP 无此路由，mock 用 `suffix === "/tier"` 兜成绿（task-77） | 新增前端调用必须在真栈或 OpenAPI 里找到对应路由 |
| 判据看"注入是否生效"而不看"是否原样送达" | task-9 → ②C3 的教训 | 判据要覆盖"端到端送达"，不只看开关 |
| 门声明覆盖 N 篇实际只扫 M 篇 | task-73 | 口径谎报按 E 级报，不按 W 折算 |
| "我读源码觉得没有"当证据 | 查路径存在性 | 给 HTTP 状态码：401 说明处理器存在、404 说明不存在、405 说明方法不对 |
| 队友说"完成了" | 全部 | 只信可复跑命令与真实 exit code |

补充一条与门本身有关的：**门看不见的面不等于干净**。`scripts/check-md-tables.mjs` 的默认扫描根是 `AGENTS.md`、`internal`、`docs`、`tools`、`plans`（`:83`），`A03-xihe/spec` 不在其中——所以 spec 目录里的表格债当前没有任何门在拦（2026-11-20 实测 3 处存量问题无人报）。报"某门绿"时必须同时说清它的作用面。

## 7. 复用清单（下一个会话照此开工）

开工前：读 `internal/A03-xihe/handoff/inflight.md` 与最近一份交接档；`team_task_list` 确认板上在办项；`list_agents({})` 确认成员存活。

接手时：先复核上一轮的"下一小时"三条，逐条给做了 / 没做 + sha，不做口头确认。

推进时：一卡一 owner 一 write_scopes；同一文件不允许两张卡并行；跨仓提交前先核当前分支（one=`main`、A03=`develop`、A12=`main`、A01 与 FB02=`develop`）。

收尾时：核对三项持久化是否都落了——DSD 裁定、卡板状态、git 提交；写 `inflight.md`（覆盖写）并跑 `node scripts/check-inflight.mjs`；写回溯条目（append-only + UTF-8 无 BOM + 前缀 SHA256 校验，见协议 §5.2）。

交接时：交接档过 `node scripts/validate-handoff.mjs <档>` 到全 ✓，再跑 `xh-monitor.mjs --handoff-check` 对五问（协议 §5.3）。团队接口的寻址值与字段名按当次 DSH 安装版读，不沿用上一份交接档的写法（协议 §5.4）。

## 8. 关联

- 工位与角色分层：`A03-xihe/.agents/skills/team-roles/SKILL.md`
- 轮询判据与三层 prompt：`internal/A03-xihe/docs/xh-monitor-protocol.md` §5.0–§5.4
- 常设授权 SSOT：`internal/A03-xihe/docs/lead-authority.md`
- 提交原语与守卫：`internal/A03-xihe/scripts/xh-commit.mjs`（`--help` 为唯一用法来源）
- 交接档契约：`scripts/validate-handoff.mjs`、`scripts/handoff-contract.json`
- 文档格式：DEV-030；术语：DEV-032
