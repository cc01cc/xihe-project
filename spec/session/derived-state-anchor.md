# 派生态 anchor 消息投影（task-1 / D-1846）

> 用户 2026-11-18 16:2x：「立卡，这个要进入 MVP」。
> 本文件是**设计契约草案**（先设计后实施），实施卡 = task-1。
> 状态：草案 v1（Lead 拟），待实施过程中回填实测。

## 1. 问题

多 agent 主体并行干活时，**主会话用户看不见**：

| 能力 | 现状 |
|---|---|
| 一条消息点名多个 AGENT（fan-out） | ✅ 协议有（`chat-session.md` §显式 TO 多目标） |
| agent 自己 spawn 子团队 | ✅ `spawn_agent`（budget 8×3） |
| 子 agent 状态读接口 | ✅ derived-state |
| **状态进对话流** | ❌ 无 |
| **点进子会话** | ❌ DAG 面板节点不可点击 |

用户明确的设计要求（原话转述）：
> anchor 应锚在**开始时间戳**，状态**就地更新**；活儿干完的回复「自然会在最新的消息」。

即：**不许把状态卡挂在流末尾刷存在感**——那会让历史位置出现空洞，且每次读会话都重复看到同一张卡。

## 2. 设计决策（三条，已定）

### D1 数据来源：**投影，不新增事件**

anchor **不新增 durable 事件类型**，也不新增 SSE 事件名。它由**既有数据投影**而成：

| 来源 | 提供 |
|---|---|
| `chat_runs`（`runId` / `agent_principal_id` / `started_at` / `status`） | anchor 的身份与时间锚 |
| `sessions`（`kind=SPAWN` / `spawnedFromSessionId` / `spawnedAt`） | 点击导航目标 |
| `wake_dispatch` 信封（`outcome` / `reason` / `triggerSource`） | 多目标 fan-out 的归组依据（**不得**按 `origin` 归组，见 `chat-session.md` TO 规则 3） |
| derived-state 读接口 | 子会话聚合状态 |

理由：`chat-session.md` §7 明写「本节点不新增事件名、计数维度或 API 路由」；anchor 是**呈现层投影**，加事件等于把呈现需求塞进协议层，代价是整个 SSE/durable 面扩契约。

### D2 时间锚：`startedAt`，就地更新

```
anchor 位置 = chat_runs.started_at（不可变）
anchor 状态 = chat_runs.status（可变，就地重绘）
```

- **anchor 一旦落位就不移动**。状态从 `running` → `succeeded/failed` 是**同一 anchor 的重绘**，不是新消息。
- 子 run 的**终态回复**仍走既有 terminal 消息路径，自然落在流末尾 ⇒ 满足用户「干完活儿回复自然会在最新」。
- **不产生第二条 anchor**（判据 N2）。

### D3 与 DAG 面板的关系：**并存，但职责分开**

| 面 | 职责 | 何时用 |
|---|---|---|
| **anchor 消息**（新） | 时间线视角：这条 run 何时开始、什么状态、点进去 | 日常阅读会话，自然遇见 |
| **DAG 面板**（既有） | 结构视角：整棵委派树、深度、预算 | 主动查看全局，或树很深 anchor 太多时 |

**不做的事**：不把 DAG 降级成「anchor 的补充」、也不让 anchor 复刻 DAG 的树形。两者**从不同角度描述同一事实**，这是允许的（同层引用无环）。

面板侧补一项：**节点可点击**（现在只有 `@click="load"` 刷新），点击 = 与 anchor 相同的导航行为，复用同一 composable。

## 3. 字段契约

```ts
interface DerivedRunAnchor {
  /** 身份 = runId + sessionId（复合，run 不跨会话） */
  runId: string;
  sessionId: string;
  /** 时间锚：不可变。排序键。ISO 8601 UTC+Z */
  startedAt: string;
  /** 主体（多 lead 必须可区分） */
  agentPrincipalId: string;
  agentPrincipalName: string;
  /** 状态（走 runStateView.ts 的既有 tier/label，不新增词表） */
  status: ChatRunResponse["status"];
  /** 派生 run 的父会话（fan-out / spawn 来源）；根 run 为 null */
  spawnedFromSessionId: string | null;
  /** 可选：卡面 subject（若该 run 关联 team_task） */
  subject: string | null;
}
```

**硬约束**：
- `status` 必须喂给 `runStateView.ts`（N10 单语义单解析器），**禁止**在组件里自写 `if (status === ...)`。
- `startedAt` 必须 durable（刷新/重进后位置不变，判据 N6）。

## 4. 呈现规则

1. **排序**：按 `startedAt` 插入对话流（与既有消息同一条时间线，不单独开区）。
2. **多主体**：同一时刻两条 anchor 并排时，显示 `agentPrincipalName`；**必须有视觉区分**（不许只靠时间戳）。
3. **状态文案**：复用既有 i18n key（`chat.derivedStateStatus.*`），**不新增文案**。
4. **耗时**：running 时显示「已运行 Ns」（前端计时，不轮询后端）；terminal 时显示终态。
5. **失败不静默**：`failed`/`cancelled` 必须显式呈现（走 `runStateView` 既有 tier `terminal`）。

## 5. 验收判据（六条，可执行）

| # | 操作序列 | 观察点 | 通过条件 |
|---|---|---|---|
| N1 | 主会话 fan-out 点名两个 AGENT | 对话流 | 两条 anchor 各锚各自 `startedAt`，**不都挂末尾** |
| N2 | 子 run running → succeeded | 该 anchor | 状态**就地**变 terminal；**无第二条 anchor** |
| N3 | 点击 anchor | 路由 | 切到对应子会话，sessionId 正确 |
| N4 | 子 run 失败 | 该 anchor | 显式失败态，不静默 |
| N5 | 两个 lead 并行 | 对话流 | 可区分主体（名字 + 视觉） |
| N6 | 刷新/重进会话 | anchor | 仍在原 `startedAt` 位置（durable） |

## 6. 边界（不做什么）

- **不新增** run 状态词（12 个 wire status 已冻结）
- **不新增** SSE 事件名
- **不新增** API 路由（复用 `GET /sessions/{id}/team-tasks` 家族的读投影思路）
- **不引图库**（DAG 自绘是既有 design 决策）
- **不属于 MVP⑤ 收口判定**：MVP⑤ 已三面全绿收口，本卡是独立增量

## 7. 待实施时回填的开放项

| # | 开放项 | 谁来定 |
|---|---|---|
| O1 | anchor 在 fan-out 场景下，**是否只呈现「首个目标」的 `user_submission` run，派生 run 也各出一条 anchor**？ | 实施时按实测：若派生 run 也有独立 runId，则各出一条（符合 N1） |
| O2 | DAG 面板节点点击后，是**切会话**还是**在面板内聚焦**（不切走）？ | 实施时按 ui-review 判据定，倾向「切会话」与 anchor 一致 |
| O3 | 树很深（depth=3）时 anchor 数量爆炸（8×3=最多 24 条）怎么办？ | 实施时测：可能需要「折叠为一条父 anchor，展开看子」 |

## 8. 与既有契约的关系

| 契约 | 关系 |
|---|---|
| `chat-session.md` §显式 TO 多目标 | anchor 的**输入**；不修改，只消费 |
| `runStateView.ts` | anchor 的**状态投影器**；必须复用 |
| `delegationGraph.ts` | DAG 的**结构投影器**；并存，不合并 |
| `DelegationPolicyValidator` 8×3 | anchor 数量的**上限来源**；O3 必须按它算最坏情况 |

---

**草案 v1 完**。实施进度回填至 task-1。
