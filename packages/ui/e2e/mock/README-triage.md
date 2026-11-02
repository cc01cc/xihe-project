# mock 车道存量红点分诊（2026-11-03）

> 车道：`XIHE_E2E_PROFILE=mock`，`pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock`
> 分支：`plan-mocklane-clean`（base `73d14ffc`）。本车道长期无入口（host runner 强制 `--grep @host`，mock spec 无该 tag），
> 这些红点是**长期无人跑积累的漂移**，不是近期回归；其中仍有真产品问题，逐条给依据。

## 0. 数字

| 轮次 | passed | failed | flaky | 失败文件数 |
|---|---|---|---|---|
| 基线（本 worktree 实跑，2026-11-03 05:07） | 141 | 48 | 0 | 20 |
| 修复后整车道（05:35） | 161 | 24 | 4 | 14 |

- 用户给的基线是 134/50/5（同一 commit，flaky 抽样不同；差异 2 条在 `chat`/`workspace-files`/`screenshots` 三处翻转）。
- 修掉 25 条基线红点；新增 1 条红点：`screenshots.spec.ts › workspace-chat-session renders with 0 console errors`
  （该文件在基线里本来就是失败文件，失败用例从 `settings-monitoring` 换成了这条；原因见 §4，属该 spec 自身夹具缺口，
  与本次改动无关，见 §5 的说明）。

## 1. 分类口径

- **F（fixture 缺口）**：`page.route` stub 少投影/少字段，UI 走不到目标分支（网络 404/空对象，或 trace/console 报 `reading 'x'`）。
- **C（契约漂移）**：stub 形状与 OpenAPI / 当前持久化契约不符（PATCH 后 GET 仍旧值、envelope 变了、字段语义变了）。
- **P（产品缺陷/回归）**：UI 代码错了，**不改产品代码**，只报。
- **S（顺序/flaky）**：单跑绿、全量红，或已在 flaky 名单。
- **T（用例漂移）**：产品已按 PLAN 重构（路由退役、控件搬家、文案改名），用例仍断言旧 UI。**不属于 F/C，不修，待裁定。**

## 2. 已修：F（fixture 缺口）

| spec:line | 用例 | 症状 | 依据 | 处置 |
|---|---|---|---|---|
| `chat.spec.ts:104/155/174/313`、`chat-attachment.spec.ts:8/84`、`session-switch.spec.ts:129`、`sse-liveness.spec.ts:101/129/156` | 发送 / 流式 / 停止 / usage / 附件 / 切会话 / 心跳 | 输入后回车，**用户气泡与 `/chat` POST 都不出现**；停止按钮、附件、流式 token 全部无 | 会话投影 `agentPrincipalId` 为 `null` ⇒ `ChatPanel.handleSend` 走 principal 绑定分支 → `GET /workspaces/{id}/agents` 落到 `{}` 兜底 ⇒ 弹绑定对话框，从不发 `/chat` | `setupMockSessions` 默认给会话绑定 principal（真实 `POST /sessions` 强制要求），需要占位态的用例显式传 `null` |
| `session-agent-selection.spec.ts:90` | 创建 principal / 绑定 cap / 解绑 | 「创建智能体」按钮永久 `disabled`，点击超时 | `WorkspaceAgentsPanel` 按 `GET /me/permissions` 能力投影 fail-closed 禁用创建（PLAN-0621 F-01），stub 缺该端点 | 补 `GET /me/permissions` 投影 |
| `screenshots.spec.ts:27`（settings-monitoring） | 各路由 0 console error | `Cannot read properties of undefined (reading 'cp')` | `GET /version` 落到 `{}`，`MonitoringView` 读 `versionInfo.modules.cp.version`；`VersionInfo.modules` 是必填 | 补 `/version` 的 `VersionInfo` 契约 |

## 3. 已修：C（契约漂移）

| spec:line | 用例 | 症状 | 依据 | 处置 |
|---|---|---|---|---|
| `config-settings.spec.ts:118/132/158/239/260/272`、`plan-0554-config-meta.spec.ts:173` | instance 层页签 / 导入导出 / 保存 / 来源徽标 | 页面只渲染 user 层，无 `config-tab-instance`、无导入导出块，来源徽标全是 `user` | 夹具只种了退役的 `role: "ADMIN"`；`authStore.isAdmin` 读能力投影 `user.capabilities.isInstanceAdmin`（PLAN-0610 W3-2b #22） | 种 `capabilities` 而不是 `role` |
| `data-controls.spec.ts:12` | 导出/导入按钮 | 页面渲染英文，断言读中文文案 | `xihe-language` 现按 **raw 字符串**持久化并在启动时应用（PLAN-0602），夹具写 `"en"` 就真的是英文 | 夹具改为 `zh-CN`（断言的中文文案不变） |
| `model-popover.spec.ts:60/74/95/110/127` | 分组 / 选择 / 搜索 / 重载 / 收藏 | 弹层打开但**零分组**；触发器一直「选择模型」 | 目录现按 **ProviderConnection id** 作键，且只保留「enabled + READY + operation=chat」的连接（PLAN-0438/0523）；夹具用 provider 键且没有连接 | 夹具改为连接键目录 + 补 `GET /provider-connections` |
| `model-popover.spec.ts:121`（选择后持久化） | 选择后写 localStorage | 绑定对象多了 `connectionId`/`connectionRevision` | PLAN-0438 scoped binding：选择会连同具体连接与 revision 一起持久化 | **唯一一处改断言**：`toEqual` 里补上这两个字段（断言更严，未放宽；不是用户可见文案） |
| `session-agent-selection.spec.ts:4` | 选 Agent 后建会话 | 选择器永不出现；`GET agents` 返回裸数组 | PLAN-0622 M1.2：列表信封是 `{agents:[…]}`，每项带 `bound`/`disabled`；裸数组让 `raw.agents.map` 抛错 | 夹具改为信封 + `bound: true` |
| `helpers/auth.ts`（`POST /chat`） | 全局 | 错误事件无法挂到消息上；`/chat/runs/{id}/guidance` 打到 dev proxy（ECONNREFUSED） | `202` 必须回 `ChatRunResponse`（`origin`/`status`/`sessionId`/`runId` 必填）；旧夹具只回 `{status:"accepted"}`。catch-all 又用 `url.includes("/chat")` 把所有 `/chat/runs/**` 放行到网络 | `202` 回完整 `ChatRunResponse`；SSE `error` 事件带 `runId`；catch-all 只放行 `/api/v1/chat`、`/api/v1/models`、`/api/v1/events` 三个精确路径 |

## 4. 未修：P（产品，待裁定；只报不改）

| spec:line | 症状 | 证据 |
|---|---|---|
| `chat.spec.ts:201`、`run-budget-exhausted.spec.ts:16/61`、`sse-liveness.spec.ts:115` | SSE `error` 事件后**没有 `message-error` 气泡**；带 `errorAfterTokens` 时连已经流出的 token 也不可见 | 同一夹具去掉 `errorAfterTokens` 时 token 正常渲染（`chat.spec.ts:104` 绿）；`message-error` testid 仍在 `MessageItem.vue:415`，只是从不挂载。`ChatRunResponse`+`runId` 已按契约补齐后仍不出现 ⇒ 不是夹具形状问题 |
| `chat-scroll.spec.ts:10/60` | `[data-testid="message-scroller-viewport"]` 的 `scrollHeight <= clientHeight`，60 条长消息也滚不动 | 消息本身可见（`Message 0` 断言通过），视口元素可见且 `overflow-y-auto`；说明高度约束链断了，视口随内容长高。与已知 workbench 行高缺陷同源待查 |
| `diagnostics.spec.ts:14` | `[data-testid="tool-diagnostics"]` 不渲染 | OpenAPI 明确：`tool_result` 的 `diagnostics` **不过公共 SSE 边界**（PLAN-0510），结构化诊断只在 internal 通道。该用例用公共 SSE 喂 `diagnostics`，与契约冲突；要绿只能改通道或改断言 |
| `journey-d-overflow.spec.ts:14` | `context_overflow_retry` 的 toast 出现，随后的 `token` 不渲染 | toast 绿 ⇒ 事件确实送达并被处理；`token` 丢失指向重试后的 run 关联（疑似与上一行同源） |
| `plan-0557-mcp-errors.spec.ts:84/93/104` | 文件树只剩通用文案「文件树加载失败…」，具体 code 文案只进 `title` | `FileTreePanel.vue:187-205`（P0-4「One inline error style」）把 `treeError` 挪进 tooltip。PLAN-0557/BL-109 要求「可见文案区分 Runtime 不可达 vs 工具不存在」，现状**可见面已无法区分** |
| `session-agent-selection.spec.ts:101` | 绑定成功后「已绑定智能体」列表一直 `正在加载智能体…` | 已按契约改成 `{agents:[…]}`（create/bind 均通过）；bind 后的 `GET agents` 有响应但面板 `loading` 不复位，`workspace-agent-agent-1` 从不渲染。待进一步定位 |
| `policy-management.spec.ts:501` | 移动端审批面板里 `approval-classify-action-class` 输入后仍为 `""` | 元素存在且可见，`pressSequentially("exec")` 后 value 为空；疑似面板重渲染夺焦 |

## 5. 未修：T（用例漂移，产品按 PLAN 重构；待裁定）

| spec:line | 症状 | 依据 |
|---|---|---|
| `policy-management.spec.ts:318/363/373/483` | `/settings/policy` 上找不到 `settings-policy-heading` | `router/index.ts:84-87`：`/settings/policy` **早已 redirect 到 settings-config**（早于 2026-10-07 的格式化提交），`PolicyRulesView.vue` 未路由 |
| `workspace-files.spec.ts:131` | 找不到文案「系统文件操作直访」 | 该文案在 `src/` 已不存在（`grep 直访` = 0），环境页展示的是新的执行配置投影 |
| `workspace-management.spec.ts:65` | 找不到「暂无工作区」 | `/workspace` 现渲染 `WorkspacePicker`（PLAN-0608 C′），空态文案是「你还没有工作区」 |
| `session-management.spec.ts:51` | `locator('aside')` strict 冲突（2 个：`sidebar` + `workspace-aux-panel`） | dock 面板也是 `<aside>`（PLAN-0582）；选择器该收敛到 `getByTestId("sidebar")` |
| `checkpoint-rollback.spec.ts:299` | 390 视口下 `chat-input` 不可见 | 移动端聊天在 `MobileChatSheet` 内，需先点「Open chat」（同 `policy-management.spec.ts:507` 的写法） |
| `session-agent-selection.spec.ts:252` | 「绑定」按钮 `disabled`，点不动 | PLAN-0621 F-01：无 `MANAGE_WORKSPACE_AGENTS` 时按钮**点之前**就禁用；该用例的「点了才吃 403」前提已退役 |

## 6. 未修：S（flaky）

修复后整车道有 4 条 flaky（重试后均通过，不进失败清单）：
`chat.spec.ts:36`、`context-templates.spec.ts:63`、`export-command.spec.ts:169`、`workspace-files.spec.ts:139`。
`POST /chat` 现在返回完整 `ChatRunResponse`，应用会真的开始一次 run（后续 `guidance`/`recovery` 请求变多），
时序压力上升；这几条在基线里是绿的，需在下一轮盯一次是否稳定。

## 7. 改动清单（只动夹具 + 1 处内部状态断言）

- `e2e/mock/helpers/auth.ts`：会话默认绑定 principal；`POST /chat` 回 `ChatRunResponse`；SSE `error` 带 `runId`；catch-all 放行名单收窄到三个精确路径。
- `e2e/mock/config-settings.spec.ts`、`e2e/mock/plan-0554-config-meta.spec.ts`：种 `capabilities`。
- `e2e/mock/data-controls.spec.ts`：`xihe-language` = `zh-CN`。
- `e2e/mock/model-popover.spec.ts`：连接键目录 + `provider-connections` stub；1 处 localStorage 形状断言补齐 scoped binding 字段。
- `e2e/mock/session-agent-selection.spec.ts`：`{agents:[…]}` 信封 + `bound`；补 `/me/permissions`；create body 断言补 `scope`。
- `e2e/mock/screenshots.spec.ts`：补 `/version`。
