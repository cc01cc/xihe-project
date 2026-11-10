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

### UI 单测稳定性判据（2026-11-06 实测基线）

- **判据**：同 commit、同机、`CI=1`、串行连跑 **3 轮** —— ①`Test Files`/`Tests` 计数一致 ②`failed` 三轮恒 0 ③`skipped` 恒等 ④`Duration` 极差 ≤5%。四条同时满足才叫"本机稳定"，**一次全绿不算**。
- **基线（`39a8e929` 口径，2026-11-06 实测）**：`165 files / 1720 passed / 3 skipped / 151–153 s`（细分：transform ~4.3 · setup ~7.7 · import ~27 · tests ~21.7 · environment ~75.5 s）。
- **能测出**：顺序性/随机 flake、明显性能回归、"修完只跑一次"的假绿。**测不出**：慢机器/CI（真实 `sleep` 类等待会先崩）、并发与分片 flake（`BL-308` 记过分片敏感）、时区/日期/随机种子边界、跨文件全局状态污染、真实网络/DB（全 mock）。
- **进阶检查**：`--sequence.shuffle`（随机顺序，可配 `--sequence.seed=<n>` 复现）与 `--maxWorkers=1`（单 worker）。2026-11-06 实测：**shuffle 暴露 5 文件 / 8–9 用例的顺序依赖（可复现）**，而 `--maxWorkers=1` 全绿 ⇒ 污染只在多 worker 场景；隔离单跑那 5 个文件也全绿。
- **至少跑 3 个种子**：单种子 `--sequence.shuffle` 通过**不构成**稳定性证据 —— 2026-11-06 实测 `2/3` 通过（一条是已知 1/3 偶发，另一条换种子才照出来的 `Sidebar.spec.ts` 顺序依赖）。判据：**3 个种子全绿**才算 shuffle 干净。
- **经验值 ≠ 推导值**：`SessionMonitorPanel.spec.ts` 的 `sleep(650)`（真墙钟）与 `MessageListVirtual.spec.ts` 的 `for (round < 4) nextTick()`（"够用"的轮数）都是经验值，慢机会崩；改它们前先看文件内注释。

## 跨层与交互规则

- API、SSE 事件、TypeScript types、Pinia store、i18n 四层必须同波次同步；字段以 API/inventory 契约为准，不在 UI 私自重命名或猜测。
- 设置页 Provider 侧（ProviderHub、API 请求模板面板）与 Embedding 面板：层选择与「清除以继承」语义见 DEV-003 §3b；保存必须等真实 PUT 200；模板发布诊断来自 CP validator，UI 不得自动修复原文；embedding 固定模型/768 从 CP `contract` 读取，不硬编码；连接选择器按 `operation=chat` 过滤；连接名称 trim 后 1–40 个 code point 且不得含控制字符（PLAN-0563），DB 列宽仍为 128。连接弹窗不再提供 scope 选择：新建取当前页 scope，编辑沿用连接自身 scope；实例层只给用户/工作区层的跳转入口，工作区层入口指向 `/workspace/:id/settings?tab=config`（PLAN-0560）。
- 工作区设置页（PLAN-0560）：`/workspace/:workspaceId/settings` 承载常规（OWNER 编辑/删除 + 名称确认）/ 配置（workspace 层域，`ConfigLayerPanels` 复用）/ MCP（`WorkspaceMcpPanel`）三区块；`WorkspaceSettingsDialog` 已退役，全局配置页无工作区页签、只保留迁移提示与两层；工作区上下文逐 tab 存取，禁写 localStorage（`workspaceContext` 为唯一 SSOT）。
- 工作区成员 tab（PLAN-0565）：设置页第四 tab「成员」（`canViewMembers` 过滤渲染，裁定 #2 VIEWER 不渲染）；`WorkspaceMembersPanel` 承载列表/添加（按 username）/改角色/移除（AlertDialog 确认）；readonly 传 `!canManageWorkspace`（EDITOR 只读）；错误按 `ApiError.problem.code` 映射（裁定 #6 文案等），CP 权威、前端不复制授权逻辑。
- ~~Composer 模型标签（PLAN-0555）三段展示~~ **已废止（2026-11-04 用户裁定：移除 composer 模型选择器）**：`ModelPopover` 与工具栏入口已删除，composer 不再展示模型/连接段（避免"看起来像已绑"的误导，见 C1 `modelDisplay` 契约）；模型绑定改为发送时自动补绑（`bind-defaults`）+ 引导弹窗，`modelDisplay.ts` 仅作为"发送时会用什么"的只读解析器保留。
- 凭据页（PLAN-0553）：连接弹窗只做「输入 key 快速新建凭据」；凭据页「关联到连接」用 `PATCH /provider-connections/{id}` 的 `credentialId` 换绑，展示引用计数与删除 409 提示；不在连接弹窗里选择已有凭据。
- Vue `t()` 消息不得包含 `{...}` placeholder；locale 文本按实际插值参数编写。机器判据：`mise run lint:i18n`（`scripts/i18n-scan.mjs`，只读三查：两侧键差集 / 同键占位漂移 / 源码 `t("…")` 静态引用；通过时零输出）。改 locale 前后都跑它 —— 它抓到过 `chat.*` 写 `workspace.*` 键的裸 key 事故。
- 语言切换（PLAN-0602）：唯一入口 `src/i18n/locale.ts#applyLocale`（同时写 `i18n.global.locale` 与 `<html lang>`），持久化经 `useSettingsStore().setLanguage` 落到 `xihe-language`（VueUse 字符串序列化 = **raw 字符串**，不是 JSON）；启动期由 `main.ts` 的 `initLanguage()` 统一应用。业务代码**禁止**直接写 `i18n.global.locale` 或改 `<html lang>`；新增语言只加 `SUPPORTED_LOCALES` 与两侧资源。
- 新增或修改 UI 合同、焦点/键盘行为、弹窗、流式交互或动画/过渡时必须用真实浏览器验证；组件单测不能替代 Playwright 证据。
- 新 E2E 禁止固定 `sleep`/`waitForTimeout`；使用显式 timeout、readiness、事件或轮询。具体命令与超时策略见 [`command-execution-strategies`](../../../.agents/skills/command-execution-strategies/SKILL.md)。
- E2E 必须覆盖代表性移动 viewport；响应式改动至少检查移动与桌面。截图断言只证明接近 baseline，不能不经 actual/diff 与 DOM/computed-style 复核就更新 snapshot。
- 不得无审查执行 snapshot 更新；必须先做视觉 diff review，并记录为何接受差异。
- 跨模块 API/SSE/持久化改动按 [`xc-cross-cutting-checklist`](../../../.agents/skills/xc-cross-cutting-checklist/SKILL.md) 对齐契约、实现、测试与证据。
- **注意力预算（2026-11-03 用户裁定，配色判定标准）**：视觉权重按注意力的用途分配，不按元素身份。判定新元素该不该上彩色先问三题：多常用 / 多不可逆 / 多难发现 —— **会误操作才值得上色**（例：「新建对话」低频可逆 ⇒ 中性不用品牌色）。层级：L0 表面 / L1 内容 / L2 可操作（中性）/ L3 强调（主 CTA、选中指示、焦点环，**每屏 ≤2**）/ L4 危险（红，**每屏 ≤1**，只在确认时出现）。状态矩阵：hover 只加浅底；**focus 必须环形轮廓且与 hover 可区分**；selected 用左侧 2px 指示条+浅底不整行填色；disabled 保持 ≥3:1；danger 红只染危险元素。判定细则与完整表见 [DEV-011 §10](../../docs/i18n/zh-Hans/DEV-011-ui-checklist.md)。
- **页面高度链不变式（2026-11-03，PLAN-0626 P2 修复）**：`AppLayout` 在有页签栏（桌面 `/workspace/*`）时把 `main` 变 **flex 列**，路由页放入 `min-h-0 flex-1 overflow-y-auto` 容器（`data-testid=workspace-route-viewport`）——**页面拿到的是页签栏以下的剩余高度**。会话列与 `ChatPanel` 必须逐层 `min-h-0`/`flex-1`（`h-full` 会因 36px 页签栏多出一整屏）。此前该链断裂导致**消息视口不限高（`clientH == scrollH`，长会话滚不动）**与 **dock 底部被裁 36px** 两个症状，实证与回归见 `plans/PLAN-0626-XH-workspace-side-tabs/tasks.md`。全局路由（`/settings/*` 等）仍由 `main` 自身滚动，行为不变。
- 布局持久化（PLAN-0582）：键与语义固定 —— 全局 `xihe-layout-global` = `{ navOpen, navWidth }`；每 workspace `xihe-layout-ws:<id>` = `{ treeCollapsed, treeWidth, dockCollapsed, dockWidth, dockTabs, activeDockTab, dockMode, dockModeManual, openTabs }`。**折叠态与宽度分开存**（收起不改宽度、展开回原宽）；登出清理 workspace 键。唯一实现入口 `composables/useWorkspaceLayout.ts`（常量 `:24-46`、状态接口 `:58-79`），不要另建第二份布局状态。
- dock 两模式（PLAN-0582 §1.5-B）：`dockMode: 'pinned' | 'floating'`，**默认按断点派生**（`deriveDockMode`：视口 ≥1800 → `pinned`，否则 `floating`）；`dockModeManual` 记录用户是否手选过，**手选优先于断点派生并持久化**。pinned 是 flex 子项（主列让位）；floating 是绝对定位覆盖（`WorkspaceDock.vue:61`：pinned `relative z-auto shadow-none` / floating `absolute inset-y-0 right-0 z-20 shadow-xl`）。**只有 floating 允许阴影**；floating **不是模态**——不加遮罩（会挡住用户正在编辑的主列），用 `Esc` 或点击主列关闭。
- **dockview 已停用但依赖保留（PLAN-0756；用户 2026-11-10 裁定：保留依赖、MVP 不使用）**：`WorkspaceDock.vue` 里 `import WorkspaceDockviewDock` 与 dockview 渲染分支**整段注释**，`dockviewEnabled` 恒 false ⇒ **产品路径只有手写 dock 一条**，`useDockview` prop 与 `globalThis.__xhUseDockview` 注入**当前均无效**。保留未删：`WorkspaceDockviewDock.vue`、`src/lib/dockview.ts`（含单测，仍须绿）、`styles/dockview-theme.css`、`dockview-vue`/`dockview-core` 依赖、`e2e/mock/pl0756-dockview.spec.ts`（已 `test.describe.skip`）。**重新启用三步**（注释块内也写了）：① 取消 import 与模板分支注释；② 接 `import "dockview-vue/dist/styles/dockview.css"`（**BL-564**：产品侧至今未引，翻旗后布局无样式，且须排在 `dockview-theme.css` 之前）；③ 先定 **BL-561** 键盘语义（dock 整体宽度 vs dockview 组边界）。设计史（若恢复仍适用）：两个渲染分支并存、**持久面单一 writer 不变**（`xihe-layout-ws:<id>` 的 `dockTabs`/`activeDockTab`/`dockWidth`/`dockMode`/`dockModeManual`），dockview 序列化只作投影，往返纯函数在 `src/lib/dockview.ts`；三条硬约束：① `DOCKVIEW_OPTIONS.proportionalLayout` **必须 false**；② `theme` 只能传 `dockview-core` 的 `themeLight` **对象**（字符串抛 `TypeError`）；③ **jsdom 不能测 dockview**，集成验证一律 Playwright，单测只覆盖 `lib/dockview.ts`。
- 三处栏宽（PLAN-0582 §1.5-A）：导航面板 **220–360**（默认 280）、文件树 **200–320**（默认 240、收起 40）、dock **320–480**（默认 360）——一律引用 `useWorkspaceLayout.ts` 常量（`:24-41`），不写字面量。分隔条统一：`role="separator"` + `aria-valuenow/min/max`、方向键 ±16（`*_KEYBOARD_STEP`）、`Home`/`End` 到边界、**双击复位默认宽**、拖拽时显示实时宽度浮标。窄屏夹取（`clampNavWidthForViewport`：<1280 → 240、<1440 → 260、否则 360）**只影响渲染，不得写回**用户原值。防挤压按 spec §1.5-C：主列硬底线 **640**（`MAIN_MIN_WIDTH`）最高优先 → pinned 且主列 <**720**（`MAIN_COMFORT_MIN_WIDTH`）先让**文件树**让位 → 仍不足再让**导航面板**（顺序固定）→ 仍 <640 时 dock 转 floating（**不关 dock**，用户 pinned 选择保留）并给一次性提示。
- 工作区选择面（PLAN-0608 C′）：`/workspace` 在**无 tab 上下文**时渲染 `components/WorkspacePicker.vue`（角色取 `GET /workspaces` 权威值）；`WorkspaceView` 收到 `400 WORKSPACE_CONTEXT_CONFLICT` / `409 WORKSPACE_CONTEXT_REQUIRED` 时**回选择面**，不得只弹 toast 成死路。**I6：登录响应里的 workspace 只是 fallback**，绝不写进 tab 上下文——`stores/auth.ts` 的 `hydrateWorkspace` 不再用 `/workspaces/current` 回填（与上文「工作区上下文逐 tab 存取、`workspaceContext` 为唯一 SSOT」同源）；新建会话走路径形式 `POST /api/v1/workspaces/{workspaceId}/sessions`。
  - ~~**I6 例外（2026-11-01 裁定，BL-169）**~~ **已随 PLAN-0758（D-787）移除**：本地模式免密自动登录分支删除后，I6 无例外——登录响应消费方一律不得回填 tab 上下文。

### Reka UI 交互陷阱

- `ComboboxContent position="popper"` 的触发器必须由 `ComboboxAnchor` 包裹，否则内容可能定位到视口外且没有报错。
- `CollapsibleTrigger` 已自带切换行为，不得再绑定一次 click，否则会双重翻转。
- `AlertDialogAction` 点击后无条件关闭；校验失败需要保持对话框时用普通 destructive `Button` 并显式控制关闭。
- MenuItem 的程序化选择不由 jsdom 覆盖；交互行为用 Playwright 验证。

## UI 预览（mock）工作流（2026-11-03 用户裁定）

- **禁止手写静态 HTML 预览稿**。所有 UI 预览、评审稿、宣传配图稿必须用**真组件 + mock 数据**渲染——手写 HTML 只仿外形，组件、图标、间距与真实不一致，已造成一次返工。
- 载体优先 `preview.html` + `src/preview/main.ts`（Vite 多入口，独立 `createApp`，**不进产品路由**）；退路 `/__ui-preview` 路由且必须用 `import.meta.env.DEV` 守卫，生产不可达。
- 图标用 `@lucide/vue`；样式只用产品 token 与 `components/ui/*`；**不新增色阶、不引入第二套设计语言**。
- 全部 mock（本地对象/ref），**不调任何 `/api/v1/**`**；每个区块在 **1920×1080**（最小）下单屏可截图、不跨屏截断；1440×900 只作为"窄屏不塌"的附加检查，不作为交付尺寸。
- 覆盖面为常态维护项：工作台主面板（含 **TO / CC**）、智能体面板、记忆面板、配置页（ProviderHub + API 请求模板）、凭据与角色页、审批卡与工具调用卡、空/加载/错误/无权限四态。
- 「页面上点了保存没反应」这类问题，真栈 E2E 才能发现；预览页只解决"看"，不替代 E2E 证据。
- **截图执行器**：`packages/ui/scripts/ui-mock-shot.mjs` —— 交付图的唯一拍法（自起自关 dev server，或 `--url` 复用已起的；连拍两次比 sha，抖动即非 0 退出；输出目录取 `--out`，默认 `../../.tmp/xh/ui-mock-shot`）。**禁止手拍交付图**：手拍的 PNG 无法用「commit sha + 一条命令」重建。
  - **探活（task-84 修好，2026-11-11 实测自起自关可用）**：两条路径都先探活，候选列表**并行**打 —— vite 自己打印的 `Local:` host → `127.0.0.1` → `localhost` → `[::1]`，**每个请求各自 2 s 上限**，所以一个挂住的请求吃不掉整个预算（旧版没有单次超时：一次挂住 = 循环再也检查不到 deadline，最后报「120 s 没就绪」，与根因脱钩）。探不通时 exit 2 并打印**每个 URL 的尝试次数 / 最后一次耗时 / 错误码** + 一层 TCP 直连诊断（区分「没人听」与「听了但 HTTP 不应答」）+ vite 输出尾部；`--url` 复用模式在 TCP 也连不上时**约 1 s 快速失败**（2026-11-11 实测 1 s / exit 2，旧版是 120 s 黑盒等待）。manifest 新增 `server: { mode: "spawned"|"reused", base, readyVia }` —— 图是自起拍的还是复用拍的，事后可从 manifest 读。自检：`node packages/ui/scripts/ui-mock-shot.mjs --selftest`（不开浏览器、不起 server，实测 10 项 ~0.6 s）。**浏览器指纹（task-92，2026-11-11）**：manifest 新增 `browser: { channel, version, chromiumArgs }`，控制台也打一行 `浏览器: <channel> <version> args=…` —— 换浏览器整张图就会变（实测 `--channel chrome`/`msedge` 让 04 主图从 `0525a43b` 变成 `8901dbee`），而在此之前产物里没有任何字段能说明这件事，只能靠"主图 sha 只被某个 channel 复现"反推 —— **靠反推才能知道的事实等于没有记录**。`--chromium-arg` 可重复传、原样进 `chromium.launch` 的 `args`（例：`--chromium-arg=--disable-gpu` 强制软件合成），用于把"同一 commit 两批图不一样"的变量逐个关掉。
    > **版本注记（task-84，2026-11-11）**：本行只对**本分支**成立 —— 自 `39f52a530`（`task/34-mock-gates`）起才有 `--selftest` 与并行探活；`develop`（截至 `f13178d2a`）的 `ui-mock-shot.mjs` **没有**这两个能力，自起自关仍会 120 s 超时、manifest 也没有 `server` 字段。该提交并入 develop 后请把本行改成「已随合并在 develop 生效」或直接删掉。
  - **脏树交付的判据是「证明」而不是「树干净」**（2026-11-11 改，取代旧口径「交付图不得带 `allowDirty: true`」）：脏树仍然默认拒拍（`git status --porcelain` 非空即 exit 1），但可用 `--allow-dirty --dirty-proof <json>` 出交付批次 —— **每个**脏路径必须给一条**可复算命令**，脚本亲自跑它、把 `command` / `exit` / 实际 `output` 一起写进 `manifest.dirtyNonRendering`，缺一条就 exit 1 点名缺哪条；证明里写 `expect: "empty"` 时「命令有输出」直接报错。旧口径废止的理由：它把手段（干净树）当目的，结果是任何队友的未提交 WIP 都能永久卡死交付，而唯一出路（动别人的文件）恰是我们明令禁止的 —— **一条会把人逼去做被禁止之事的门是负价值门**。 证明文件本身通常不进 git（放在 `.tmp`/`one/.tmp` 下），所以 manifest 只能钉住它的 `sha256_16`（`dirtyProof`）：**那个 `path` 只是当时的位置，丢了证明文件就无法复算**，要留证据就把证明 JSON 一起归档到证据包。

  - **批次比对判据（2026-11-11 裁定，取代「7/7 逐字节相同才对」）**：旧判据隐含「截图是纯确定性的」这个假设，而滚动帧的抗锯齿覆盖率取整会受合成路径影响 ⇒ **判据会假红**；一条会假红的判据会被绕过，且绕过它的人是对的（与「dirty 必须为空」同病：把手段当目的）。现行判据：**通过 = 逐字节相同 ≥6/7，且差异张必须给出「坐标清单 + 每点通道与 Δ + 差异像素占全图比例 + 该位置是否落在文本字形/布局/位移上」**；差异落在内容（字形/布局/位移/颜色语义）⇒ 不通过；只落在抗锯齿覆盖率最低位（每通道 ≤1 LSB）⇒ 通过，但必须记为「**合成级差异**」。实证（task-72 第 3 腿）：6/7 逐字节相同，第 7 张 4 个像素各差 1 LSB 且只在蓝通道、占比 1.9e-6、位置是左栏搜索框 `rounded-full` 圆角 AA ⇒ 判通过（合成级差异）。**注意**：判"通过"与"机制已查明"是两件事 —— 前者靠四条互相独立的排除证据（内容/浏览器构建/服务路径/树内 WIP 各自堵死一条替代解释），后者才需要合成假设被验证。

## Session / Agent Principal

- 新建 Session 必须显式携带已绑定 Agent 的 `agentPrincipalId`（`POST /api/v1/sessions`）；principal-null 空 Session **不再**在首次发送前于 UI 选择 principal——会话身份绑定在创建时确定（PLAN-0689 B3 删除 F6 占位路径）。
- Workspace Agent 管理面板读写 `/api/v1/workspaces/{id}/agents`，principal 创建走 `/api/v1/agent-principals`；创建与绑定分别授权（`CREATE_ACCOUNT` / `MANAGE_WORKSPACE_AGENTS`）。契约见根级 `spec/agent/principal-workspace-binding.md`。

## 权限边界

允许修改本包源码、测试与本包构建配置；新增依赖、破坏式 API、跨包协议变更和生产部署须先获批准。不得把 Mock E2E 当作真实链路完成证据，不得提交本地截图工件或凭据。

测试策略见 [`test`](../../../.agents/skills/test/SKILL.md) 与 [`playwright`](../../../.agents/skills/playwright/SKILL.md)；跨层契约同步见上方 checklist。

父级指南：[`A03-xihe/AGENTS.md`](../../AGENTS.md)。

- 配置页来源展示（PLAN-0554）：使用 GET /config/{domain}/meta，只读展示 source/继承/env 锁定；不出现锁定开关；Provider 连接的新建只在 User/Workspace 层。
- 管理员锁定（PLAN-0556）：锁定页是独立 ADMIN 路由 `/settings/config-locks`，导航项仅 ADMIN 可见，非 ADMIN 直链渲染 403 视图；普通配置页只显示「由管理员锁定」徽标与原因并禁用控件，不提供锁定/解锁入口；env 锁定与管理员锁定必须用不同徽标与文案。
- 设置信息架构（PLAN-0752，已实施）：设置区骨架是**层 × 域**，层只由一处决定 —— 路由 `meta.settingsLayer`，兜底页用 `lib/settingsIa.ts#settingsLayerForPath()` 从路径推；矩阵（instance 12 / user 9 / workspace 9）同在该文件，别在组件里另写一份。左栏是 `components/settings/SettingsSidebar.vue` + `SettingsResourceNav.vue`（后端缺口 = **标缺口的按钮** + 解释弹窗，不伪装成可用入口）。权限两面**不许混用**：`SettingsPermissionGate` 的 `no-atom`（信息条 `settings-no-atom-notice`，CP 侧本没有这个原子，页面照常取数）与 `atom-denied`（403 卡片 `settings-atom-denied`，点名缺失原子 + 明写「不是后端缺口」，主体不挂载 ⇒ 不发无谓请求）。工作区层入口是 tab（`features/workspace/pages/WorkspaceSettingsView.vue` 的 `general|config|mcp|members|credentials|knowledge`，`data-testid="ws-settings-tab-*"`），不新开页；`/settings/knowledge` 旧路径已改工作区重定向。判定依据：`internal/A03-xihe/docs/resource-layer-permission-audit.md` §C2 + `internal/A03-xihe/docs/settings-m2-migration-matrix.md` §8.2（跨仓私有层）。
- 管理员 Principal 授权（PLAN-0585）：`/settings/principal-grants` 是独立 ADMIN 路由（nav 仅 ADMIN 可见，非 ADMIN 直链渲染 403 视图）；按 **username 精确匹配**（不折叠大小写）寻址，只写目标账号的 `source='direct'` 授权行；`CREATE_ACCOUNT` 的 resource 固定 `*`，`MANAGE_WORKSPACE_AGENTS` 必须填具体 workspace UUID（禁 `*`，UI 负责格式校验与去重）；保存走 PATCH 差集，按回显 `changed:true|false` 展示（false = 幂等重放、无新审计）；错误按 `ApiError.problem.code` 映射本地化文案，**不得直显 CP 英文 detail**；无权限的 Agent 创建/绑定入口必须给出指向本页的可操作提示（F-02）。
