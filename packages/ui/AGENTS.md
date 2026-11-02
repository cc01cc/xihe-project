# UI 包指南

## 定位与技术栈

本包是 Xihe 的 Vue 单页前端，负责 Chat、Workspace、设置与审批等界面。技术版本以 `package.json` 为准（Vue、Vite、Pinia、TypeScript、Vitest、Playwright、vue-tsc、oxlint、Tailwind CSS）。

设计、契约与测试基线：
- [`DEV-010-ui-architecture.md`](../../docs/i18n/zh-Hans/DEV-010-ui-architecture.md)
- [`DEV-011-ui-checklist.md`](../../docs/i18n/zh-Hans/DEV-011-ui-checklist.md)
- [`DEV-020-e2e-test-strategy.md`](../../docs/i18n/zh-Hans/DEV-020-e2e-test-strategy.md)
- [`DEV-021-integration-test-strategy.md`](../../docs/i18n/zh-Hans/DEV-021-integration-test-strategy.md)

## 目录与命令

- `src/features/workspace/`：Workspace 页面、组件、状态与交互；`src/features/workspace/chat/`：Workspace Chat UI、ChatStore、Session 列表与 Chat SSE composables。
- `src/components/`、`src/composables/`、`src/stores/`：跨 feature 共享 UI、composables 与状态；`src/types/`：跨层类型；`src/i18n/`：本地化。
- `src/**/__tests__/`：Vitest 单元测试；`e2e/mock/`：Mock E2E；`e2e/real/`：真实链路 E2E。
- UI 是 XH 唯一 pnpm 包；`pnpm-workspace.yaml`、pnpm 安全策略和唯一 lock 都归本目录。运行 `pnpm install` 或通过 `mise` UI 任务使用该包根；不要加 `--ignore-workspace`。

Session/ChatRun、Workspace Job、MCP invocation、Agent 可见状态及 UI 交互/设计/无障碍的目标态见 `../../spec/` 对应 proposed SPEC，不能当作已实现事实；UI store 只做本地视图（非权威），不拥有 CP durable lifecycle。

在本目录执行聚焦验证：

```bash
pnpm run test:unit -- src/features/workspace/chat/__tests__/ChatPanel.spec.ts
pnpm run typecheck
pnpm run typecheck:e2e
pnpm run lint
pnpm run build
```

**e2e 类型门**：`e2e/` 不在 `tsconfig.json` 的 `include` 内（现状只覆盖 `src/**` 与 `vite.config.ts`），所以另立 `pnpm run typecheck:e2e`（`tsconfig.e2e.json` + `scripts/typecheck-e2e.mjs`）：跑 `tsc --noEmit` 后与 `e2e-typecheck-baseline.json` 比对，**只拦新增错误**（存量 **58** 条按"文件 × TS 码"计数在册，来源是 Playwright 1.5x 类型与 DOM lib 的既有冲突，属独立技术债）。基线**只允许缩小**：修好存量后用 `node scripts/typecheck-e2e.mjs --write-baseline` 收账（脚本会打印"已消失条目"）；新增文件不得照搬旧写法，门会红灯。

`pnpm run lint` = `oxfmt --check . && oxlint .`。**判据：oxfmt 全绿 + oxlint `0 error`（基线就是 0，不设基线）**；warnings 允许但必须看完整输出（当前约 5.8k 条存量、按规则分布，见下）。Oxlint 启用 `typescript`、`import`、`unicorn`、`oxc`；Vitest 插件作用于 `src/**/__tests__/**`、`src/**/*.spec.ts` 和 `src/**/*.test.ts`，并阻断 `require-mock-type-parameters` 与 `require-to-throw-message`，其他 Vitest 规则保持关闭。Vue 插件和 template lint 不属于当前门禁，TypeScript/SFC 类型检查由 `pnpm run typecheck`（`vue-tsc --noEmit`）负责。Vue template lint 为**已知限制**（现状仅 `<script>` 被 lint）：等待 oxlint 原生支持，跟踪 oxc language-plugins umbrella #23207 / Phase-1 #24597 与 [oxc compatibility 页](https://oxc.rs/compatibility.html)；复查触发条件为 oxlint 版本升级或出现真实 template 结构缺陷（`v-for` 缺 key、重复属性等）；裁定见 PLAN-0479 决策 #4。Oxfmt 版本固定为 0.68.0；`.oxfmtrc.jsonc` 显式设置 `tabWidth: 4`、`printWidth: 100`，忽略 Markdown 与 `AGENTS.md`，`proseWrap` 保持未设置以维持原有零漂移行为。全包格式已在 formatter 波次全量应用（419 个历史漂移文件清零），新增/修改文件必须保持已格式化，禁止整包随意 `--write` 后不经 diff 复核入库。

`test:unit -- ...` 后接实际测试文件或 Vitest 参数。完整 `pnpm run test:unit` 与全量 E2E 只在测试波次或里程碑执行；不要把全套验证当作每次小改默认动作。

## 跨层与交互规则

- API、SSE 事件、TypeScript types、Pinia store、i18n 四层必须同波次同步；字段以 API/inventory 契约为准，不在 UI 私自重命名或猜测。
- 设置页 Provider 侧（ProviderHub、API 请求模板面板）与 Embedding 面板：层选择与「清除以继承」语义见 DEV-003 §3b；保存必须等真实 PUT 200；模板发布诊断来自 CP validator，UI 不得自动修复原文；embedding 固定模型/768 从 CP `contract` 读取，不硬编码；连接选择器按 `operation=chat` 过滤；连接名称 trim 后 1–40 个 code point 且不得含控制字符（PLAN-0563），DB 列宽仍为 128。连接弹窗不再提供 scope 选择：新建取当前页 scope，编辑沿用连接自身 scope；实例层只给用户/工作区层的跳转入口，工作区层入口指向 `/workspace/:id/settings?tab=config`（PLAN-0560）。
- 工作区设置页（PLAN-0560）：`/workspace/:workspaceId/settings` 承载常规（OWNER 编辑/删除 + 名称确认）/ 配置（workspace 层域，`ConfigLayerPanels` 复用）/ MCP（`WorkspaceMcpPanel`）三区块；`WorkspaceSettingsDialog` 已退役，全局配置页无工作区页签、只保留迁移提示与两层；工作区上下文逐 tab 存取，禁写 localStorage（`workspaceContext` 为唯一 SSOT）。
- 工作区成员 tab（PLAN-0565）：设置页第四 tab「成员」（`canViewMembers` 过滤渲染，裁定 #2 VIEWER 不渲染）；`WorkspaceMembersPanel` 承载列表/添加（按 username）/改角色/移除（AlertDialog 确认）；readonly 传 `!canManageWorkspace`（EDITOR 只读）；错误按 `ApiError.problem.code` 映射（裁定 #6 文案等），CP 权威、前端不复制授权逻辑。
- Composer 模型标签（PLAN-0555）：始终三段 `model · provider displayName · connection display`；连接段按「服务端会话 → 本地 binding → llm-provider profile」解析，`label` 优先、`connectionKey` 兜底，加载中显示加载态、无来源显示 `—`；桌面 hover 显示全文，触屏无 tooltip（全文在展开层）；不新增 composer 右侧详情面板。
- 凭据页（PLAN-0553）：连接弹窗只做「输入 key 快速新建凭据」；凭据页「关联到连接」用 `PATCH /provider-connections/{id}` 的 `credentialId` 换绑，展示引用计数与删除 409 提示；不在连接弹窗里选择已有凭据。
- Vue `t()` 消息不得包含 `{...}` placeholder；locale 文本按实际插值参数编写。
- 语言切换（PLAN-0602）：唯一入口 `src/i18n/locale.ts#applyLocale`（同时写 `i18n.global.locale` 与 `<html lang>`），持久化经 `useSettingsStore().setLanguage` 落到 `xihe-language`（VueUse 字符串序列化 = **raw 字符串**，不是 JSON）；启动期由 `main.ts` 的 `initLanguage()` 统一应用。业务代码**禁止**直接写 `i18n.global.locale` 或改 `<html lang>`；新增语言只加 `SUPPORTED_LOCALES` 与两侧资源。
- 新增或修改 UI 合同、焦点/键盘行为、弹窗、流式交互或动画/过渡时必须用真实浏览器验证；组件单测不能替代 Playwright 证据。
- 新 E2E 禁止固定 `sleep`/`waitForTimeout`；使用显式 timeout、readiness、事件或轮询。具体命令与超时策略见 [`command-execution-strategies`](../../../.agents/skills/command-execution-strategies/SKILL.md)。
- E2E 必须覆盖代表性移动 viewport；响应式改动至少检查移动与桌面。截图断言只证明接近 baseline，不能不经 actual/diff 与 DOM/computed-style 复核就更新 snapshot。
- 不得无审查执行 snapshot 更新；必须先做视觉 diff review，并记录为何接受差异。
- 跨模块 API/SSE/持久化改动按 [`xc-cross-cutting-checklist`](../../../.agents/skills/xc-cross-cutting-checklist/SKILL.md) 对齐契约、实现、测试与证据。
- **页面高度链不变式（2026-11-03，PLAN-0626 P2 修复）**：`AppLayout` 在有页签栏（桌面 `/workspace/*`）时把 `main` 变 **flex 列**，路由页放入 `min-h-0 flex-1 overflow-y-auto` 容器（`data-testid=workspace-route-viewport`）——**页面拿到的是页签栏以下的剩余高度**。会话列与 `ChatPanel` 必须逐层 `min-h-0`/`flex-1`（`h-full` 会因 36px 页签栏多出一整屏）。此前该链断裂导致**消息视口不限高（`clientH == scrollH`，长会话滚不动）**与 **dock 底部被裁 36px** 两个症状，实证与回归见 `plans/PLAN-0626-XH-workspace-side-tabs/tasks.md`。全局路由（`/settings/*` 等）仍由 `main` 自身滚动，行为不变。
- 布局持久化（PLAN-0582）：键与语义固定 —— 全局 `xihe-layout-global` = `{ navOpen, navWidth }`；每 workspace `xihe-layout-ws:<id>` = `{ treeCollapsed, treeWidth, dockCollapsed, dockWidth, dockTabs, activeDockTab, dockMode, dockModeManual, openTabs }`。**折叠态与宽度分开存**（收起不改宽度、展开回原宽）；登出清理 workspace 键。唯一实现入口 `composables/useWorkspaceLayout.ts`（常量 `:24-46`、状态接口 `:58-79`），不要另建第二份布局状态。
- dock 两模式（PLAN-0582 §1.5-B）：`dockMode: 'pinned' | 'floating'`，**默认按断点派生**（`deriveDockMode`：视口 ≥1800 → `pinned`，否则 `floating`）；`dockModeManual` 记录用户是否手选过，**手选优先于断点派生并持久化**。pinned 是 flex 子项（主列让位）；floating 是绝对定位覆盖（`WorkspaceDock.vue:61`：pinned `relative z-auto shadow-none` / floating `absolute inset-y-0 right-0 z-20 shadow-xl`）。**只有 floating 允许阴影**；floating **不是模态**——不加遮罩（会挡住用户正在编辑的主列），用 `Esc` 或点击主列关闭。
- 三处栏宽（PLAN-0582 §1.5-A）：导航面板 **220–360**（默认 280）、文件树 **200–320**（默认 240、收起 40）、dock **320–480**（默认 360）——一律引用 `useWorkspaceLayout.ts` 常量（`:24-41`），不写字面量。分隔条统一：`role="separator"` + `aria-valuenow/min/max`、方向键 ±16（`*_KEYBOARD_STEP`）、`Home`/`End` 到边界、**双击复位默认宽**、拖拽时显示实时宽度浮标。窄屏夹取（`clampNavWidthForViewport`：<1280 → 240、<1440 → 260、否则 360）**只影响渲染，不得写回**用户原值。防挤压按 spec §1.5-C：主列硬底线 **640**（`MAIN_MIN_WIDTH`）最高优先 → pinned 且主列 <**720**（`MAIN_COMFORT_MIN_WIDTH`）先让**文件树**让位 → 仍不足再让**导航面板**（顺序固定）→ 仍 <640 时 dock 转 floating（**不关 dock**，用户 pinned 选择保留）并给一次性提示。
- 工作区选择面（PLAN-0608 C′）：`/workspace` 在**无 tab 上下文**时渲染 `components/WorkspacePicker.vue`（角色取 `GET /workspaces` 权威值）；`WorkspaceView` 收到 `400 WORKSPACE_CONTEXT_CONFLICT` / `409 WORKSPACE_CONTEXT_REQUIRED` 时**回选择面**，不得只弹 toast 成死路。**I6：登录响应里的 workspace 只是 fallback**，绝不写进 tab 上下文——`stores/auth.ts` 的 `hydrateWorkspace` 不再用 `/workspaces/current` 回填（与上文「工作区上下文逐 tab 存取、`workspaceContext` 为唯一 SSOT」同源）；新建会话走路径形式 `POST /api/v1/workspaces/{workspaceId}/sessions`。
  - **I6 例外（2026-11-01 裁定，BL-169）**：`router/index.ts` 的 **localMode 免密自动登录**分支（`api.localLogin()`）把响应里的 `workspace`/`workspaceId` 写入 tab 上下文是**有意行为**——单用户本地模式下直接进入唯一工作区，比先展示一个只有一项的选择面更合理；该写入只发生在守卫内，且 `adoptGuardSession` **不清**上下文（因为守卫刚写入的就是本次目标）。`hydrateWorkspace` 等**登录响应消费方**仍受 I6 约束，不得回填。

### Reka UI 交互陷阱

- `ComboboxContent position="popper"` 的触发器必须由 `ComboboxAnchor` 包裹，否则内容可能定位到视口外且没有报错。
- `CollapsibleTrigger` 已自带切换行为，不得再绑定一次 click，否则会双重翻转。
- `AlertDialogAction` 点击后无条件关闭；校验失败需要保持对话框时用普通 destructive `Button` 并显式控制关闭。
- MenuItem 的程序化选择不由 jsdom 覆盖；交互行为用 Playwright 验证。

## Session / Agent Principal

- 新建 Session 必须显式携带已绑定 Agent 的 `agentPrincipalId`（`POST /api/v1/sessions`）；principal-null 空 Session 在首次发送前于 UI 选择 principal。
- Workspace Agent 管理面板读写 `/api/v1/workspaces/{id}/agents`，principal 创建走 `/api/v1/agent-principals`；创建与绑定分别授权（`CREATE_ACCOUNT` / `MANAGE_WORKSPACE_AGENTS`）。契约见根级 `spec/agent/principal-workspace-binding.md`。

## 权限边界

允许修改本包源码、测试与本包构建配置；新增依赖、破坏式 API、跨包协议变更和生产部署须先获批准。不得把 Mock E2E 当作真实链路完成证据，不得提交本地截图工件或凭据。

测试策略见 [`test`](../../../.agents/skills/test/SKILL.md) 与 [`playwright`](../../../.agents/skills/playwright/SKILL.md)；跨层契约同步见上方 checklist。

父级指南：[`A03-xihe/AGENTS.md`](../../AGENTS.md)。

- 配置页来源展示（PLAN-0554）：使用 GET /config/{domain}/meta，只读展示 source/继承/env 锁定；不出现锁定开关；Provider 连接的新建只在 User/Workspace 层。
- 管理员锁定（PLAN-0556）：锁定页是独立 ADMIN 路由 `/settings/config-locks`，导航项仅 ADMIN 可见，非 ADMIN 直链渲染 403 视图；普通配置页只显示「由管理员锁定」徽标与原因并禁用控件，不提供锁定/解锁入口；env 锁定与管理员锁定必须用不同徽标与文案。
- 管理员 Principal 授权（PLAN-0585）：`/settings/principal-grants` 是独立 ADMIN 路由（nav 仅 ADMIN 可见，非 ADMIN 直链渲染 403 视图）；按 **username 精确匹配**（不折叠大小写）寻址，只写目标账号的 `source='direct'` 授权行；`CREATE_ACCOUNT` 的 resource 固定 `*`，`MANAGE_WORKSPACE_AGENTS` 必须填具体 workspace UUID（禁 `*`，UI 负责格式校验与去重）；保存走 PATCH 差集，按回显 `changed:true|false` 展示（false = 幂等重放、无新审计）；错误按 `ApiError.problem.code` 映射本地化文案，**不得直显 CP 英文 detail**；无权限的 Agent 创建/绑定入口必须给出指向本页的可操作提示（F-02）。
