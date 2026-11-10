---
title: DEV-011 - UI 视觉检查清单
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 11
created: 2026-05-31
updated: 2026-11-10
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
- [ ] 中英两侧键集合差集 = 0（2026-11-10 实测：`packages/ui/src/i18n/index.ts` zh 2307 / en 2307）—— 机器判据：`mise run lint:i18n`（task-96 起为常驻门禁，只读、通过时零输出）
- [ ] 同一键在两侧的 `{placeholder}` 集合一致（漂移会让运行时渲染出 undefined）
- **已知陷阱（2026-11-10 实测）**：同名族前缀写错只有运行时才暴露 —— `ApprovalModal.vue` 的「另一窗口已处理」第二条提示曾写作 `chat.approvalResolvedElsewhereDraftKept`，而键实际在 `workspace.*`，用户看到的是**裸 key**（已修 `efa527a0`）。扫描口径：键差集 + 占位漂移 + 源码 `t("…")` 静态引用三查，脚本已转正为仓库门禁 `mise run lint:i18n`（`A03-xihe/scripts/i18n-scan.mjs`，task-96）。
- **已知陷阱（2026-11-10 实测）｜省略号字形**：手写的 `加载中...`（三个半角句点）与实际 i18n 值 `common.loading` = `加载中…`（**U+2026 单字符省略号**）不是同一个字符串 ⇒ `text=加载中...` / `textContent` 断言会「页面明明显示了却匹配不到」（task-112 实测：产品已修好，用例仍红，两条现象同时存在）。**判据**：① 断言优先用 `data-testid` / role / `aria-*` 等结构锚点；② 必须断言文案时取 i18n 同源常量，不手写字面量；③ 确需手写时只匹配不含标点的稳定前缀（如 `加载中`）。同族字符差异：全角/半角括号、`：`vs`:`、`·`vs`-`、不间断空格（U+00A0）。
- **新门禁首日误报审计（2026-11-10 实测，task-96 / task-148）**：`mise run lint:i18n` 上线首日在 `literal-brace` 规则上**误报 3 处** —— `chat.delivery.mentioned` 的 vue-i18n 字面量插值 `{'@'}`、`settings.jsonPlaceholder` 的 mcpServers JSON 样板（中英各一）；规则改成「花括号内是标识符 / 是 `'…'` 字面量 / 含引号 ⇒ 放行」之后才可用。三条要求：① **新门禁上线第一天必须做误报审计** —— 拿真仓跑一遍，把每条命中判成「真缺陷」或「规则误报」，**误报不清零就上线 = 以后没人看**（没人看的门禁等于没有门禁）；② **误报判定口径** —— 真·漏替换是非标识符花括号（`{...}`、`{ … }`、`${x}`）；合法花括号是已声明的插值参数 `{name}`、vue-i18n 字面量 `{'@'}`、JSON 样板（花括号内含引号）；③ **每条放行规则都要有正例单测** —— 本次 `legitimate braces (vue-i18n literals, JSON samples) are not false positives` 与「`{...}` 仍会红」的负例成对存在，**改规则必须同时改这两条**。

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

> **断言陷阱（2026-11-10 实测）｜redirect 丢 query**：`/settings/config` 自 `6002ea60`（PLAN-0752 M1）起是 `redirect: () => defaultLayerPath("instance")`，**不携带 query** ⇒ `goto("/settings/config?tab=tool-faces")` 的参数静默失效，用例会「**落到了正确页面，但断言的是另一个状态**」（旧页某只读态 vs 域页默认页签）。**判据**：① 断言前先核该路径在 `router/index.ts` 里是组件路由还是 redirect，redirect 是否透传 `query`/`params`；② 指向旧入口的用例同时断言落地 URL（`page.url()`）或目标页 testid，不要只断言内容；③ 迁移期把用例直接指向最终地址（新代码同理：导航不要 push 旧入口字面量，复用 `lib/settingsIa` 的 SSOT 函数）。

> **断言陷阱（2026-11-10 实测）｜Vue 布尔属性写成 `:attr="cond"`**：Vue 给元素设属性走两条路——属性名是 DOM 属性（`key in el`）走 `patchDOMProp`，布尔值被正确强制；否则走 `patchAttr`，而 `patchAttr` 的布尔判定用的是**七项小名单** `isSpecialBooleanAttr`（`itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly`，`@vue/shared` 3.5.44），**不是** `isBooleanAttr`。不在名单里的布尔属性拿到 `false` 会被渲染成 `attr="false"`，而 HTML 对布尔属性**只看存在性** ⇒ 控件被永久禁用，且看起来「已经设成 false 了」。**本仓库 jsdom 实测**：`inert: false` ⇒ `inert="false"`（属性仍在，task-122 就红在 `expected 'false' to be undefined`）；`disabled` / `hidden` / `readonly` / `required` / `multiple: false` ⇒ 属性被正确移除（它们是 DOM 属性，走另一条路）。**判据（可执行）**：① 一律写 `:attr="cond || undefined"`（或 `cond ? '' : undefined`），不要赌某个属性在当前环境有没有 DOM 实现；② 单测必须断言**假态下属性不存在**——`expect(el.hasAttribute("inert")).toBe(false)`；只写 `toHaveAttribute` 抓不到 `attr="false"`（属性确实在，断言会过）；③ 遇到新 HTML 属性（`inert` / `popover` / `commandfor` / `anchor` 这类）先按①写，别照抄浏览器当前行为——「有没有 DOM 属性」随浏览器与 jsdom 版本变化。

---

## 10. 注意力预算（2026-11-03 用户裁定，配色判定标准）

**原则**：视觉权重（颜色/对比/填充）按**注意力的用途**分配，不按"元素身份"分配。判断一个新元素该不该上彩色，先问三题：多常用？多不可逆？多难发现？——**会误操作才值得上色，低频且易发现的操作一律中性**（例：「新建对话」低频、可逆、位置固定 ⇒ 中性，不用品牌色）。

### 层级阶梯（L0–L4，判定表）

| 层级 | 用途 | 允许的表现 | 每屏额度 |
|---|---|---|---|
| L0 表面 | 页面/卡片底 | 白 / 近白 / 浅灰 | 不限 |
| L1 内容 | 正文、标题 | 深灰字，靠字重字号拉层级 | 不限 |
| L2 可操作 | 按钮、边框、图标、hover | 中灰边框 + 文字；hover 只加浅灰底 | 不限 |
| L3 强调 | 主 CTA、选中指示、焦点环 | 可上色，但**只能 1–2 处** | 每屏 ≤ 2 |
| L4 危险 | 删除、覆盖、不可恢复 | 红，只在确认时出现 | 每屏 ≤ 1 |

判定问题：**这个元素如果消失，用户会误操作吗？** 会 → L3/L4；不会 → L2，不许上色。

### 状态矩阵（每种状态只许用对应通道，不许靠变色表达）

| 状态 | 正确做法 | 禁止 |
|---|---|---|
| hover | 只加极浅底（surface 深一档），文字/边框不动 | hover 变品牌色/变蓝 |
| **focus（键盘）** | 环形轮廓（2px ring + offset），**必须与 hover 视觉上可区分** | 与 hover 同一个底变色（键盘用户不知道自己焦点在哪） |
| active/pressed | 轻微下沉或底色再深一档 | 用品牌色填充 |
| selected | **左侧 2px 指示条 + 浅底**，文字加粗一档 | 整行品牌色填充 |
| disabled | 降对比但保持 ≥3:1 可读 + `cursor: not-allowed` | 降到几乎看不见（像渲染 bug） |
| danger | 红**只在实际危险元素上**，不染整块背景 | 整行红底 |

### 可发现性例外
全灰 ≠ 什么都找不到。低频操作的可发现性靠**位置固定 + 文字标签 + 空态引导**，不靠颜色；颜色退出后，这些通道必须还在。