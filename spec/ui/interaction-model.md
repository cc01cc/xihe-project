# UI 交互模型

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`ui`  
> Owner：UI + 跨边界 owner  
> 消费者：UI、CP、Agent、Session、Workspace、可访问性审查者  
> 来源：PLAN-0388、DEV-010/017、UI stores/SSE/E2E  
> 更新日期：2026-09-20

## 范围

本文冻结跨页面、跨 Session/Workspace、跨 ChatRun/Approval 的用户动作与可观察状态。具体 feature 页面流程、OpenAPI/SSE wire schema 和视觉截图 baseline 不归本文。

## Surface map

| Surface | 用户动作 | canonical 数据源 | UI projection |
|---|---|---|---|
| Sidebar/Chat | 新建、搜索、切换 Session | CP Session API | `useSessionStore` + Chat route |
| Chat stream | 发送、停止、重试、查看 tool/diagnostic | CP ChatRun/Operation + Chat SSE | `useChatStore`、`useAgentStore` |
| Approval | 查看、批准、拒绝、保存规则 | CP approval/policy API + SSE | `ApprovalModal`、pending summary |
| Workspace | 打开、切换、刷新、文件操作 | CP Workspace + Runtime + Workspace SSE | `useWorkspaceStore` |
| Workspace Chat | 在 Workspace 内发送 tool-mode Chat | Session/Agent/Workspace contracts | `ChatPanel` + Session store |
| Global feedback | loading/error/reconnect/empty | API Problem Details/SSE/transport | inline error、Toast、status region |

## 用户动作闭环

每个可交互动作 MUST 具备以下闭环：

1. 用户动作有可定位的 control、label、keyboard path 和 disabled 条件。
2. UI 发出 canonical API/SSE/route action；字段由 types/OpenAPI/事件事实源提供。
3. CP/Runtime 返回 response 或 durable projection；本地 optimistic state 不得被当作成功事实。
4. UI 显示 success、loading、error、reconnect 或 empty 结果，并保留下一步动作。
5. 失败重试必须生成可追踪的新动作；同一 ChatRun 不重复发送隐式重试。

## 状态语义

| 状态 | 进入 | 可见反馈 | 允许动作 |
|---|---|---|---|
| `loading` | 请求未完成 | skeleton/disabled/status | 取消或等待，不能显示空数据 |
| `error` | Problem Details、SSE error 或本地解析失败 | inline error + Toast（按场景） | retry、返回或重新输入 |
| `reconnecting` | SSE 非 fatal 断开 | 连接状态提示 | 等待恢复或显式停止 |
| `awaiting_approval` | CP pending approval projection | Modal/summary、阻止危险动作 | approve/reject/close（close 不等于 reject） |
| `dispatch_unknown` | CP approval dispatch uncertain projection | 状态不确定提示、保留 request/run 关联，不显示为已批准 | refresh/status query；服务端确认仍 pending 后才允许重新决策 |
| `empty` | 服务端合法空集合或无 Workspace | 空态和唯一入口 | create/import/refresh |
| `disabled` | loading、invalid、capability/policy gate | disabled/inert + 原因 | 修正输入或等待 |
| `completed` | durable/response 已确认终态 | 成功内容/状态 | follow-up、navigate |
| `partial/ambiguous` | CP 返回不完整或不确定终态 | 明确 partial/ambiguous 文案 | 查看状态、人工确认、新 idempotency key 重试 |

## 跨域不变式

- `sessionId` 只定位 Chat Session/Chat SSE；`workspaceId` 只定位 Workspace/Workspace SSE；二者不得互充。
- UI store 只做 projection；Session/ChatRun/Operation/Approval/Workspace 终态由 CP/Runtime owner 决定。
- Chat SSE 的 `done` 只结束当前 run，不关闭持久 Session SSE；Workspace event 不进入 Chat bubble。
- Approval Modal 关闭不自动 reject；服务端决策 response 才能改变 Approval state。
- `dispatch_unknown` 不表示 approved，也不允许 UI 直接重发同一 decision；UI 先刷新 pending/run status。若服务端仍返回 `pending`，用户可以基于同一 requestId 重新决策；若返回 terminal，移除 Modal 并保留结果/审计提示。
- Mock E2E 只验证确定性 UI 分支，不能成为真实链路、持久化或权限完成证据。

## 验证映射

- 动作矩阵：PLAN-0388 `evidence/action-matrix.md`。
- Session/Agent/Workspace 边界：`../session/`、`../agent/`、`../security/` 与 Workspace proposed SPEC。
- 真实浏览器闭环：PLAN-0388 T3/V5/V6，当前未完成。
