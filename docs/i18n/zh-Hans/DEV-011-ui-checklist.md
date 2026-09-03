---
title: DEV-011 - UI 视觉检查清单
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 11
created: 2026-05-31
updated: 2026-09-03
status: active
---

# UI 视觉检查清单

> 涉及 UI 变更的 PR 必须逐项核对本清单。发现的问题均来自实际 E2E 截图审查。

## 1. 页面渲染

- [ ] 页面无空白/白屏（Vue inline template 不渲染 → 必须用 SFC）
- [ ] 标题、副标题文字正确显示
- [ ] 表单字段标签与输入框对齐
- [ ] 按钮文字/图标完整可读

## 2. 图标渲染

- [ ] 新增图标优先使用 `@lucide/vue` 组件；`i-lucide-*` CSS 类仅允许存量静态场景，动态组件（按扩展名/状态切换图标，如 FileTreeNode/ModelPopover）须用组件（历史 Tailwind v4 动态渲染不可靠）
- [ ] 主题选择器（`ConfigSettings` 内 light/dark/system 下拉）正常显示与切换
- [ ] 发送按钮纸飞机图标正常显示
- [ ] 消息气泡 bot/user 头像图标正常显示

> **根因**：`i-lucide-*` CSS 类在 Tailwind v4 动态渲染场景下不可靠。存量代码仍有 20+ 处 `i-lucide-*`（含动态场景），新代码遵守本条，存量逐步迁移。

## 3. 主题切换

- [ ] light 模式：背景白色，文字深色，按钮可见
- [ ] dark 模式：sidebar 与 chat 区域有可辨识的色差（`--sidebar-background` 与 `--background` 差值 ≥ 4%）
- [ ] dark 模式下表单输入框边框可见
- [ ] 主题切换后页面无闪烁/残影
- [ ] 主题切换后设置页下拉值与实际主题一致

## 4. 登录/注册页

- [ ] 登录页：标题"登录"、用户名/密码字段、登录按钮、"没有账号？注册"链接
- [ ] 注册页：标题"注册"、用户名/密码/确认密码字段、注册按钮、"已有账号？登录"链接
- [ ] 底部链接文字不冗余（不应出现"登录 登录"）
- [ ] 表单字段有正确的 `name` 属性（E2E 选择器依赖）

## 5. 聊天界面

- [ ] 空状态：chat 显示欢迎语 + 建议问题；会话列表为空时 Sidebar 显示"暂无对话"
- [ ] 消息气泡：用户消息右对齐（`bubbleVariant=default`），助手消息左对齐（`muted`），系统消息 `outline`
- [ ] 助手消息头像有 bot 图标，用户消息头像有人物图标
- [ ] 时间戳在 hover 工具栏中可见
- [ ] 输入框 placeholder 文字正确
- [ ] 发送按钮在输入为空时禁用（半透明）

## 6. Sidebar

- [ ] 会话列表按时间分组（今天/昨天/更早）
- [ ] 搜索框输入后过滤会话列表
- [ ] 搜索无匹配时显示"暂无对话"
- [ ] 点击会话项高亮当前选中状态
- [ ] Sidebar 折叠/展开动画流畅

## 7. 暗色模式对比度

| 元素 | 期望 |
|------|------|
| sidebar 背景 | 比 chat 区域亮 2-4%（便于区分层级） |
| chat 区域背景 | 不低于 6% 亮度（避免纯黑） |
| 卡片/气泡背景 | 比 chat 区域亮 2%（突出内容） |
| 边框 | 在 dark 模式下仍可见 |

## 8. i18n

- [ ] 所有用户可见文案使用 `t()` 国际化函数
- [ ] `zh-CN` 和 `en-US` 两个 locale 均有对应 key
- [ ] 链接文字不出现原始 key（如 `login.login`）
- [ ] 表单验证错误信息有对应翻译

## 9. E2E 截图基准

- [ ] `login-page` — 登录页完整渲染
- [ ] `register-page` — 注册页完整渲染
- [ ] `chat-empty` — 空聊天页 + sidebar
- [ ] `chat-with-messages` — 有消息的聊天页
- [ ] `theme-default-light` — 浅色主题页
- [ ] `theme-dark-persisted-chat` — 深色模式聊天页
