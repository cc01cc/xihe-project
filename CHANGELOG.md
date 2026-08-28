# Changelog

## [Unreleased]

### Added

- 统一 HTTP API 契约：公开 API 使用 `/api/v1`、服务间 API 使用 `/internal/v1`，统一 Bearer 鉴权、camelCase 和 Problem Details；MCP/OAuth 协议字段保持原样。
- Remote MCP 最小闭环：UI OAuth（Authorization Code + PKCE）→ CP callback/加密 credential → Agent 只连 CP logical endpoint → Runtime 短期 token 调用远程 MCP，401 经 CP broker 单次 refresh/retry；requestState 绑定/TTL/一次性消费。
- 日志安全与可观测性：四模块序列化层统一脱敏（token/JWT/Bearer/PEM → `***redacted***`），`X-Request-Id` 由 CP 生成并向 Runtime/Agent 贯通，审计日志持久化至 `logs/audit.log`，新增 `scripts/scan-log-secrets.mjs` 泄露扫描门禁。

### Changed

- Runtime 迁移至 Rust edition 2024 与 rmcp 3.1.4（MCP protocol `2026-07-28`）；测试基础设施修复：`e2e-real.mjs` 隔离端口全量生效，Runtime 全量测试可编译执行（201 passed / 3 ignored）。

- 实现 Agent 崩溃恢复：启动时可通过 `XIHE_RECOVER_SESSION_IDS` 从 CP Event Store 重放事件并重建会话状态
- CP 新增 `context_source_hashes` 表，`ContextSourceRefreshService` 持久化 AGENTS.md 最后哈希，避免重复生成 `context.source_changed` 事件
- CP 新增事件存储性能测试 `EventStoreServicePerformanceTest`，验证批量写入远高于单条写入
- Agent 新增 `AgentContext.apply_event()` / `from_events()` 事件重放能力，新增 `CrashRecovery` 服务与 `test_crash_recovery.py` 测试
- Agent `MCPClientManager.tools` 现在返回 `list[BaseAgentTool]`，完成工具层 public API 与 LangChain 的解耦
- Agent `supervisor.py` / `registry/registry.py` public API 已迁移到 `BaseAgentTool`，内部通过适配器继续使用 LangGraph 编排
- Agent `agent/prompts.py` 的 `build_prompt()` 改为返回纯字符串模板，去除 `ChatPromptTemplate` 依赖
- 基于 pnpm workspace 的 monorepo 项目结构
- Docker Compose 全栈部署（4 服务 + PostgreSQL）
- `mise run validate` 全量验证管道
- 集成 shadcn-vue 组件库：CLI 生成 Button、Input、Textarea、Card、Sheet、Progress、Badge、Dialog、AlertDialog、Sonner、Tooltip、Switch、RadioGroup、Checkbox、Skeleton、Separator、ScrollArea 等组件
- 使用 vue-sonner 替代自定义 Toast 方案（`useToast.ts` + `ToastContainer.vue`）
- 新增 `cn()` 工具函数（`clsx` + `tailwind-merge`）
- 清理旧的 `src/styles/variables.css`
- 新增 AI 聊天组件库：MessageScroller、Message、Bubble、Attachment、Marker 五个组件族
- 新增 MessageScroller 滚动控制器：锚定/自动跟随/预加载保持/消息级跳转/可见性追踪
- 新增 `scroll-fade` 与 `shimmer` CSS utility
- ChatView 集成 MessageScroller 替换旧虚拟滚动：SSE 开始即创建真实 assistant 消息，流式内容直接更新消息 content
- MessageItem 渲染层替换为 Message + Bubble 组件族，用户消息 `align=end`，助手消息 `align=start`
- 移除 `@tanstack/vue-virtual` 依赖及 sentinel-based 自动滚动实现
- 打开聊天时默认滚动到 `last-anchor`，用户消息自动设为滚动锚点
- 支持 CommonMark + GFM（表格、删除线、任务列表、自动链接、嵌套列表、引用块）
- 支持 `<think>` reasoning 折叠块与行内 citation `[n]`
- Chat 附件持久化前端链路：`AttachmentService` 批量上传、前端白名单/大小校验、自动发送、历史消息从后端加载、附件删除
- `AttachmentFile` 类型扩展 `fileId`，消息发送时附带 `attachments: fileId[]`
- `ChatView` 挂载时从后端 `GET /api/v1/sessions/{sessionId}/messages` 加载历史消息并回填本地状态
- 新增 `FileUpload.vue` 通用附件选择/拖拽组件
- Mock E2E 覆盖附件选择→批量上传→文本+附件合并发送→刷新仍可见的完整流程
- 详见各包源码和 `docs/` 目录

### Fixed

- 修复 Runtime Windows 本地构建与测试兼容性：隔离 Unix socket/symlink 代码，并统一 Windows canonical path 的 workspace 相对路径处理
- 将 CP JSON Schema 校验迁移到 `json-schema-validator 3.0.7` 的 `SchemaRegistry`/`Schema`/`Error` API
- 修复 `packages/agent/src/xihe_agent/main.py` 两处静默异常捕获，改为 `logger.warning(..., exc_info=True)`，确保异常可观测
- 修复 `mise run test:e2e` 中全部 mock/real 用例失败：移除 `networkidle` 等待策略、补齐 `setupMockAuth` 认证 mock、更新 settings 路由选择器、替换 PDF 性能测试 fixture、重新生成截图基线
- 登录页未认证时 `App.vue` 不再请求配置接口，避免 401 触发循环刷新页面
- `request` 在 401 时若已在 `/login` 或 `/register` 页面则不再重复跳转，消除认证相关路由死循环
- 代码块在 Shiki 异步高亮未完成或失败时正确回退显示原始代码，不再出现空代码块
- 模型选择器始终显示当前生效模型（会话选择 → `user-preference.defaultModel` / `llm-provider.defaultProvider` → 内置兜底），与 SSE 请求发送的 `model` 字段保持一致
- SSE 连接未建立时发送消息不再永久卡在 "Thinking..." 状态，而是提示错误并恢复可发送状态
- Config settings panels now show all fields even when database is empty (schema-driven rendering)
- 流式回复时代码块高亮与数学公式不再闪烁
- SSE 流式传输显示（`done` 事件丢失时 30s 超时自动降级）
- 修复聊天消息气泡垂直/水平间距过宽的问题：减少外圈 `px/py`、`gap`，气泡内边距收紧，时间戳/操作栏改为绝对定位避免占用行高
- 修复 `useToast` 允许相同错误消息无限堆叠的问题，新增去重与最大数量上限
- 修复 SSE 连接重试期间反复弹出 `Failed to fetch` 提示：运输层重试错误不再直接触发用户 Toast，仅当连接最终失败或发送消息失败时提示一次

### Changed

- 更新四模块稳定依赖与锁文件：UI、Agent、Control Plane、Runtime 均按两天冷却期刷新；TypeScript 7 因当前 vue-tsc API 链路不兼容暂保留 TypeScript 6
- Agent LiteLLM 更新至 `1.98.0`，MiMo provider 兼容性验证使用原生 `xiaomi_mimo` 路由
- 输入区域改为圆角卡片容器，textarea 使用 CSS `field-sizing: content` 自适应高度，焦点环在容器上
- `InputToolbar.vue` 改为声明式 action map（`leftActions`/`rightActions`），模型选择器、附件、语音、发送按钮统一映射
- 模型选择器整体改用 reka-ui `Combobox` + `Collapsible`，值使用 `provider/model` 复合格式，支持键盘导航、搜索过滤、分组折叠、收藏置顶
- 模型列表项展示 feature tags（vision/reasoning/tool-use）与 context window
- 统一消息气泡间距，用户/助手保留水平偏移；时间戳与操作栏默认隐藏，hover/focus 时显示
- 消息列表使用 `IntersectionObserver` 底部哨兵实现自动滚动，支持用户暂停滚动与恢复
- 流式生成时发送按钮切换为停止按钮，支持中断当前生成
- SSE 传输引入 `ChatTransport` 服务层，使用 `@microsoft/fetch-event-source` 替代原生 `EventSource`
- SSE 认证统一使用 `Authorization` header，不再通过 URL query param 传递 token
- 流式消息状态使用 `shallowRef` + `triggerRef` 优化高频 token 更新性能
- 空聊天状态添加欢迎消息和建议提示卡片
- 代码块在流式时使用 `highlight.js` 同步高亮，完成后切换为 `Shiki` 异步高亮

### Removed

- 删除旧的 `Popover.vue`，模型选择器 Popover 功能由 reka-ui Combobox 替代
