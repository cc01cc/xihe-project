---
name: team-roles
description: XH 交付线在 DSH 中的常驻团队角色化（正式；仅 DSH）：verify/dev-1/dev-2/ops/research-1/research-2 分层、成员命名=角色名+数字序号、并行上限与编译位、测量窗值班、idle/回收、临时席登记与交接契约联动。在 DSH 下派多成员并行、起常驻位或写交接档时加载。
---

# XH 常驻团队 · 工位制（DSH 专用；正式）

> **适用范围：DSH（DeepSeek Harness）专用。** 本流程依赖 DSH 的 teammate 机制原语（`spawn_teammate` / `send_message` / `interrupt_agent` / `list_agents` / `team_task_*`）与其会话模型（durable teammate 可中途 steer、一次性 subagent 不可寻址、后台 job 完成不唤醒）；在 Kilo / Codex / OpenCode / Claude Code 等其它 harness 上**不适用**——那类环境按根池 `.agents/skills/subagent-orchestration/` 的通用编排规则执行，DSH 机制事实见其 `references/dsh-team.md`。
>
> 2026-11-09 由试行转正式（用户裁定）。**2026-11-11 改为工位制（D-810 / D-811 / D-815）**：角色不再是「施工/运维/调研」的功能分层，而是**按模块与交付基础设施划分的工位**。本文件是 XH 团队流程的**唯一正文**；实例参数（谁在岗、lane 槽、资源实测值）见 `one/internal/A03-xihe/docs/team-roster.md`，冲突以本文件为准。
>
> ⚠️ **frontmatter 的 `description` 仍是旧角色名**（`verify/dev-1/dev-2/ops/research-1/research-2`）—— 改它是**结构级变更**（需用户批准），本会话只改正文。**正文以本文件为准，frontmatter 是历史描述。**

## 1 工位分层（模块工位 4 + 职能工位 4）

> **工位（station）= 持久标识**，跨会话不变，写进一切持久文档。**成员名 = 本会话临时映射**（`list_agents` 里的地址），**不写进任何持久文档**（D-815：DSH 的 team 不跨会话继承，写了下一个人也找不到）。

### 1.1 模块工位（各管一条常驻模块分支）

| 工位 | 常驻分支 | 写面 | 不可做 |
| --- | --- | --- | --- |
| `ui-1` | `m/ui` | `packages/ui/**` · `docs/i18n/**`（UI 页） | 不写共享文件（契约/构建/文档台账）；不直接合回 develop |
| `cp-1` | `m/cp` | `packages/control-plane/**` · **`docs/api/openapi.yaml`（契约唯一写者）** · `docs/i18n/**`（CP 面） | 同上 |
| `agent-1` | `m/agent` | `packages/agent/**` · `docs/i18n/**`（Agent 面） | 同上 |
| `runtime-1` | `m/runtime` | `packages/runtime/**` · `docs/i18n/**`（Runtime 面） | 同上 |

规则正文（流动方式、共享文件所有权矩阵、`check:branch-scope`）在 [`one/internal/A03-xihe/docs/module-branch-model.md`](../../../../internal/A03-xihe/docs/module-branch-model.md) —— **本文件只定义工位，不重复分支规则。**

### 1.2 职能工位

| 工位 | 数量 | 职责 | 不可做 |
| --- | --- | --- | --- |
| `infra-N` | 1–2 | **决定「什么能进 develop」的东西**：队列工具（`xh-queue`）/ 窗口协议（`l2-window-protocol`）/ 分支模型 / 交接校验器（`validate-handoff`）/ `mise.toml` / `scripts/**` 门脚本 / 工位制本身 | 不写模块产品代码；不跑绕过门的「临时检查」 |
| `verify` | 1 | 读 diff、跑 L0/L1/L2 门集、核证据链、判「能否合并」、执行验证窗（book→门集→release）、窗口期间兼测量读数 | 不改产品代码（缺陷只建卡）；不接管模块槽 |
| `research-N` | 1–2 | 1=调研评估（官方文档/源码核对、方案对比）；2=只读审计（代码/契约/证据链） | 不改任何可用文件；不跑编译/建栈；`-2` 连正文也不写 |
| `lead` | 1 | 拆任务/建卡/派活/审 diff/合并/裁定；**文档台账类共享文件只有 develop 能写，写者就是它** | 不长期占实施写面（Lead 不跑长循环，见 §7） |

`research` / `infra` 为低资源工位：有活长跑、无活可回收为按需（§5）。**`infra-1` 与 `infra-2` 是同一工位的两个实例，不是两个工位**（D-811）。

### 1.3 为什么 `infra-N` 不是「塞不进模块的杂活」

它管的是**判断本身可不可信**：门脚本坏了，所有「绿」都不可信。

**实证（BL-572，2026-11-11）**：`scripts/l2/shard-report.mjs` 缺一个 import ⇒ 一个验收脚本**永远 exit 0**，而没人知道它到底验过什么。同类还有本会话的三条：`check:event-keys` / `check:a11y-refs` / `check:e2e-bypass` 默认 `--report-only` ⇒ **裸命令恒 exit 0**，写进窗口清单等于免死金牌。

**判据**：一个工位是否值得常驻，看它「坏了会不会让别的结论失真」。模块代码坏了坏一个模块；**门脚本坏了坏全部结论**。

### 1.4 空岗必须显式写「当前无在办」

空岗不写清楚，下一个人会以为有人在推进。**每份交接档/roster 的空岗行必须带一句状态**：

```text
| agent-1 | m/agent 已建（不挂 worktree） | 当前无在办：近 60 笔 develop 该模块改动 0 次 |
```

判据：**「有工位」≠「有人在推进」**，两者都要能读出来。

## 2 并行上限（XH 实测，2026-11-08）

两条独立上限，不要混：

1. **容器内存**：Docker VM 可用 ≈7.9 GiB ÷ 2 GiB/栈 ⇒ **≈3 栈**（dev 2 + 验证 1）；测量窗再占 1 隔离栈 ⇒ 测量期 dev 只留 1 栈。`[实测]`
2. **host 编译并发 ≤2**：与容器内存无关，被抢的是墙钟与测量可比性（maven 冷 9.3s/增量 8.3s、cargo 冷 66s/增量 4.4s ⇒ 编译本身便宜）。`[实测]`

```powershell
(Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='cargo.exe' OR Name='rustc.exe'" |
  Where-Object { $_.CommandLine -match 'mvn|spring-boot|cargo|rustc' }).Count   # 应 ≤2；测量窗内 ≤1
```

**并行度三算**：写面冲突（同一测试基座/同一配置文件必须串行，产品码可并行）→ 编译位（≤2，空着先补位）→ 栈内存。把「测试基座串行」误推成「整体串行」会让编译位空转（2026-11-08 白等 25min 实证）。

**工位制下并行度怎么变**：并行单位从「每 task 一槽」变成「每条模块分支一个 lane」⇒ 4 模块 + `infra` + `verify` = 6；**同一模块分支上的提交必须串行**（这是代价），**编译位 ≤2 不变**。详见 `module-branch-model.md` §6。

## 3 命名约定（2026-11-09 数字编号制；2026-11-11 补「工位名 vs 成员名」）

### 3.1 工位名（持久，写进文档）

- 模块工位：`ui-1` / `cp-1` / `agent-1` / `runtime-1`（**单实例也带 `-1`**：它们是「第 1 个 UI 工位」，将来可加 `ui-2`）。
- 职能工位：`infra-1` / `infra-2` / `verify` / `research-1` / `research-2` / `lead`。
- **不做零填充**：`ui-1` 不是 `ui-01`（排序、检索、手抄都不该引入前导零）。
- **复用最小空闲号**：某号回收后，新实例优先占**当前最小空闲号**，不要一直往后加。
- **并发实例才加序号**：同一工位同时起两个实例 ⇒ `-1` / `-2`；单实例的 `verify` / `lead` 不加后缀。

### 3.2 成员名（会话内，**不许进持久文档**，D-815）

- 成员名是 `list_agents` 里的可寻址地址，**只为当前会话存在**；会话结束即消失，下一个会话看到的是它自己新建的成员。
- **持久文档（技能正文 / 协议 / 索引 / 台账）一律只写工位名。** 写了成员名不是「不统一」，是**给下一个人一个查不到的地址**。
- 本会话内部怎么映射（哪个成员干哪个工位）由 Lead 自己在会话里维护，**没有持久化价值**。

### 3.3 禁止形态

- 禁止混合名与字母制：`ui-a2`、`ui-A`、`ui1`（缺连字符）、`UI-1`（大写）均不合法；`dev-A`/`dev-B` 制已于 2026-11-09 废止。
- **禁止任务码当工位/成员名**（`impl-<PLAN>-<槽位>` 形态）：GUI 与会话列表按名字展示，任务码无法映射工位。
- 已建成员名不合约定：**不重建**（打断在飞任务），登记映射，闭环后回收再按工位名建。

## 4 测量窗值班时间线

| 时刻 | 动作 |
| --- | --- |
| T-15 | 通知全部工位准备测量；值守位（`infra-1`）收尾当前卡 |
| 窗口开始 | 测量独占 run：独立构建根 + 独占端口段，不与任何 run 并行 |
| 窗内 | 只 `infra-1`（值守）+ `verify`（读数）可动；模块工位不开新长构建；`research` 只做网络/文档调研 |
| 窗内（develop） | **develop 零前进**：窗内不提交 A03 develop（含 docs / 索引 / skill）；必须改的挂 lane 或排到收窗后——任何 develop 提交都会把测量锚的 `--expect-sha` 靶顶掉 |
| 窗口结束 | 释放构建根/端口；`infra-1` 交回外围卡；**提前跑完即收窗，不得用余时塞功能 run** |

## 5 生命周期

- **idle 判据**：连续 2 轮 idle 且名下无 `in_progress` 卡 ⇒ 不主动派活（inactive ≠ 缺活）。
- **回收**：某工位连续 2 个工作日无卡 ⇒ 常驻位降为按需，登记（回收≠解雇）。**空岗分支/工位要在 roster 里显式写「当前无在办」**（§1.4）。
- **临时席**：单次长链路任务可建临时席（如测量重跑），但必须**先登记**（工位/名称/职责/生命周期），任务闭环即回收，不转常驻。
- **建成员前三查**：①复用 inactive 常驻位 ②临时席是否登记 ③是否满足「多轮续跑 / 需反复调度 / 长期持有写面」——三条都不满足走一次性 `subagent`（workspace `.agents/skills/subagent-orchestration/references/dsh-team.md` §5 八维对比表）。

## 6 交接联动（防继任漏建成员）

- 交接档必须有「团队重建」章节：列 roster 表（工位/数量/在办状态）**或**写明「本会话不建常驻：<理由>」。
- 契约落点：`scripts/handoff-contract.json` 的 `team_rebuild` 必检章节（`any_of` 标题 + `must_reference` → roster + 三列表 + 例外句豁免），validator 通用实现零 section-id 硬编码；selftest 23/23。`[实测]` 2026-11-09：11-09 交接档 12/12 通过却漏建 6 常驻 ⇒ 加章节后同档 12/13 FAIL（门按预期拦截）。
- **根因教训**：方法论与 roster 文档都存在，但**交接契约不检查** ⇒ 继任会话不读它们。文档存在 ≠ 流程会执行，检查点必须做进自动校验。

## 7 常见反例（均付过代价）

| 反例 | 代价 |
| --- | --- |
| 6 常驻全起但无活可派 | 空转 + 占满名额（subagent 被拒） |
| 一次性 subagent 跑等待型长任务 | 后台 job 完成不唤醒 ⇒ 停摆 15min（2026-11-09 D-762③） |
| 任务码当成员名 | GUI 一排名字无法对应工位 |
| 不建卡只发消息派活 | 面板空、继任无从追踪（任务板是唯一事实源） |
| 交接档只写授权/队列/定时器 | 继任漏建成员，全部任务退回 one-shot |
| 测量窗内提交 docs（索引 / skill / runbook） | `--expect-sha` 靶漂移：本会话两次（`eb2927` / `303a5e9`），代价 = 测量执行者重核靶树、重做备份、必要时整档重跑 |
| **把成员名写进持久文档**（技能/协议/索引） | 下一个会话按名字找成员**永远找不到**；映射表写得再全也没人去对（D-815） |
| **空岗不写「当前无在办」** | 下一个人以为有人在推进，重复派活或干等（§1.4） |

## 8 派槽位与新增文件的强制校验（2026-11-10，F-2 / F-9 / F-14）

### 8.1 派槽位前必须核「注册」而不是「看着像」

```powershell
git -C <项目> worktree list --porcelain   # 目标路径必须出现在 "worktree " 行
Test-Path <槽位>/.git                      # False ⇒ 泄漏目录，禁止派活
```

- **`git -C <任意子目录>` 会向上解析到外壳仓库** ⇒ 在泄漏目录的子目录里跑 `git switch` 会**切换主检出**（F-2 实测：主检出被钉到队列 tip、工作树写脏，直接堵死 promote）。
- **池表/看板里的 lane 名 ≠ worktree 注册表**；派活前以 `worktree list` 为判据。
- 机器判据：`scripts/validate-handoff.mjs` **A7**（引用槽位必须是注册 worktree；泄漏槽位须 `--allow-leaked` 并打 WARN；泄漏槽位内有 junction 即红）。
- 工位制下的槽位分配（1 主 + 6 槽：4 模块 + `0657-ab` verify + 1 轮转）见 `module-branch-model.md` §5；**预留的空槽不许借给任务 lane**（2026-11-07 实测过「8 槽 0 可分配」）。

### 8.2 「0 tests + exit 0」是假绿（F-9）

测试模块在 `src/main.rs`（`[[bin]]`，Cargo.toml 无 `[lib]` 段）时，`cargo test --lib <filter>` 会**跑 0 条并 exit 0**。必须按 target 选：`cargo test --bin <bin-name> <filter>`（Runtime 实测：`--lib` 0 条 exit 0 vs `--bin xihe-runtime` 8 passed）。

### 8.3 新增/引入文件必须跑「全局扫描型 spec」（F-14）

判据 = **按「哪些 spec 会扫全树」筛，不按「我改了哪些文件」筛**（逐 lane 只跑受影响 spec 的这一类漏检）：

| 类别 | 必跑 |
| --- | --- |
| UI 可达性/文案全局扫描 | `ariaLabels.spec.ts` / `titlePlaceholderLabels.spec.ts`（vendor 组件的上游默认 `aria-label`/`title` 会命中） |
| i18n 机器键 | 文案键扫描（新增 key 未挂载即红） |
| 格式 | 整包 `oxfmt --check .`（文件级会漏漂移） |
| 汇总 | `mise run test:ui` 全量（新增文件后至少一次） |

实测（F-14）：`236ea5875` 新增 `Breadcrumb.vue`/`SidebarRail.vue`（上游默认 `aria-label="breadcrumb"` / `"Toggle Sidebar"`），lane 内受影响面全绿，`test:ui` 全量红 2 spec（develop 基线绿）。

- **A03 主检出任何时候都必须 `git -C A03-xihe status --porcelain -uall` = 0 行**；要落盘的改动一律进 lane，验证完立刻回收（文档/技能类同等适用；窗口期直提撞 `E_DIRECT_DURING_WINDOW`）。
- 发现主检出被自己改脏：**不要** `git checkout --`（丢内容），交 Lead `git stash push -m "<用途+勿丢>" -- <paths>`，promote 后随 lane 批次提交。

## 9 与模块分支模型 / 窗口分级的衔接

| 主题 | 正本 | 本文件只说什么 |
| --- | --- | --- |
| 模块分支怎么流、共享文件谁能写、`check:branch-scope` 判据 | [`module-branch-model.md`](../../../../internal/A03-xihe/docs/module-branch-model.md) | 工位划分（§1）与槽位纪律（§8.1） |
| 窗口分级 W1/W2、静窗判据 | [`l2-window-protocol.md`](../../../../internal/A03-xihe/docs/l2-window-protocol.md) §23 | 窗口期谁可动（§4） |
| 单模块进门门清单 | [`module-entry-gates.md`](../../../../internal/A03-xihe/docs/module-entry-gates.md) | 不重复 |

> **W1/W2 是窗口分级，L0/L1/L2 是验证级别**（两轴，别混）。见 `l2-window-protocol.md` §23.0。
