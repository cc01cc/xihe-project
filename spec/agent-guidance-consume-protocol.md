# Agent Guidance 消费协议（T0.1 冻结，2026-10-18）

> 本文件是 PLAN-0529 的消费协议唯一冻结件。上游 wire：0528 `packages/control-plane/../../spec/cp-guidance-contract.md` §4（`GET /internal/v1/chat/runs/{runId}/guidance/pending` + `POST .../{guidanceId}/consume`）。母体契约：`plans/PLAN-0468-xh-chat-run-guidance/spec/target-contract.md` §4。
> 已裁定：多条按 CP `sequence` 顺序追加注入（2A）；无 Guidance SSE；首版仅 user 来源。

## 1. 消费点（冻结）

**模型调用前置注入（model-call pre-injection）**：在主 Runner 的模型节点调用 LLM 之前检查 pending Guidance，把每条作为**独立 HumanMessage**（见 §3）追加进**该次调用的输入 messages 尾部**，随后写回 consume。

- 语义等价性：一次模型调用开始 = 上一批已派发工具全部完成、且本轮规划尚未发生 → 恰为母体契约 §4 的「整批已启动工具完成后、下一次模型规划前」。第一批（首条用户消息后的首次规划）同样适用。
- **不做**：不 interrupt、不改 graph 拓扑、不写 LangGraph state、不扩展 checkpoint 平台（母体非目标）；不打断已启动工具、不跳过同批未启动调用。
- **瞬态注入（冻结）**：注入只影响**该一次** LLM 调用的输入，不写入 graph `messages` 通道、不落 checkpoint（绕开 round-1 #2 的续跑泄漏争议：consumed 内容不随 checkpoint 进入续跑上下文；「纳入下一次规划」即单次语义）。
- 无 CP client / runId 缺失（单测、registry worker 等场景）→ Guidance 消费整体禁用，零行为变化。

## 2. 读取与去重（冻结）

- 每次注入前调 `GET .../guidance/pending`；无 pending → 注入空、不调 consume。
- **去重三级**：① stream 内存 `injected_ids: set[str]`（同 run 生命周期）；② 请求体 `Idempotency-Key: guidance-<guidanceId>`（CP 幂等）；③ consume 返回 409 `GUIDANCE_ALREADY_TERMINAL_EXPIRED` → 记入 injected_ids、**停止重试且不再注入**（0528 冻结语义）。
- consume 失败（网络/5xx）：已注入内容**保留在本次调用**（已发生，不可撤）；该 id **不进** injected_ids → 下一边界重读仍可见 → 依赖 CP consume 幂等与 409 兜底，**绝不重放已完成工具副作用**（工具与 Guidance 无关，重读只影响文本注入）。
- 读取失败（网络/超时）：记 warn、注入空、run 继续 Guidance-less（fail-open 仅影响可见性，不影响安全——Guidance 无授权语义）。

## 3. 注入形态（冻结）

每条 Guidance → 一条 HumanMessage，正文为信封（Guidance 是不可信输入，须在可识别信封内）：

```
[guidance] (source=user, seq=<sequence>)
<content>
```

- 不进 system prompt、不改变 system/developer 组装；模型可见为普通 user 回合。
- 注入发生在 messages 列表副本上（不改原 state 引用）。
- 多条按 CP `sequence` 升序逐条追加（裁定 2A）。

## 4. 时序与日志

- 注入 + consume 在模型调用前置路径内联完成；consume await 超时 ≥ CP 调用既有超时配置。
- 日志只记 `guidanceId/sequence/status`，**不记 content 原文**（0528 §5 同源约束）。
- AgentEvent 不新增事件类型（候选①）：注入对 UI 不可见，UI 通过 0528 快照端点感知状态。

## 5. 测试锚（供 verify 引用）

- 单元：`uv run pytest tests/unit/test_guidance_consumer.py -v`（注入/去重/409 停止/读取失败 fail-open/无 client 零行为）
- 集成：`uv run pytest tests/unit/test_steering_guidance_e2e_probe.py -v`（真实 Runner + 脚本化 tool-calling 模型 + 计数工具：批次屏障时序、consume 时序、副作用不重放）
- host E2E：`node scripts/e2e-host-detached.mjs --timeout-min 30 e2e/real/guidance-consume.spec.ts`（实施期单 spec L0）
