# UI 功能边界

> 契约状态：`proposed`
> 实现状态：`partial`
> Profile：`architecture`
> Owner：UI owner
> 消费者：Workspace feature、Sidebar/Auth shell integration、SessionStore/CP、UI tests、后续 UI PLAN
> 来源：PLAN-0472（workspace plan）；M0 owner/import inventory 见该计划 evidence
> 更新日期：2026-10-10

## 范围

本文定义 XH UI 的增量 feature-first 目录基线及 Workspace feature owner。本版把 Chat UI/ChatStore 作为 Workspace 的 Chat 子能力；其他既有页面不要求在本 PLAN 内整体搬迁。

`partial` 表示 Workspace 是当前已迁移并遵循该边界的首个 feature；其他既有 UI 功能仍可暂留横向目录，后续按真实 owner 增量迁入，不要求本轮全局重排。

本文仅定义 UI code owner、目录归属、测试落点和 app-shell 集成边界，不定义 UI 视觉设计、API/SSE wire schema、Session 生命周期或 CP durable 状态。

## 非目标

- 不调整任何路由 URL/name、API endpoint/header/response、SSE payload、持久化状态 owner 或权限语义。
- 不改变 CP Session/Message/ChatRun canonical lifecycle、API/wire 或持久化 owner；不重构通用 API facade、wire types 或 transport。
- `ChatView.vue` 已确认无 router/production caller；按用户批准删除该 legacy component 与单测，不新增 `/chat` route。
- 不要求一次性把所有旧 `views/`、`components/`、`stores/`、`composables/` 内容迁入 feature 目录。
- 不以文件行数作为拆分理由；不在结构迁移中修复无关业务缺陷或改变用户可见行为。

## 术语与归属

| 术语 | 约定 |
|---|---|
| Feature | 按一个用户可识别能力聚合、拥有其私有页面/组件/状态适配器/测试的模块；它不因此取得其他域的状态或 wire contract 所有权。 |
| Feature-private code | 只被该 feature 使用、且语义归该 feature 的 UI 实现；默认放入该 feature 目录。 |
| Shared code | 由多个 feature 使用或属于跨层/wire contract 的实现；只有在有真实多个消费者时才进入 shared，不作为未分类文件的默认落点。 |
| Composition root | 路由页面可组合其他 feature 的公开组件和公开 props/events；不得直接依赖其他 feature 的私有 store/composable。 |

## Workspace 目标目录

首期目标结构：

M0 确认 `src/features/` 当前不存在；`src/features/workspace/` 整棵子树为 `[NEW]`。本 PLAN 不创建空的 `components/shared/`，仅保留现有已证明被复用的共享模块。

```text
src/
  features/
    workspace/
      pages/
        WorkspaceView.vue
        WorkspaceEnvironmentView.vue
      components/                     # Workspace private UI; shared Chat UI lives under chat/
      stores/
        workspace.ts
      composables/
        fileService.ts
        useWorkspaceAgentSync.ts
        useWorkspaceSSE.ts
      chat/
        components/                   # ChatPanel, SSEStream, messages, approvals, SessionList
        stores/chat.ts
        composables/                  # useSSE, useStreamParser
        lifecycle.ts                  # user-switch cache cleanup public action
      __tests__/                      # Workspace-owned tests
  composables/
    api.ts                           # shared endpoint facade
  services/
    chatTransport.ts                 # shared transport lifecycle
  stores/
    session.ts                       # Session view; CP remains canonical
    auth.ts                          # global auth, invokes Chat lifecycle public action
  types/
    index.ts                         # shared/wire-facing types
  components/sidebar/
    Sidebar.vue                      # shell composes public Workspace Chat SessionList
  router/                            # URL/name mapping
```

`src/features/workspace/` 收纳 Workspace pages/store/components 和其 Chat 子能力。ChatStore 是 Session-keyed 本地 UI cache，不拥有 Session/Message canonical data；SessionStore/CP lifecycle 仍留 shared/domain owner。精确 source-to-target manifest 由 PLAN-0472 M1 维护；每个迁移批次开工前必须按当前 imports 重核。

本计划中下列文件留在当前 shared/owner 目录：`composables/api.ts`、`types/index.ts`、`services/chatTransport.ts`、`stores/session.ts`、`stores/auth.ts`、全局 `i18n/index.ts`、`router/index.ts` 和 `e2e/**`。AuthStore 只可调用 `features/workspace/chat/lifecycle.ts` 的 cache-cleanup public action；Sidebar 只通过 public SessionList component 组合 Chat UI。只有获批文件移动确有需要时才更新其 importers。

## 依赖方向

- `router` 将现有 URL/name 映射至 Workspace pages，不拥有 Workspace 或 Chat UI state。
- Workspace feature 同时拥有 Workspace UI 与 Chat 子能力；ChatPanel、SSEStream、ChatStore、SessionList 和 Chat stream/parser 都归该 feature，不保留独立 Chat feature owner。
- Chat SSE 可在同一 Workspace feature 内直接调用 `useWorkspaceAgentSync`；只在 `toolMode=workspace` 且 `isCurrentSession` 为 true 时触发。不创建 event bus、WorkspaceToolCall bridge、第二套 API/SSE 或持久化契约。
- ChatStore 是按 SessionId 索引的本地 view/cache，不是 Session/Message canonical data。SessionStore 仍负责 Session metadata/fileContext，CP 仍拥有 Session、Message、ChatRun 的服务端 canonical lifecycle。
- Sidebar shell 通过 Workspace Chat public SessionList component 呈现 Session 列表；AuthStore 仅调用 Workspace Chat 的 user-switch cleanup public action，不读取 ChatStore 内部状态。`lifecycle.ts` 只依赖 ChatStore，禁止反向 import AuthStore/WorkspaceStore，以免形成 module cycle；该入口保持单一、显式，不引入通用 registry。
- WorkspaceStore 仍拥有 Workspace file-tree/editor view state；同步 active-file context 时沿用 SessionStore 写入路径。
- API facade、`types/index.ts`、`chatTransport.ts`、locale catalog 和通用 UI components 保持 shared；只有独立消费者盘点证明存在明确 owner 并获得单独变更批准后才可调整。

## 不变式

- 保持 `/workspace`、`/workspace/:workspaceId`、`/workspace/:workspaceId/chat/:sessionId` 和 `/workspace/:workspaceId/environment` 的 URL behavior 和 route names 不变。
- 保持 API requests、auth/workspace headers、SSE frames、normalization、错误表现、审批、file/job state owner 和跨服务契约不变。
- 保持现有 responsive IA 和可见行为；本计划只调整目录/owner，不做视觉重设计。
- 禁止 feature 直接 import 其他 feature 的 private path；跨 feature 组合必须通过 public component/props/events 或确有多消费者的 shared contract。
- 只移动 owner 已核实为 Workspace/Chat UI 的文件。Auth/Sidebar 只使用 feature public entry；Shared E2E tests、API normalization tests 和 wire-facing types 留在其现 owner。
- 保持 `WorkspaceEnvironmentView` 的 raw `hostPath` 可见性规则：仅 instance admin 或对应 Workspace owner 可见；其他用户和 unknown principal 不得在客户端看到该路径。

## 迁移与恢复

PLAN-0472 按独立批次迁移代码：(1) Workspace pages 与 router lazy imports；(2) Workspace components/store/file adapters；(3) Chat UI components/ChatStore/Chat stream/parser/tests；(4) Sidebar SessionList 与 Auth user-switch cleanup public entry；(5) DEV/AGENTS/SPEC index 同步。每批通过 scoped static/unit checks 后再开始下一批。

若某批失败，只停止该批；将该批已移动/imported paths 恢复至最后一个集成状态，保留此前已验证批次并重跑本批检查。本计划无持久化数据迁移，也不新增 API compatibility bridge。

## 验证映射

| 验收点 | 必需证据 |
|---|---|
| Workspace/Chat 专属单测仍通过 | 从 `packages/ui` 运行 `pnpm run test:unit -- src/features/workspace`；并运行 `pnpm run test:unit -- src/stores/__tests__/authStore.spec.ts` 验证 Auth lifecycle integration |
| 路径和类型有效 | 从 A03 根运行 `mise run typecheck:ui`、`mise run lint:ui`；每个迁移批次检查受影响单测 |
| Workspace 页真实 host 页面可用 | 从 A03 根运行 `node scripts/e2e-host.mjs e2e/real/environment.spec.ts e2e/real/workspace-import.spec.ts --retries=0`；environment.spec 标记 `@host`，截图写入 Playwright `test-results/` |
| Workspace Chat tool chain 真实链路保持 | 从 A03 根运行 `node scripts/e2e-host.mjs --llm-mode=write_file e2e/real/journey-a.spec.ts --retries=0`；断言浏览器可见 tool result、Workspace tree sync、FS/API 结果和操作后截图 |
| 响应式与安全声明有证据 | 在 `1920×1080` 和 `390×844` 真实 viewport 记录 route、操作、DOM/overflow、console/pageerror、截图和 teardown；回归 Workspace owner/admin hostPath 可见且非授权身份不可见 |

Host runner tests 使用每轮隔离 stack；除明确的 `write_file` marker 测试外均用默认 fake-LLM mode，不需要真实 provider key。M3 最终验证同时记录 `mise run build:ui` 与相应 unit/host-E2E 结果；不使用已冻结的 Compose/Docker lane。

## 关联规范

- [UI 交互模型](../ui/interaction-model.md) 负责 UI state presentation，不负责 feature source ownership。
- [UI 设计系统与状态表现](../ui/design-system.md) 负责 visual/status language，不负责 Workspace data ownership。
- [UI 无障碍与键盘契约](../ui/accessibility.md) 负责 focus/keyboard contracts，不负责 feature module placement。
- [Workspace 生命周期与绑定](../workspace/lifecycle.md) 负责 Workspace resource lifecycle 和服务端语义；本文只组织 UI code。
