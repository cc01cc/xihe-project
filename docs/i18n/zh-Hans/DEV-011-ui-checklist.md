---
title: DEV-011 - UI 视觉检查清单
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 11
created: 2026-05-31
updated: 2026-11-18
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

### 6.1 rail（`GlobalRail`，双态：折叠 56px 纯图标 ↔ 展开图标 + 文字）

- [ ] **双态**（`GlobalRail.vue:77`：`--sidebar-width-icon: 3.5rem` = 折叠 56px、`--sidebar-width: 12rem` = 展开，`collapsible="icon"`）：折叠态纯图标无文字标签、展开态图标 + 文字；每个图标有 `aria-label` 且 hover 有 tooltip
- [ ] 收起/展开入口**不只在导航面板头、也不只靠快捷键**：全局条自带 `SidebarRail` hover 切换（`GlobalRail.vue:190`）+ `⌘/Ctrl+B`（`SidebarProvider`）；导航面板折叠态另渲染一条 56px 折叠条（`Sidebar.vue:154-157`，`sidebar-collapsed-strip`，只含展开控件）；`<1024` 时全局条整条隐藏（`App.vue:29-36`）

### 6.2 三处栏宽与夹取（PLAN-0582）

- [ ] 导航面板 **220–360**（默认 280）、文件树 **200–320**（默认 240、收起 40）、dock **320–480**（默认 360）
- [ ] **栏宽只许比 rail-vs-rail，或按容差断言**：`store px → 渲染 px 的误差 ≤1%+1px；折叠档 ≤2.5%；禁止对渲染宽断言整数。` 原因：reka 侧 layout 是百分比（内联 `flex: <p> 1 0px`）、px→% 必然量化，且 resize handle 的 `-ml-1` 参与 grow 分配；**折叠档与展开档不同源**（`data-state=collapsed` 时 layout 只有 4.44%，同一绝对误差在 40px 上放大到 ~2.4%），别把两个口径合成一个数。五档读数与被证伪的三条假设见 task-28
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

> **交互陷阱（2026-11-12 实测）｜`AlertDialogAction` 自动关闭先清空"待确认"状态**：`AlertDialogAction` 是 reka-ui `DialogClose` 的包装，点下即**无条件关闭**；关闭会**同步先触发 `@update:open`**，如果"确认后要提交的 payload"存在 ref 里，它会被这个 `@update:open` 处理器清空 ⇒ **我们自己的 click handler 跑的时候读到 `null`，于是点了确认、一个请求都没发**（`task-312` 实测）。**怎么认出它**：确认框的**文案断言全过**（框确实开了、字也对），唯独请求计数是 **0** —— 红字是 `expected "vi.fn()" to be called 1 times, but got 0 times`。**这类红最容易被误判成"mock 没接上"**：屏幕上一点异常都看不出来，于是有人去改 mock，mock 越改越像真的、问题却还在。**排查方向**：先在 click handler 里打印它收到的 payload —— 是 `null` 就是本陷阱。**改法**：不要让 `AlertDialogAction` 承担"确认后必须执行副作用"的动作，改用普通 `Button` 并显式控制关闭顺序（先取 payload → 再关 → 再提交），实测处 `components/settings/PersonalSkillCreateDialog.vue`。

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

### 焦点态取证纪律（2026-11-15，`D-1435`；`task-40` 实测）

拍「焦点环」这类验收图时，**只能用键盘路径（Tab / `tab=<n>`），不得用脚本 `focus()`，更不得在同一个镜头里先做点击/展开/悬停**。理由不是偏好，是实测：

| 前置操作 | 路径 | `:focus` | `:focus-visible` | 图里有环 |
|---|---|---|---|---|
| 无 | 脚本 `focus()` | true | **true** | 有 |
| **先点击某按钮** | 脚本 `focus()` | true | **false** | **没有** |
| 先点击 | Tab 到目标 | true | true | 有 |

⇒ 决定 `:focus-visible` 的是**此前有没有指针交互**，不是「脚本 vs 键盘」。而截图脚本的 `expand`/`hover` 步骤本身就是指针操作，所以「先展开再拍焦点」会**稳定拍出无环图**。

**两条硬约束**：① 焦点图必须走 `tab`；② `focus=` 只在目标位于数十个 tab stop 之后（实测某页需 53 次 Tab）时使用，且**禁止与 `expand`/`hover` 同镜头**（脚本已硬拦）。**假焦点图是最坏的一类证据：`:focus=true`、有 activeElement、PNG 也生成了，看起来完全正常。**

### 危险红「入口 / 确认」两档判据（2026-11-17，`task-109` 判定 + `check-danger-entry.mjs`）

`:153` 的「红，只在**确认时**出现」与 `:155` 的「会误操作才上色」是**两条正交的轴**。混成一句判就会出现本卡开头那种错：
把「本该有确认」当场「不该红」。所以先分轴、再给机器判据。

| 轴 | 问什么 | 答「是」的动作 | 归谁判 |
| --- | --- | --- | --- |
| **A 该不该红**（`:155`） | 这个元素如果消失，用户会误操作吗？ | 会 ⇒ L3/L4；不会 ⇒ L2，不许上色 | **人判**（要读业务语义：可逆性、未提交状态、是否有回滚面） |
| **B 红在哪一档**（`:153`） | 红是否只在**确认时**才出现？ | 否 ⇒ 违规 | **机判**（静态扫描，见下） |

**顺序不可反**：先定 A，再定 B。若 A 判「会误操作」而确认面**尚不存在**，那不是「不该红」，是**缺确认** ——
此时改颜色等于把危险动作**藏起来**（中性色 + 一步不可恢复），比现状更坏。正确顺序 = **先补确认面，红才落到确认键上**。

#### B 轴的四态（机器可判，判定对象是**元素 × 所处阶段**）

判据对象不是组件、不是动作，是**元素在哪个阶段可见**。同一动作的入口与确认键是两个判定对象，结论不同。

| 态 | 含义 | 判定 | 典型写法 |
| --- | --- | --- | --- |
| `ENTRY_STATIC` | 静态面就红，且不在确认面 | **违规** | `class="text-destructive"` |
| `CONFIRM_SURFACE` | 在确认面容器内 | 合规 | `BaseModal` / `ConfirmModal` / `AlertDialogContent` 内的 `bg-destructive` |
| `HOVER_ONLY` | 唯一红 token 在交互段（`hover:` / `focus:` / `active:` / `peer-*:` …） | 合规 | `text-muted-foreground hover:text-destructive` |
| `STATE_GATED` | 红只在动态条件分支出现 | 合规 | `:class="pending ? 'text-destructive' : 'text-muted-foreground'"` |

#### 三条易判错的边界（每条都有反向夹具钉住）

1. **可见性门控 ≠ 颜色门控。** `opacity-0 group-hover:opacity-100` 只让按钮 hover 时才**看得见**，
   颜色本身仍是静态红 ⇒ 判 `ENTRY_STATIC`（违规）。判据是**颜色 token 出现在哪个体**，不是它什么时候可见。
2. **确认面有红不能为入口红开脱。** 同一动作若入口红 + 确认面也红，入口那处仍违规。
3. **条件分支必须真能看见。** `:class` 对象写法里值为**字面 true** 的键（`{ 'text-destructive': true }`）不是分支，判 `ENTRY_STATIC`；
   只有**真/假两个分支都可达**的三元或变量键才算 `STATE_GATED`。

#### 可执行判据（`internal/A03-xihe/scripts/check-danger-entry.mjs`）

判据文本以脚本导出的 `CRITERION` 常量与本节同字为准（`D-1767`：有机器判据才配进文档）。
**逐字原文（勿改写标点/箭头，机器判据就是这几行）**：

```js
CRITERION = {
    id: "DEV-011:155",
    question: "这个元素如果消失，用户会误操作吗？",
    answerYes: "会 -> L3/L4；L4 危险红按 :153 只在确认时出现",
    answerNo: "不会 -> L2，不许上色",
    ladder: "DEV-011:153 L4 危险 = 红，只在【确认时】出现，每屏 <= 1",
}
```

```bash
node internal/A03-xihe/scripts/check-danger-entry.mjs --selftest   # 夹具 + 双向变异，exit 0 才算判据本身可信
node internal/A03-xihe/scripts/check-danger-entry.mjs              # 全仓扫描，与基线比新增；exit 1 = 有新增违规
node internal/A03-xihe/scripts/check-danger-entry.mjs --raw        # 全部读数的 state × rawState 全表（= --readings）
node internal/A03-xihe/scripts/check-danger-entry.mjs --json       # 基线文档 + raw 形态读数节（raw 不进基线文件）
node internal/A03-xihe/scripts/check-danger-entry.mjs --write-baseline    # 收账（幂等：同一棵树两次写盘 sha 相同）
node internal/A03-xihe/scripts/check-danger-entry.mjs --migrate-baseline  # 换键迁移（边界校验，见下）
```

**判据必须能红**：`--selftest` 含**双向变异** —— 把确认面红搬到入口 ⇒ 必须变 `RED`；把入口红搬回确认面 ⇒ 必须变 `GREEN`。
只朝一个方向验的判据会把仪器调成偏心版，下一个缺陷照样过。

#### 两套读数：公开分档 vs 形态读数（`task-142`，2026-11-17）

每个读数带两个数，**分工不同、不合并成一个数**：

| 读数 | 是什么 | 参与判定 |
| --- | --- | --- |
| `state` | **合规定性**。容器识别会覆盖它：元素在确认面内一律记 `CONFIRM_SURFACE`，与它自身是静态红还是分支红无关 | **是**，唯一决定 exit code |
| `rawState` | **形态读数**。分类器对「元素自身的红以什么形态出现」的原始读数（静态 / 交互门控 / 动态分支 / disabled 段） | 否，不进公开分档 |

两者不一致是**预期**（`CONFIRM_SURFACE` 的 `rawState` 绝大多数是 `ENTRY_STATIC`：确认面里的静态红本就合法）。
要盯的是形态读数的**变化**：① `rawState` 掉档；② 有危险红的条数下降而分档没涨 —— 元素被判 `NONE`（= 从读数表里消失）。
报告默认印「形态读数」节，`--raw` 给全表，`--json` 带 `raw` 节。

**为什么必须打印**（`task-137` 实证）：修 `ConfirmModal` 的捆绑前景字面量后，`rawState=STATE_GATED` 涨了 1（5→6），
而公开分档只把 `CONFIRM_SURFACE` 17→18 记了一笔 —— 读者看得见后者，前者当时在**任何** CLI 输出里都印不出来。

#### 基线与键（`task-143`）

基线键 = `file:(id||tag)`；`id` 取 `data-testid` **原文**（模板字面量保留插值表达式，如
`provider-connection-delete-${defaultConnection.id}`），同一基座撞车时按行序加 `#1/#2`，且撞车会印出来（不静默）。

- **不用行号做键**：本基线 8 条里有 3 条行号在半天内就漂了（1340→1347 / 1921→1928 / 2256→2335+）—— 插一行 import 就能造出「消失 + 新增」成对假红。
- **收账与迁移分开**：`--write-baseline` 是收账（不问边界）；`--migrate-baseline` 是迁移（内容多重集 `file+tokens+conditional` 必须与旧基线**逐条相等**，否则 **exit 3 拒写**）—— 换键可以，顺手收新东西不行。

#### 确认面的三种识别（`task-149`，2026-11-17）

| 来源 | 规则 | 为什么需要 |
| --- | --- | --- |
| 名字白名单 | `BaseModal` / `ConfirmModal` / `AlertDialogContent` / `DialogContent` / `RevertPreviewDialog` | vendor 与项目内既有确认壳 |
| 手写语义 | `role="alertdialog"` **且** `aria-modal="true"` | 手写确认框没有组件名（实例 `ProviderHub:1934`）。**要求 `aria-modal`** 才认：只写 `role` 的常驻区块不少，一律白名单化会把真违规藏起来 |
| 源码推导（模态外壳） | 组件的**每一个** `<slot>` 渲染位置都在模态原语（`DialogContent`/`SheetContent`/`AlertDialogContent`/`BaseModal`/`ConfirmModal`）内 | 白名单是手维护的，缺口以假阳性形式出现（`CheckpointDialogShell` 实例 ⇒ `RevertPreviewDialog:427`） |

**不收 `role="dialog"`**：generic dialog ≠ 确认阶段（导航 sheet / 导入表单都是 dialog），现有 4 处手写 `role="dialog"` 里也没有动作元素红（2026-11-17 实测）。
**推导判据是「每个 slot 出口都在模态内」，不是「模板里有模态原语」**：后者会把 `Sidebar.vue`（桌面支 slot 在普通 div、只有移动支进 `SheetContent`）与 `FileNodeMenu.vue`（slot 在普通元素、几个 `BaseModal` 是并列兄弟）推导进来。
夹具实测（`fixture-m-not-shell` + `fixture-n-not-shell-user`）：宽松判据下宿主的**入口红被读成 `CONFIRM_SURFACE`**，`--selftest` 两条 FAIL、exit 1 —— **假合规比假阳性更坏，而且它是静默的**（报告上只表现为「违规少了」）。推导名单会打进报告（`推导出的模态外壳：…`），避免它变成第二份看不见的白名单。

#### `cn('…')` 兜底必须逐 token 判门控（`task-149` ③）

`:class` 里既无对象、无三元、也不是数组时（vendor 常见 `cn('…默认类…', props.class)`），旧实现整条判「始终开着」，
于是字面量内部的**逐 token 门控全部失效**：`data-[variant=destructive]:text-destructive` 本表示「只在 destructive 变体下红」，
却被读成入口静态红（`DropdownMenuItem:27`，vendor 默认类 —— 改它等于改本来正确的代码）。
现行：逐 token 判门控（变体 / 交互段 / disabled）后取**最坏**的一个；只要有任何一个 token 是裸的，仍是 `ENTRY_STATIC`
（反例夹具 `fixture-j2-cn-bare` 钉住这点，防止被写成「一律 STATE_GATED」这种假修）。
变体门控的锚点同时放宽到 `(?:^|[\s:])`：`dark:data-[variant=destructive]:focus:bg-destructive/20` 这类「修饰符在前」的写法以前读成无门控；
**只放宽结构变体（`data-`/`aria-`/`has-`/`[&…]`），不放宽 `dark:`/`sm:` 本身** —— `dark:bg-destructive` 在暗色用户眼里就是入口静态红。

**已知局限**（照实写，否则下次被当缺陷）：
1. 行内两段式确认的**确认臂**（同一行 `v-if` 出来的第二个按钮）不在确认面容器内，扫描器读作 `ENTRY_STATIC`，
   靠输出的 `<v-if 条件>` 标注供人判读。**不把条件分支一律判合规** —— 那会让「入口红」整类失去咬合力。
2. 手写 `role="dialog"` 的确认框不在白名单（generic dialog ≠ 确认阶段）；这类框请改用 `role="alertdialog"` + `aria-modal`。
## 11. UI 审阅维度（截图审阅，2026-11-11 用户裁定 D-926 / D-927）

> 用户原话：UI 开发完成后先截图自审 ——「各个按钮的布局 以及是否有意义；字体，图标，整体交互以及静态元素」。
> 本节把这句话展开成**可判**的六维；判据只收「看一眼截图能下结论」的，不能判的留给 E2E/单测。

**前置三条**：钉在 commit 上拍（不拍脏树）· 固定视口（1600×1000 主用，另取 1920×1080 与 390×844 各一轮）· 用真实数据（mock 也要先跑通读写，别用占位符糊）。

| 维 | 看什么 | 业界依据 | 可判据 | 常见反例 |
| --- | --- | --- | --- | --- |
| **A 反馈与可用性** | 每个可点元素点下去有没有可观察结果；加载/禁用/错误态齐不齐 | Nielsen H1/H3/H9；WCAG 4.1.3 | 点击后 1 帧内有状态变化（spin/文案/跳转）；禁用项视觉可辨且真不可点；错误文案给「怎么办」 | 点了没反应；该禁用却能点；「出错了」当错误文案 |
| **B 一致性** | 同一语义的图标/控件/格式是否同源 | Nielsen H4；设计 token（Carbon/Material） | 同动作同图标同尺寸;间距/圆角/描边来自 token 非魔数；时间/数字/单位全站一个格式 | 同一功能两处不同图标；某页 8px 某页 10px 间距 |
| **C 层级与排版** | 字阶、行高、长值、CJK 混排 | Refactoring UI（层级=字号+字重+色彩）；8pt 网格 | 三级字阶肉眼可分（如 24/16/14）；正文行高≥1.5；数字/代码等宽；长值截断或换行不撑破 | 四级标题同样大小；长 id 撑破卡片；中英基线跳动 |
| **D 无障碍** | 对比度、焦点、键盘、触控目标、可访问名 | WCAG 2.2 AA：1.4.3(4.5:1) / 1.4.11(3:1) / 2.4.7 / 2.5.8(≥24×24) / 4.1.2 | Tab 顺序合理且焦点环可见；图标按钮有 aria-label；状态不能只靠颜色 | 灰色小字对比不足；图标按钮无标签；焦点看不到 |
| **E 内容与真实性** | 文案、计数、空态、i18n | Nielsen H2/H10 | 计数/徽标与可见数据一致；空态有出口；无硬编码中英文；示例值是真实形状 | 「本域 8 项配置」却 0 字段；空态只有一行字没按钮 |
| **F 布局与自适应** | 溢出、滚动、折叠态、断点 | Apple HIG（44pt）/ Material（48dp）触控；响应式 | **页面级**无横向溢出：1280/1600/1920 三档均 `documentElement.scrollWidth ≤ innerWidth`（口径与例外见本节末「F 维可判口径」）；滚动条不遮内容；面板折叠后仍有可读入口；移动端触控目标≥44px | 320px 溢出；折叠后无法恢复；移动端按钮叠在一起；**把 `PRE.shiki` 内层长行判成「溢出」** |

### F 维「无横向溢出」的可判口径（2026-11-17，`task-90` 实测 + `task-100` 探针）

**判据只认页面级，不认「任何元素都不得超出视口」。** 原文「无横向溢出」没写是哪种口径 —— 这一句就是补那个缺口。

```js
// 唯一判据 ①：页面级横向滚动条是否出现
document.documentElement.scrollWidth <= window.innerWidth
// 且 scrollWidth <= document.documentElement.clientWidth
// （classic 纵向滚动条会吃掉 clientWidth；只判 innerWidth 在「内容 1275 < winW 1280、可用宽 1270」这一档会假绿）
```

**判据 ②（与 ① 并列，缺一即红）：无裁剪祖先的出视口元素数 = 0。**
只判 ① 会漏掉 `position: fixed` 一类：它不撑 `documentElement.scrollWidth`，但照样被视口切掉。

**两条轴不是一回事**（`task-90` 1280×800 mock 会话页实测）：

| 轴 | 读数 | 结论 |
| --- | --- | --- |
| 页面级 `documentElement.scrollWidth` | 1270 ≤ `innerWidth` 1280 | **无横向溢出，满足判据** |
| 单个元素 `getBoundingClientRect().right` | 最大 3059（`PRE.shiki` 内层 `code`/`span.line`） | 元素出视口，但**被裁剪祖先吸收**，不升级为页面溢出 |

三档实测全是这个形状：页面级溢出 **全 false**，而「出视口元素」有 53–77 个。**同一个读数既能读成「无缺陷」也能读成「77 处溢出」，差别全在口径。**

**例外通道（不判溢出，登记为「已裁剪」）**：

| 通道 | 判据 | 说明 |
| --- | --- | --- |
| `PRE.shiki` 内层（`code` / `span.line`） | 存在 `overflow-x: auto` 祖先且该祖先 `scrollWidth > clientWidth` | 代码块横向滚动 = 标准交互（GitHub / IDE 同形）；`white-space: pre` 是代码语义要求，**不得**为消「溢出」改成 `pre-wrap`（行号与折行会错位 = 破坏语义） |
| 任意 `overflow-x: auto / hidden / scroll` 容器的子元素 | 同上 | 表格、长路径、时间线等宽内容一律同形 |

**探针（判据的执行者，不是可选项）**：`internal/A03-xihe/scripts/check-ui-overflow.mjs`

```bash
# 一条命令证明判据两侧都能读：不需要起任何服务
node internal/A03-xihe/scripts/check-ui-overflow.mjs --fixtures
```

它必须报三件 —— **只报元素数会把设计行为报成缺陷**：

1. `docW` / `winW`（判据 ① 的原始读数）
2. 每个出视口元素的**最近裁剪祖先**（tag + computed `overflow-x` + 该祖先是否真能滚）
3. **无裁剪祖先的元素数**（**只有这个数才是真缺陷候选**）

四份夹具两两成对，证明例外条款真的在起作用、不是「一起放过」：

| 夹具 | 预期 | 证明什么 | 实测（1280×800） |
| --- | --- | --- | --- |
| `fixture-a-unclipped`（`w-[2000px]` 块 + 无裁剪容器） | **RED** | 探针**会红** | docW 2000 > winW 1280；unclipped 1；exit 1 |
| `fixture-b-clipped`（同一块塞进 `overflow-x:auto`） | **GREEN** | 例外条款**真生效** | docW 1280；出视口仍 1 个，但被 `DIV[auto]` 吸收 ⇒ unclipped 0；exit 0 |
| `fixture-c-shiki-like`（`PRE.shiki` + 314 字符长行） | **GREEN** | 设计行为不被误判 | docW 1280；出视口 2 个全在 `PRE.shiki[auto]` ⇒ unclipped 0 |
| `fixture-d-shiki-plus-unclipped`（shiki **在场** + 另有 2000px 无裁剪块） | **RED** | 例外**不是免死金牌** | docW 2000；unclipped 1 ⇒ 仅因页面上有 PRE 就放过整页会被这条抓住 |

**探针自己也会被变异验证**：把 `fixture-b` 容器的 `overflow-x: auto` 删掉（单行 `edit`），同一份夹具立刻从 GREEN 变 **RED**（exit 1），还原后 sha256 逐字节相同 —— 即「绿」不是恒真的。这就是 `D-1767` 要的东西：**有机器判据才配进文档；没有探针的口径一年后就是「文档说不能溢出、实际没人测」。**

**分档**：**P0 阻断**（点不动 / 数据矛盾 / 路径不可达）· **P1 明显**（层级、一致性、无障碍 AA 违例）· **P2 打磨**（间距、字重、微差）。P0/P1 一律转卡，P2 攒批。

**经验回流（这条是本节存在的理由）**：审阅发现的问题按两类分流 ——
```
① 判据没写清 ⇒ 回写本节（加判据/反例），下一批就不会再犯；
② 实现偏离判据 ⇒ 转卡修代码，不把「写在文档里」当修好。
每批审阅只留「新判据 + 新反例」，截图存证不堆进文档（图放 .tmp/<批次>/，报告给路径）。
```

**来源（2026-11-11 核对）**：Nielsen Norman Group《10 Usability Heuristics》（条目名已抓取核对）· W3C WCAG 2.2 Quick Reference · Apple Human Interface Guidelines · Material 3 · IBM Carbon · Refactoring UI。详见 `DEV-012-ui-ux-references`。

## 12. 动效判据（2026-11-18 用户裁定，与 §10 同构）

> **这一节为什么存在**：用户问「UI 是不是都是静态的、运行中之类的 UI 该不该有动效」，实测答案是「**不是静态的**（88 处动画应用点），但**没有一条判据管它**」—— 本文件此前 grep `动效|动画|transition` 只命中 §6 的一行（导航面板折叠），而配色已有完整的 L0–L4 预算 ⇒ **88 处是各人各写**。本节按 §10 的结构补齐：先答用途，再给预算阶梯与状态矩阵，最后给机器判据与已知局限。
>
> 逐处盘点（**A 该留 77 / B 该改 4 / C 该删 1 / D 不一致 6 = 88**）见 **跨仓路径** `internal/A03-xihe/evidence/2026-11-18-motion-audit/README.md`（ONE 工作区私有层，不入本仓链接）；复算：`node internal/A03-xihe/evidence/2026-11-18-motion-audit/motion-inventory.mjs`（退出码 0 = 四类之和 == 实测总数）。

### 12.1 动效只许表达两件事（用途）

动效的合法用途只有两个，第三条起一律不许：

| 用途 | 例子 | 判据（停掉动效后） |
| --- | --- | --- |
| **状态变化** | 加载中、提交中、进行中、开/关、上传中 | 用户会**漏掉「还在进行」** |
| **注意力引导** | 新内容进场、滚动边界渐隐、焦点转移 | 用户会**漏掉「出现了 / 位置变了」** |

**装饰性动效一律不许** —— 发光、装饰性呼吸边框、图标无限旋转、卡片悬浮升起这类，**一律不加**。判定问题：**这个动效停下来时，用户会漏掉什么？答不出 ⇒ 删**（与 §10「会误操作才值得上色」同一句式）。

### 12.2 动效预算阶梯（M0–M3，与 §10 的 L0–L4 并排读）

| 层级 | 用途 | 允许的表现 | 每屏额度 |
| --- | --- | --- | --- |
| **M0 静止** | 无状态变化的元素 | **无动效**；hover / focus 只走 §10 的通道（浅底 / 2px 焦点环） | 不限 |
| **M1 状态** | 加载中、提交中、进行中 | 唯一允许的**循环**动效：转圈 / 骨架 / 行级呼吸（同屏同语义只许**一种**载体） | 不限，但**同屏并发循环动效 ≤ 3 处** |
| **M2 引导** | 新内容进场、抽屉与菜单开合、滚动边界 | **一次性**过渡（≤250ms）或滚动驱动遮罩 | 每屏 ≤ 1 |
| **M3 强调** | 不可逆确认、必须看到的转移 | 一次性突出，**最多 2 个周期后静止** | 每屏 ≤ 1 |

判定问题：**这个动效消失时，用户会漏掉什么？** 漏掉「还在进行」⇒ M1；漏掉「出现了 / 位置变了」⇒ M2；漏掉「会毁掉东西」⇒ M3；**答不出 ⇒ M0（不许加）**。

### 12.3 状态矩阵（每种状态只许用对应通道，不许用动效**本身**表达状态）

| 状态 | 允许的动效 | 禁止 |
| --- | --- | --- |
| 加载中（首次） | 形状**未知** ⇒ 骨架 pulse；形状**已知** ⇒ 转圈 + 文案 | 整块内容抖动、文字色轮播闪 |
| 提交中 | 按钮内 14–16px 转圈 + 按钮禁用；文案可同时切换（「保存」→「保存中」） | 按钮尺寸 / 位置变化、文案消失、整键 opacity 呼吸 |
| 进行中（长任务 >1s） | **行级低频呼吸**，载体只能是**非文字、非图标**表面（边框 / 底色）+ **保留转圈** | 放大图标代替权重、opacity 呼吸压文字、整行快速闪烁 |
| 完成 / 失败 | **0ms 切换**：文字 + 图标 + 颜色一次到位 | 补过渡、淡出残留、完成时再来一次高亮脉冲 |
| hover / focus | 只走 §10（浅底 / 焦点环），**不加动效** | hover 触发放大、位移、发光 |
| 空态 / 错误态 | 无动效 | 无限脉冲当装饰（**空态脉冲 = 让人以为还在加载**） |
| 已完成的历史区域 | 无动效 | 回滚时滚动驱动动画**反复重放** |

**两条「不许用动效表达状态」的硬话**：

1. **状态档位必须由文字 + 图标 + 颜色表达，动效只是放大器**。只有动效 ⇒ 色觉障碍与动效敏感用户都读不到状态（WCAG 1.4.1 / 2.3.3）。
2. **`prefers-reduced-motion` 下状态必须仍然可辨**：动效关掉后，状态面不许退化成「与相邻态无差别」（§12.7）。

### 12.4 时长与缓动只有这 5 档（禁止任意值）

| 档 | 取值 | 缓动 | 用在哪 | 现状取值出处（2026-11-18 实测） |
| --- | --- | --- | --- | --- |
| **T0 即时** | 80–120ms | `ease` / `ease-out` | overlay、菜单、tooltip 进 / 出场 | vendor 15 处 `animate-in/out` 里 **12 处显式 `duration-100`**（覆盖 `animate-in/out` 的 150ms 默认）；`SheetContent` 与 `DialogScrollContent` 用 `duration-200`（归 T1，抽屉属结构变化）；`TooltipContent` 走 150ms 默认（**未定档，存量偏差**，见盘点报告 §7） |
| **T1 结构** | 180–250ms | `ease-out` | 抽屉、accordion、面板开合 | `animate-accordion-down/up` = **0.2s**（`tw-animate-css` 的 `--animate-accordion-*`）；`BaseModal` 0.2s |
| **T2 强调** | 300–400ms | `ease-out` | 一次性提示（**新增须在本节登记**） | 当前 **0 处** |
| **R1 循环·转圈** | 1s | `linear` | 加载 / 提交（`animate-spin`） | Tailwind 默认 1s |
| **R2 循环·呼吸** | 1.6–2.4s | `ease-in-out` | 进行中的行级呼吸（§12.3） | 当前**无实现**；新增须落此档 —— `animate-pulse`（2s / opacity 0.5）**不符合**，见 §12.5 |

**禁项（新增代码一律不许；存量在盘点报告 §7 登记）**：

- **任意值** `duration-[…]` / `ease-[…]` / `animate-[…]`：实测 `duration-[` **0 处**、`animate-[` **0 处**、`ease-[` **2 处**（同一行 vendor `MessageScrollerButton.vue:61`）⇒ **产品面必须保持 0**。
- **`transition: all` / `transition-all`**：只许**具名属性**（`transition-colors` / `transition-[opacity,transform]`）。实测 9 处（vendor 为主）+ 1 处 CSS（`BaseModal.vue:186-190`），登记为存量。
- **时长 / 缓动不得写在组件里**：新增档位先改本节表格，再改代码。

**机器判据（可跑，2026-11-18 读数即基线；2026-11-19 纠计量口径，判据未放宽）**：

```bash
cd A03-xihe/packages/ui/src
grep -ro 'duration-\[[^]]*\]' --include=*.vue --include=*.css . | wc -l   # 基线 0
grep -ro 'animate-\[[^]]*\]'  --include=*.vue --include=*.css . | wc -l   # 基线 0
grep -ro 'ease-\[[^]]*\]'     --include=*.vue --include=*.css . | wc -l   # 基线 2（vendor 同一行 2 处，逐条登记）
```

口径：**按出现次数计**——`grep -o` 让每个匹配单独成行，`wc -l` 才是次数。旧写法 `grep -rn … | wc -l` 数的是
**行**，同一行里两个任意值会读成 1，与上方散文和盘点报告 §7 的「2 处」自相矛盾（task-25 实测纠口径）。
执行者：`node internal/A03-xihe/scripts/check-motion-arbitrary-values.mjs`（ONE 仓、只读、~0.2 s）——
命中即 exit 1 并点名 `file:line`；面另含 `.ts`、注释不计；豁免必须**逐条 token 登记**且所在族登记在
`VENDOR.md` 族表（E1–E3，见该脚本文件头），**不许整目录放行**。

### 12.5 一通一义（同一视觉通道只承载一种语义）

§10 状态矩阵已把「**左侧 2px 指示条 + 浅底**」分配给 `selected`。⇒ **左侧 2px 竖条不得再用于「运行中 / 加载中 / 未读」** —— 同一屏里侧栏的选中态与聊天流的运行态会同时出现，用户只能读成「两个都被选中」。

同理 **`opacity` 呼吸只许作用在非文字、非图标表面**（`border` / `background`）。把 `animate-pulse` 打在含文字的整行或整键上，谷值会把文字 / 图标压到 50% 不透明度 ⇒ **周期性更难读**（动效的目的相反），且 0.5 幅度 + 2s 周期已进入 WCAG 2.3.1「闪烁」的关注区。

### 12.6 禁止加动效的位置（硬清单）

| # | 位置 | 为什么禁 |
| --- | --- | --- |
| 1 | **消息气泡进出场** | 高频流 + 虚拟滚动：动画与滚动锚定抢同一帧，滚动中插入节点会被重排吞掉动画（表现为「闪一下」）；滚动本身已提供「位置变化」信息 |
| 2 | **状态文字本身**（「运行中」→「已完成」） | 必须 **0ms 切换**。加过渡会让用户**以为过渡还没结束**（状态本来就不更新时更坏，见 §12.8）；文字是信息不是装饰 |
| 3 | **已有 hover 浅底的位置** | §10 把 hover 定为 L2（只加浅底）。叠加动效 = 每次指针移动都触发重绘，且把 L2 抬成 L3 ⇒ 预算与通道双破 |
| 4 | **列表行进场 / 排序重排** | 虚拟滚动下「新行淡入」与「行被复用」无法区分，用户会看到已读过的行重新淡入 |
| 5 | **流式输出 / 日志 / 终端追加** | 每帧新增都带动画 = 闪烁源；这类内容的变化速率**本身就是**动效 |
| 6 | **完成态与历史区域** | 「完成」后再补高亮 / 脉冲 = 让人以为还有后续；历史区域回滚时滚动驱动动画会反复重放 |

> 卡面原列的 3 条候选（气泡进出场 / 状态文字 / hover 已有浅底）**全部保留**；第 4–6 条是同一判据在虚拟滚动与流式场景的推论（对应 `MessageItem` / `MessageScrollerViewport` 这类高频面）。

### 12.7 prefers-reduced-motion 是硬要求

**要求**：任何新增动效**必须落在已有多媒体查询的覆盖内**，不许新增第二套开关。

| 已有实现 | 覆盖范围 |
| --- | --- |
| `styles/main.css:241` | `*, *::before, *::after` 的 `animation-duration` / `transition-duration` 压到 `0.01ms !important`（覆盖全量） |
| `styles/shadcn-vue-tailwind.css:569` | `.shimmer` 显式 `animation: none` + `-webkit-text-fill-color: currentColor`（文字渐变回退实色） |

**新增动效 PR 必查**：

- [ ] `prefers-reduced-motion: reduce` 下**状态仍可辨**（加载中有文字、进行中有静态标识、完成态与进行态可区分）
- [ ] 没有把 `animation` 写在内联 style 或晚于 `main.css` 的 `!important` 规则里（那会绕过全局覆盖）
- [ ] 循环动效在 reduce 下**静止而不是相位抖动**（见下「已知缺口」）

**已知缺口（2026-11-18 实测，`[源码]` 硬事实）**：现行全局覆盖只写 `animation-duration`，**缺 `animation-iteration-count: 1`**（主流 reset 是两者成对）。后果：`infinite` 动画仍在无限循环、周期被压到 0.01ms ⇒ 浏览器每帧采到近似随机相位，期望的「静止」可能表现为**抖动**。修法二选一：补 `animation-iteration-count: 1 !important`，或对 `animate-spin` 族加 `motion-reduce:animate-none`（63 处，宜用全局规则）。**视觉后果待浏览器实测**（本节只落源码读数）。

### 12.8 动效不能掩盖 bug（硬约束；F1 / F2 实证）

**已确认事实**：`F1` / `F2` 是**状态根本不更新** —— `e2e-1` 实测运行中锚点 25s 不变化（不是动效问题，是状态事实问题）。

⇒ **给一个不更新的状态加动画，等于用动效掩盖缺陷**：用户看到转圈 / 呼吸会读成「系统正在推进」，而真相是界面已经停了；排查时这类动效还会让人误判「链路是活的」。

**顺序写死，不许倒置**：

1. 先修**状态事实**（状态真的会 running → completed / failed）；
2. 再谈**动效表达**（该不该呼吸、权重多大）。

**PR 判据**：动效变更的 PR **不得**同时充当「状态不更新」的绕过手段 —— 若评审发现「加动效是为了让界面看起来在动」，拒收并转成状态缺陷卡。

### 12.9 判据的执行者与已知局限

- **执行者**：`internal/A03-xihe/evidence/2026-11-18-motion-audit/motion-inventory.mjs`（枚举 → 具名规则判定 → 断言「四类之和 == 实测总数」，**退出码即判据**）。**改本节判据必须同批改它**，否则本节又是一份没人验的文档（同 `D-1767`）。
- **已知局限（照实写，否则下次被当缺陷）**：
  1. 盘点口径是**应用点**，不是「视觉上可见的动效数」：虚拟滚动里同一元素复用会让一处代码产生多次可见动画。
  2. `transition` / `<Transition>` 只在盘点报告旁证层登记，未逐处归类（体量更大，且一半在 vendor）。
  3. vendor 侧（`src/components/ui/**`）**只判不修**：文件头要求与上游字节对齐 ⇒ 不一致要靠改 in-house 侧，或同批改 vendor 并留记录。


## 13. 顶栏 chrome 与输入域视觉权重（2026-11-19 用户裁定，`task-38`）

> 来源：用户在真机截图上指出四条 —— 顶栏两行、提示各占一行、抄送找不到、输入框随光标出现第二套方框。
> 这四条此前**没有任何判据覆盖**（`DEV-010`/`DEV-011` 全文 grep「顶栏|一行|单行|两行|导航」为空），所以自审查不出来。
> 本节把它们落成**带度量方式**的判据（`D-1871`：判据不写度量方式 = 等于没写）。

### 13.1 顶栏单行

**先划边界（这条比数值重要 —— 2026-11-19 用户裁定）**：

- **顶栏 = `workspace-secondary-nav` 一条带**，承载「页面导航 + 面板开关」。
- **`workspace-container-tabs` 属内容区，明确不属于顶栏**（用户原话：「容器标签页仍然是容器的，不是顶栏组件的」）。此前「说了好多次 1 行却落不了地」的根因就是这条边界没定义：读「一行」的人无法判断要不要动容器页签，于是全部停在原地。
- **`workspace-toolbar` 不是顶栏的一部分**：它是内容区（工作台）的工具带，桌面态**不得成带**。

**判据**：桌面态（≥ `md`）顶栏**只有一条**，即 `workspace-secondary-nav`；六个面板开关（files / code / changes / monitor / members / delegation）落在这条带的 x 区间内。

**度量方式**（1920×1080 真机，`getBoundingClientRect()`；不许肉眼说「看起来是一行」）：

| 元素 | 要求 |
| --- | --- |
| `[data-testid="workspace-secondary-nav"]` | `height == 32`（`h-8`）；y 与页面顶部对齐 |
| `[data-testid="workspace-secondary-nav-actions"]` | 存在且 `width > 0`，其 rect 的 x 区间**落在 nav 带的 x 区间内** |
| `[data-testid="workspace-toolbar"]` | 桌面态 `height == 0` **或不存在**；移动态仍渲染（窄屏唯一页面入口，见 `WorkspaceToolbar.vue` 的 C3 护栏注释，不许删） |
| 顶栏带计数 | 页面上方 y<40 区间内**只有一条**承载导航 + 面板开关的带 |

**实现约束**：面板开关簇用 Vue 核心 `<Teleport to="#workspace-nav-actions">` 搬进 nav 行右端 —— **props / emits / testid 一律不变**；**不得**为合并把 workbench 的 6 组 props + 6 组 emits 上提到壳层（那会把一张视觉卡变成结构重构）。

**反例锚点（判据必须能红，否则是装饰）**：把面板开关放回 `workspace-toolbar` 那条内容区工具带 ⇒ 上述「nav-actions 存在且落在 nav 带 x 区间内」与「toolbar 桌面不成带」两条**必须同时判红**。静态守卫：`packages/ui/src/features/workspace/__tests__/TopBarSingleRow.spec.ts`。

### 13.2 输入域三级视觉权重

**判据**：同一屏内的输入域**不得同权重全包** —— 什么都重要 = 什么都不重要。三级形态与适用：

| 级 | 形态 | 适用 | 实现锚点 |
| --- | --- | --- | --- |
| **一级 · 全包** | 完整 `border` + 圆角 | 主输入区（用户真正打字的那一个：消息正文 textarea 容器） | `InputArea.vue` composer 容器 |
| **二级 · 仅淡下边框** | `border-b`（淡色），**无**侧/上边框、**无**圆角框 | 辅助字段：发送 TO / 抄送 CC / 代发身份 | `RecipientField.vue` 行容器 |
| **三级 · 仅阴影** | 无 `border`，靠 `shadow-*` 建立可点面 | 行内可点件：chips、胶囊按钮（`+ 抄送`） | `RecipientField` chip、`cc-expand` |

**为什么 vendor 默认不满足**（AGENTS 硬规则要求的答案，不许跳过）：`components/ui/input/Input.vue` 基类是 `rounded-lg border … h-8` ⇒ **vendor 本身就是一级全包**。composer 的辅助字段是「label + chips + 输入」的一行内联形态；套 vendor Input 等于把 32px 实心框塞进每一行，**与主输入区同权重**，正是本节禁止的形态。⇒ 二级是设计系统里**新增**的形态，**只许在 composer 这几个字段上局部实现**；**禁止**给全站 `Input.vue` 加 `secondary` 变体（那会变成一个没人管的全局开关）。

**依据**：信息层级 —— 辅助字段不该与主输入区同权重。**不是**「看起来更轻」。

**度量方式**：真机取 `getComputedStyle` 三处读数 —— 主输入容器 `borderTopWidth == 1px` 且 `borderTopLeftRadius` > 0；TO/CC/代发行容器 `borderTopWidth == 0` 且 `borderBottomWidth` ≥ 1px；chip `borderTopWidth == 0` 且 `boxShadow != "none"`。

### 13.3 焦点指示只许一套

**判据**：任一可聚焦元素在同一时刻**只许有一套**焦点视觉。嵌套形态（外层容器 + 内层 `input`/`textarea`/contenteditable）里，焦点指示**由外层画**；内层**不得**自绘 `box-shadow` 环，也**不得**保留 UA / 全局 `outline`。

**根因（实测，别再走错方向）**：composer「随光标出现的矩形方框」**不是** UA outline —— 内层 `outline-style` 实测已是 `none`；是内层 textarea 自己画了 `box-shadow … oklab(0.205 0 0 / 0.5) 0 0 0 3px`，而外层容器是 `1px oklch(0.922 0 0)` 淡边框 ⇒ **两套框，颜色与宽度都不一致**。
`--ring` / `--sidebar-ring` = `var(--primary)` 是**刻意偏离官方 shadcn 色值**的定制（`m2-impl.md:26/48`）；**不得**为了「diff 更干净 / 贴近上游」把这两行换回官方 `oklch(0.708 0 0)` —— **那不是清理，是功能回退**。

**度量方式**（键盘路径纪律见 §焦点态取证纪律，脚本 `focus()` 不算）：Tab 到目标后**先 settle 再读数**，然后读 `getComputedStyle`。

> **settle 是硬前置（2026-11-19 实测踩坑）**：焦点环带 `transition-shadow` 时，按下 Tab 后**立刻**读 `getComputedStyle` 取到的是**动画起始值** —— 环层的 alpha 还是 0（实测同一元素：即刻读 `oklab(0 0 0 / 0) 0px 0px 0px 0px`，400ms 后 `oklab(0.205 0 0 / 0.5) 0px 0px 0px 2px`）。
> 后果是**系统性假阴**：有环被读成没环，「焦点指示缺失」读不出来。
> ⇒ **判据**：任何 `doubles` 读数（含 `doubles = 0`）必须同时给出**每站 settle 时长**，否则该 0 不算数；settle 下限 **220ms**（> vendor 默认 150ms 过渡）。本仓实测用的是 220ms。

1. **内层**：`outlineStyle == "none"` **且** `boxShadow == "none"`；
2. **外层**：`boxShadow` 含环**或** `outlineStyle != "none"`，二者**只取其一**；
3. **全仓扫**：键盘遍历每个 tab stop，把 `boxShadow` **逐层拆开**后再判 —— **环层** ⇔ `inset == false && offsetX == 0 && offsetY == 0 && blur == 0 && spread > 0` **且该层颜色 alpha > 0**；**投影层** ⇔ `blur > 0` 或 `offset ≠ 0`；alpha 为 0 的层是**透明占位**（vendor 的 `shadow-*` 工具类一次铺 5 层，多数透明），必须剔除。**双指示 ⇔ 存在有效环层 且 `outlineStyle != "none" && parseFloat(outlineWidth) >= 1`**。
    字面式 `boxShadow != "none"` **不可当判据**（2026-11-19 独立复跑实测：**假阳 2 / 假阴 4**）—— 它把 `dock-tab-files`（5 层全透明，实际只有一套 outline）与 `message-search-toggle`（`shadow-sm` 投影，焦点语言与它无关）记成缺陷，同时漏掉 4 个真双指示的 rail 按钮。
    **用修正式重扫的存量**：4 处 `global-rail-menu-*`（workbench / org-members / resources / settings —— `outline 2px solid` + `ring 2px` 实色环）与页签 `outline-1` + `ring-3` 并存（vendor `components/ui/tabs/TabsTrigger.vue:20`）。两处已同批修掉：rail 补 `focus-visible:outline-none`，vendor 删 `focus-visible:outline-1 focus-visible:outline-ring`（保留 `border-ring + ring-3` = 本仓通用焦点语言），改后复跑为 0。

### 13.4 提示语不得整幅占行

**判据**：字段说明**长期占一整行**的形态废止 —— 收进 tooltip（栈内 `components/ui/tooltip/*`，reka-ui 原语，**禁止手搓**），并四条同时成立：

1. **键盘可达**：焦点即显示，不得只 hover；
2. **文案单一来源**：仍在 `src/i18n/index.ts`，不得硬编码进组件；
3. **动效档**：按 §12.4 **T0 即时 80–120ms / `ease`|`ease-out`**，不得自造时长；
4. **AT 可读**：说明文本必须在 DOM 里常驻（`sr-only`），不得只在浮层打开时存在。

**例外（照实登记，不是放宽判据）**：`composer-workspace-less-hint`（task-547 F-A：独立会话少了两栏**必须说出来**）与一次性 `role="status"` 提示（`chat-to-empty-hint`、`compose-deeplink-unsat-hint`：带关闭按钮、非长期 chrome）**保持成行**。

**度量方式**：真机 Tab 到 `composer-*-hint-trigger` ⇒ `[data-testid="composer-*-hint"]` 的 `getBoundingClientRect().height > 0`；且 composer 区常驻说明段落计数（`.space-y-1.5 > p` 中 `[data-testid*="hint"]` 者）为 **0**。

## 14. 面向用户的文案不得出现「审查者形态」的字符串

> 来源：`D-1879` 裁定二（2026-11-19，`task-47`）。**本节是判据，不是文风偏好。**

**判据**：用户能读到的正文里**不得出现**下列形态 —— 类名、shell 命令、契约/规范文件名、`文件:行号`、接口路径、权限原子与枚举常量、内部票号，以及把内部黑话（「读面」「契约」）当正文用。

**为什么用「形态」而不是枚举具体词**：此前这类判据枚举的是「坏字段名」，而实际泄露的是**形态**。`task-47` 实测同一页同时泄露类名、`grep` 命令、`openapi.yaml`、`lib/legacyRoutes.ts:34` 与 `/api/v1/rag/*` —— **没有一条在预先枚举的清单里** ⇒ **枚举永远追不上新形态**（`task-39` 主结论）。

**类别错误（这是本条真正的成因）**：**可核验性属于测试面与证据面，不属于文案面。** 文案是给用户读的；「这条结论怎么验」是审查者读的。把审查者的验证义务写进用户正文，等于要求每个面向用户的句子自带出处 ⇒ **产物必然长成工程工作日志**，而且**测试会主动维持这个畸形**（`task-47` 的 spec 曾断言 `toContain("怎么核")` / `toContain("CP")`，改文案不改断言会让下一个人把文案改回去）。

### 14.1 度量方式（五必填：`D-1880` 扩的第五项，`D-1876`/`D-1879` 裁定三）

| 必填项 | 本条的取值 |
| --- | --- |
| **量什么** | 渲染文本过 9 条正则的命中数，**命中项与命中串都要点名** |
| **在哪量** | `document.querySelector("main").innerText`。**不用 `textContent`** —— 它把 `sr-only`、`display:none` 子树与脚本串一起吞进来 ⇒ 假阳 |
| **在哪些层读** | ① **渲染文本层 = 唯一判据层**；② 组件源码层（`t()` 键引用完整性，归 `lint:i18n`）；③ i18n 源层（**仅供定位，不作判据**）。**读数必须写明读的是哪一层** |
| **何时量** | 路由 `networkidle` 后 **+ 逐个展开 `role=tab`**；一次性 `role="status"` 与 toast **不计**（按设计是临时的） |
| **红的样子** | 逐条点名「面 / 正则名 / 命中串」，例：`条目 noDocList 命中「类名」形态：RagProxyController`。**必须能红**：`task-47` 已做变异验证 —— 把 `RagProxyController` 注回正文，2 条断言转红、其余 6 绿 |

### 14.2 正则白名单（唯一表达方式，禁枚举字符串）

```text
类名                [A-Z][A-Za-z]*(Controller|Service|Repository|Middleware)\b
命令                \bgrep\b
契约/规范文件名      \b(openapi|swagger)\.ya?ml\b
源码 文件:行号       \b[\w./-]+\.(ts|vue|java|yaml|yml|mjs|js|json):\d+
接口路径            \/api\/v1\/
权限原子/枚举常量    \b[A-Z][A-Z0-9]+(_[A-Z0-9]+)+\b
内部票号            \b[A-Z]-\d+\b
内部术语            读面 · 契约
```

**实现锚点**：`packages/ui/src/views/resources/__tests__/KnowledgeResourceView.spec.ts` 的 `LEAK_PATTERNS`（9 条）与两条负断言；机器门 `packages/ui/scripts/check-copy-leak.mjs`（`report-only`，见 `task-51`）。

### 14.3 扫描矩阵必须落盘

扫描面 = **`route × tab/layer`**，格子清单**入库**（`matrix.json`）。**只扫路由默认态会漏**：`task-47` 实测 `/resources/skills` 的默认层是「已迁到工作区设置」提示（渲染正文仅 66 字符），面板在 `role=tab` 之后；据此误判「9 页里只有 1 页泄露」，展开 tab 后实际 **4 个面命中**。

### 14.4 反例锚点（两个方向都要钉，`D-1876`）

- **扫 i18n 源会假阳**：源级命中 66 行，绝大多数是**注释**与**已迁走/未挂载**的面。实证：从源里认到的 `MANAGE_PERSONAL_SKILLS` 与内部票号 `P-189-3`，**在任何已渲染页面上都没出现** ⇒ **源级盘点 ≠ 渲染级证据**。
- **扫默认态会假阴**：见 §14.3。**仪器看不见 ≠ 不存在。**

### 14.5 例外（照实登记，不是放宽）

**用户主动展开**的技术细节不算违规：诊断面按 `packages/ui/AGENTS.md`「错误面：错误码 → 文案」的既有口径，把 `technicalDetail` 收进**默认折叠**的控件，并带入口标签说明它是技术细节。判据是「**用户读到的正文**」—— 折叠里的内容不是正文，但**必须让用户看得出那是技术细节**，不得混在正文里。
