# Changelog

## [Unreleased]

### Added

- 初始版本：四模块 Hub-Module 架构（ui + control-plane + agent + runtime）
- 基于 pnpm workspace 的 monorepo 项目结构
- Docker Compose 全栈部署（4 服务 + PostgreSQL）
- `mise run validate` 全量验证管道
- 聊天消息 Markdown 渲染全面转向解析/渲染分离架构（`marked` lexer + 递归 Vue token 组件）
- 支持 CommonMark + GFM（表格、删除线、任务列表、自动链接、嵌套列表、引用块）
- 支持 `<think>` reasoning 折叠块与行内 citation `[n]`
- 详见各包源码和 `docs/` 目录

### Fixed

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
