# Chat Session 生命周期

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`lifecycle`  
> Owner：CP Session owner  
> 消费者：UI、Agent、Context、Operation、Workspace  
> 来源：PLAN-0387、PLAN-0348、DEV-017  
> 更新日期：2026-09-20

## 领域边界

Workspace 是独立资源。Session 可以绑定一个 Workspace，但 Workspace 不依赖 Session；没有 Session 时仍可创建、导入、浏览和编辑 Workspace。

Session 负责连续对话上下文、消息、附件引用、模型绑定和 Chat SSE 订阅；它不拥有 Runtime Sandbox 或 Runtime MCP 进程。

## 状态

| 状态 | 说明 | 权威 |
|---|---|---|
| `active` | 可创建 ChatRun、订阅 Chat SSE | CP Session |
| `archived` | 不作为当前交互 Session，但服务端数据按保留策略处理 | CP Session |
| `deleted` | 删除 API 成功后的终态；删除前必须处理非终态 run | CP Session + cancellation |

## 规范条款

1. Session MUST 最多绑定一个 Workspace；Session 生命周期内不得 rebind 到另一个 Workspace。
2. Workspace 切换 MUST 通过选择已有 Session 或创建新 Session 表达，不把 Workspace 切换写成 Session rebind。
3. Session API、消息和附件的 canonical source 是 CP；UI local store 只能作为 projection。
4. Session 删除前 MUST 通过 CP 取消/收口非终态 ChatRun，并在有界等待后完成删除；不能只删除 UI 状态。
5. Chat SSE 按 `sessionId` 订阅；Workspace SSE 按 `workspaceId` 订阅，两者不能互充。

## 恢复与失败

- Chat SSE 断线由 UI transport 按 session generation 和 `Last-Event-ID` 恢复；恢复不创建新的 Session。
- Session 查询失败、Workspace context 缺失或授权失败 MUST 显式返回错误；UI 不得伪造默认 Session。
- Session 与 Workspace 的授权边界来自 Security/CP；本文件不定义 role/scope。

## 承接与验证

- Session 固定 Workspace 与跨 Session 延续：PLAN-0348。
- Agent principal Workspace scope：PLAN-0374。
- 当前实现对账：PLAN-0387 `evidence/current-state.md`。
- 真实 delete/recovery/SSE 验证：PLAN-0387 V7，尚未完成。
