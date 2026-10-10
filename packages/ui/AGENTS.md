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
pnpm run lint
pnpm run build
```

`pnpm run lint` = `oxfmt --check . && oxlint .`。Oxlint 启用 `typescript`、`import`、`unicorn`、`oxc`；Vitest 插件作用于 `src/**/__tests__/**`、`src/**/*.spec.ts` 和 `src/**/*.test.ts`，并阻断 `require-mock-type-parameters` 与 `require-to-throw-message`，其他 Vitest 规则保持关闭。Vue 插件和 template lint 不属于当前门禁，TypeScript/SFC 类型检查由 `pnpm run typecheck`（`vue-tsc --noEmit`）负责。Oxfmt 版本固定为 0.68.0；`.oxfmtrc.jsonc` 显式设置 `tabWidth: 4`、`printWidth: 100`，忽略 Markdown 与 `AGENTS.md`，`proseWrap` 保持未设置以维持原有零漂移行为。全包格式已在 formatter 波次全量应用（419 个历史漂移文件清零），新增/修改文件必须保持已格式化，禁止整包随意 `--write` 后不经 diff 复核入库。其他 style warnings 仍须看完整输出；lint 成功不代表零告警。

`test:unit -- ...` 后接实际测试文件或 Vitest 参数。完整 `pnpm run test:unit` 与全量 E2E 只在测试波次或里程碑执行；不要把全套验证当作每次小改默认动作。

## 跨层与交互规则

- API、SSE 事件、TypeScript types、Pinia store、i18n 四层必须同波次同步；字段以 API/inventory 契约为准，不在 UI 私自重命名或猜测。
- Vue `t()` 消息不得包含 `{...}` placeholder；locale 文本按实际插值参数编写。
- 新增或修改 UI 合同、焦点/键盘行为、弹窗、流式交互或动画/过渡时必须用真实浏览器验证；组件单测不能替代 Playwright 证据。
- 新 E2E 禁止固定 `sleep`/`waitForTimeout`；使用显式 timeout、readiness、事件或轮询。具体命令与超时策略见 [`command-execution-strategies`](../../../.agents/skills/command-execution-strategies/SKILL.md)。
- E2E 必须覆盖代表性移动 viewport；响应式改动至少检查移动与桌面。截图断言只证明接近 baseline，不能不经 actual/diff 与 DOM/computed-style 复核就更新 snapshot。
- 不得无审查执行 snapshot 更新；必须先做视觉 diff review，并记录为何接受差异。
- 跨模块 API/SSE/持久化改动按 [`xc-cross-cutting-checklist`](../../../.agents/skills/xc-cross-cutting-checklist/SKILL.md) 对齐契约、实现、测试与证据。

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
