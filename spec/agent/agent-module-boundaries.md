# Agent 模块结构规范（M1 冻结草案）

> 契约状态：`active`（PLAN-0473 实施完成；2026-10-10 归档时自 PLAN-local spec 晋升）
> 实现状态：`implemented`（A03 `develop` `01a0f4a3`；来源 PLAN-0473）
> Owner：Agent owner（PLAN-0473）
> 消费者：Agent 包内实现者、PLAN-0468（后续 Guidance/Runner 适配方）、审查者
> 来源：PLAN-0473 M0 证据（`evidence/m0-boundaries.md`、`review/round-0.md`）与 Round 1/2 审查
> 日期：2026-10-09

## 1. 范围

本文冻结 `packages/agent` 包内的模块职责、目录归属、依赖方向和例外，作为新增/调整 Agent 代码的结构依据。它细化 `A03-xihe/spec/architecture/module-boundaries.md`（跨模块四模块边界）与 `A03-xihe/spec/agent/execution.md`（执行模型/接口事实源），不重复定义跨模块通信、HTTP schema 或事件 payload。

## 2. 模块职责与目录归属

| 职责 | 归属（目标） | 现状 → 目标 |
|---|---|---|
| App composition root | `src/xihe_agent/main.py` | 保留 lifespan/config refresh/CrashRecovery/Registry/watcher 编排与 app 装配；**收窄**：HTTP 路由、请求 schema、路由级错误映射移出 |
| HTTP 路由 + 请求 schema + 路由级错误映射 | `src/xihe_agent/api/`（按域分组：`chat.py`、`rag.py`、`approval.py`、`registry.py`、`misc.py`（cancel/summarize/health/tools）等；实际分组以 T1.3 调用面扫描为准） | 现集中在 `main.py:872-1835`；`llm/models.py` router 维持现状（已有独立边界） |
| Application-facing 编排接口 | `src/xihe_agent/interfaces/agent_runner.py` | 保持不变；`stream()`/`create_agent()` 契约冻结（见 §5 观察项） |
| LangGraph 执行编排（AgentRunner 实现） | `src/xihe_agent/agent_runner/langgraph_runner.py` | 保留 `stream()` 编排（事件写入顺序见 §4）；框架细节按 §3 拆出 |
| LangChain 工具适配 | `src/xihe_agent/agent_runner/tool_adapter.py` | **迁入** `LCToolAdapter`（现 `langgraph_runner.py:555-766`）；消除 registry/supervisor 对 runner 私有符号的跨层引用 |
| LangGraph 建图 | `src/xihe_agent/agent_runner/graph_builder.py` | **新增**：`create_react_agent` 直调唯一归属；`registry.py`、`supervisor.py` 经其建图 |
| Worker 配置/启停/持久化 | `src/xihe_agent/registry/registry.py` | 保留配置/启停/文件持久化职责；`_get_tools_for_worker` 转公开（supervisor 现引用私有符号） |
| Supervisor 编排 | `src/xihe_agent/agent/supervisor.py` | registry/built-in 分支逻辑不变；建图经共享 `graph_builder` |
| CP durable 事件/上下文客户端 | `src/xihe_agent/context/` | 保持不变；CP 是 EventStore/Projection 唯一 owner |
| 框架事件投影/SSE 适配 | `src/xihe_agent/adapters/` | 保持不变 |

## 3. 依赖方向（允许 →，禁止 ←）

```
api/ → interfaces/
agent_runner/ → interfaces/
registry/ → agent_runner/graph_builder + agent_runner/tool_adapter + interfaces/
agent/（supervisor）→ agent_runner/graph_builder + agent_runner/tool_adapter + interfaces/
main.py → api/ + 各模块 public 入口
interfaces/ →（零 LangChain/LangGraph 依赖）
api/ →（零 LangGraph 依赖）
```

- 禁止跨层引用他人私有符号（前缀 `_`）；`_get_tools_for_worker` 公开化是唯一既存例外转正。
- `create_react_agent`（`langchain.agents.create_agent`）只允许出现在 `agent_runner/graph_builder.py` 与 `agent_runner/langgraph_runner.py`（runner 内 `:842` 建主图保留）。

## 4. 运行行为不变量（M3 验收基准）

- Runner 事件写入：`prompt.admitted` 建图前 → `context.prune`（prune 触发，tombstone）→ `tool.called`/`tool.result`（工具路径，必需 append 失败收敛 Run 失败）→ `assistant.responded`（非取消且有响应）；usage/error 在对应终态前发出。
- branch 不匹配 fail-closed；`/chat` supervisor 分支保持当前不可达（`ApprovalExecutorUnsupportedError` 先于 builder 调用）。
- 装配行为：lifespan 启动/停机顺序、配置 refresh 原子替换、请求级 workspace/MCP 作用域、共享运行时状态不变。
- Wire：Agent→CP append 实际行为（`POST /internal/v1/context/{sessionId}/events`，CP 返回 200+`sequence/eventType/created_at`）为基线（OpenAPI 201 偏差已登记，PLAN-0473 决策 #6）；SSE `event:`/`data:` 与 chat 请求头透传不变。

## 5. 观察项

- `AgentRunner.create_agent()`（`interfaces/agent_runner.py:76-82`）：全包搜索无生产调用方；**保留接口**，登记为无消费者观察项，契约清理后置单独裁定（用户裁定 2026-10-10，PLAN-0473 review/round-2 #13）。
- `main.py` 模块级 `agent_runner`（`main.py:253`）：无调用方，M2 已移除（移除前全包符号重扫）。
- `litellm>=1.68.0` manifest 下限 vs lock `1.101.0`：依赖维护事项，不在本结构计划内。
- `GET /internal/v1/context/{id}/events` 返回行缺 `created_at`，`CPEventStoreClient._event_from_dict`（`store_client.py:139`）list 解码会 KeyError：CP/客户端文档偏差（M3 T3.3 发现），append/latest/snapshot 链路不受影响；后续单独跟进。
- Agent→CP append 的非 null `correlation_id` 必须解析到 durable Run（否则 404 RUN_NOT_FOUND，CP 分支派生契约）：真实 run correlation 由 CP 派发 runId 绑定，session-global append 用 null（M3 T3.3 确认）。

## 6. 验证映射

| 规范条款 | 验证 |
|---|---|
| 目录/依赖方向 | V5；T2.2/T2.3 落地后 `ruff check src/` + 全包 import 扫描 |
| 行为不变量 | V10/V11；T3.1 受影响单测 + T3.2/T3.3 真实链路 |
| 观察项处置 | V6（spec 晋升 + DEV/AGENTS 同步） |
