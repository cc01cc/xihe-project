---
title: DEV-011 - UI 视觉检查清单
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 11
created: 2026-05-31
updated: 2026-10-31
status: active
---

# UI 视觉检查清单

> 面向 UI 开发者与审查者：按 §1-8 逐项核对 + §9 截图基线。
>
> 全局交互、状态、焦点、键盘和 reduced-motion 目标态见 [`spec/ui/`](../../../spec/ui/)，本文保留可执行的视觉检查项。
>
> 涉及 UI 变更的 PR 必须逐项核对本清单。发现的问题均来自实际 E2E 截图审查。

## 1. 页面渲染

- [ ] 页面无空白/白屏（Vue inline template 不渲染 → 必须用 SFC）
- [ ] 标题、副标题文字正确显示
- [ ] 表单字段标签与输入框对齐
- [ ] 按钮文字/图标完整可读
- [ ] **两层表面实测（亮色）**：rail / 导航面板 / 文件树 / dock = canvas `#f7f7f8`，主内容与卡片 = content `#ffffff`；平均通道差 **3.01%**（算法见 §7.1），落在本节要求的 2–4%
- [ ] **两层表面实测（暗色）**：canvas `oklch(0.185 0 0)`（≈ `rgb(19,19,19)`）vs content `oklch(0.145 0 0)`（≈ `rgb(10,10,10)`）；平均通道差 **3.53%**，同样落在 2–4%
- [ ] **四断点无横向溢出**：1800 / 1440 / 1280 / 1024 各测一次（含 dock 打开态与文件树展开态），`document.documentElement.scrollWidth <= clientWidth`
- [ ] **dock 模式按断点派生**：视口 ≥1800 默认 `pinned`、<1800 默认 `floating`；用户手动切换后刷新仍保持（`dockModeManual`），且 UI 上有「手动」标记

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
- [ ] 导航面板折叠/展开动画流畅；收起后 rail 上有明确的展开入口（不靠快捷键）

### 6.1 rail（`NavRail`，恒 56px）

- [ ] 恒 **56px**、纯图标无文字标签；每个图标有 `aria-label` 且 hover 有 tooltip
- [ ] rail **不含**收起控件（收起控件在导航面板头）；`<1024` 时整列隐藏

### 6.2 三处栏宽与夹取（PLAN-0582）

- [ ] 导航面板 **220–360**（默认 280）、文件树 **200–320**（默认 240、收起 40）、dock **320–480**（默认 360）
- [ ] 分隔条语义齐：`role="separator"` + `aria-valuenow/min/max`；方向键 ±16、`Home`/`End` 到边界；**双击恢复默认宽**；拖拽时显示实时宽度浮标
- [ ] **窄屏夹取不回写**：1280–1439 面板显示 260、1024–1279 显示 240；回到宽屏恢复用户原值 —— 用 `localStorage` 的 `xihe-layout-global.navWidth` 前后对照证明原值未被覆盖
- [ ] **防挤压**（spec §1.5-C，主列是被保护量；已随 S3b + S5-W2 实现）：① 主列硬底线 **640**（`MAIN_MIN_WIDTH`）压倒一切，**包括用户手动展开偏好**；② **720 舒适线**（仅 pinned dock 挤压时触发）：先让**文件树**让位 → 仍 <720 再让**导航面板**让位，顺序固定 `文件树 → 导航面板`（`navYielded` 把面板收成 rail）；③ 仍 <**640** → dock **渲染**转 `floating`（**不关 dock**，用户 pinned 选择保留）并给一次性提示（`workspace.squeezeFloatingNotice`），**不静默**；④ floating 后仍 <640 → 文件树、再导航面板依次让位（导航面板是最后杠杆，即使被手动重开也让位）——底线不可破

## 7. 暗色模式对比度

| 元素 | 期望 |
|------|------|
| sidebar 背景 | 比 chat 区域亮 2-4%（便于区分层级） |
| chat 区域背景 | 不低于 6% 亮度（避免纯黑） |
| 卡片/气泡背景 | 比 chat 区域亮 2%（突出内容） |
| 边框 | 在 dark 模式下仍可见 |

### 7.1 亮色模式层级（PLAN-0582 新增判据）

| 元素 | 期望 |
|------|------|
| canvas（rail / 导航面板 / 文件树 / dock） | `--surface-canvas` = `#f7f7f8` |
| content（主内容 / 卡片 / 输入框） | `--surface-content` = `#ffffff` |
| 两层平均通道差 | **3.01%**（落在 2–4% 目标内） |
| 边界 | `--border-subtle` = `#e5e7eb`，1px 单线，两表面之间不得出现双线 |
| 暗色对应 | canvas `oklch(0.185 0 0)`（≈ `rgb(19,19,19)`）vs content `oklch(0.145 0 0)`（≈ `rgb(10,10,10)`），平均通道差 **3.53%** |

**算法（可复算，不接受「看着差不多」）**：平均通道差 = Σ|通道差| ÷ 3 ÷ 255 × 100。亮色 = (8+8+7)/3/255 = **3.0065% → 3.01%**；暗色按无彩度 oklch 换算（Oklab 无彩度时 `Y = L³`，再 sRGB 编码）得 `rgb(19,19,19)` vs `rgb(10,10,10)`，= 9/255 = **3.53%**。另附 WCAG 对比度：亮色 **1.07:1**、暗色 **1.06:1** —— 这是**层差指标**，不是可读性判据（正文对比度仍按上表判）。

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
- [ ] `workspace-3col-1920` — 工作台三栏（rail + 面板 + 树/主/dock）@1920
- [ ] `workspace-dock-overlay-1440` — dock 浮层态 @1440（含阴影，主列不参与 flex）
- [ ] `workspace-rail-collapsed` — 导航面板收起后的 rail 态
- [ ] `workspace-tree-empty` — 文件树空态（新建文件主按钮 + 上传次按钮 + 拖拽提示）

> **平台限制（勿误读为回归）**：基线比对**只在 Linux 生效**（`packages/ui/e2e/helpers/visual.ts:16-26`：非 Linux 直接打 `visual-baseline-platform` annotation 并 return）。Windows 上跑出的「通过」= 未比对，只能**人工复核 actual/diff**；记录时必须写「Linux lane 未跑」。
