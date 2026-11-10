---
name: xh-settings-ui-design
description: XH 设置区 UI 设计与实施判据：层×域模型（instance/user 两层）、内容列宽度唯一口径、计数与徽标量纲、字段级编辑闭环、vendor 组件优先级。含 15 条可直接贴进 PR 的验收清单与 mock P0 反例对照。写/改设置区页面、配置域表单、审批分类页或 settings mock 预览时使用。 [Scope: XH]
license: MIT
metadata:
  category: design
  checked_at: "2026-11-10"
  source:
    - webui-design-research-20261110（WebUI 组件采用矩阵，task-228）
    - settings-ui-issue-inventory（设置区问题穷尽盘点，task-227）
    - settings-mock-issue-audit（设置页 mock 截图审计，task-20 产出，未入库快照）
---

# XH 设置区 UI 设计判据

给设置区（`/settings/instance/*`、`/settings/user/*`、`/workspace/:id/settings`）写页面、改表单、画 mock 预览时，**先过本文五条硬判据，再照 §5 清单自检**。本文不是观感清单，是可判定的实施约束：每条都指向源码位置或可执行命令。

**适用**：设置区新增/改造页面、配置域字段表单、导航与计数、settings mock 预览。
**不适用**：聊天界面（见 `ai-chat-ui-design`）、非设置区的工作区面板。

## 1. 五条硬判据

### H1 字段集只能来自 CP schema，不得自造
合法键集 = `packages/control-plane/src/main/resources/config-schemas/<domain>.json` 的 `properties` 键集，**不是**别的 mock、不是想象、不是"业界通常有"。

```bash
# 域键集（唯一事实源）
node -e "const s=require('./packages/control-plane/src/main/resources/config-schemas/rag.json');console.log(Object.keys(s.properties).join(' '))"
# 新键必须先证明三层有消费方，0 命中即自造
git grep -n "<key>" -- packages/control-plane packages/agent packages/runtime
```

[源码] `rag.json` 只有 **4 键** `chunkSize/chunkOverlap/topK/minScore`，类型 `["integer","string"]`，且 `additionalProperties:false` ⇒ 屏上多画的键**写进去也会被 CP 拒**，属"按图实现即返工"。`chunkOverlap` 是真键，却曾被漏画。

### H2 层模型：UI 只有 instance | user 两层，**且不要两层 SidebarProvider**
- 层由路由 `meta.settingsLayer` 唯一决定，矩阵在 `src/lib/settingsIa.ts`；组件内**禁止**另写一份层判定。
- [文档] **Q-1110-45 / task-253 已裁定**（台账）：工作区块配置层从 UI 退役（路由、域页、域内页签、`?tab=config` 全删）。CP 侧仍保留 `workspace` 可写域（`ConfigService.java:94-96`，task-250 仅标 deprecated）⇒ **"CP 有三层"不等于"UI 要画三层"**；工作区设置只有 `general|mcp|members|credentials|knowledge` 五个 tab。
- 看到 task-20 审计里"必须改回三层（M-01）"的结论时，按本条执行，**不要照它恢复第三层**。
- 左栏/壳层**只允许一个 `SidebarProvider`**：两层 Provider 有 5 处硬冲突 —— 模块级快捷键常量（`SIDEBAR_KEYBOARD_SHORTCUT`）、单一 cookie 名、宽度 inline 写死、`fixed left-0` 布局、移动端双层 Sheet。设置区左栏与工作区左栏共用同层壳。

### H3 内容列宽度只有一个数：1152px（`max-w-6xl`）
```
mx-auto w-full max-w-6xl px-6
```
[源码] `layouts/SettingsLayout.vue:117`、`views/settings/ConfigSettings.vue:121,124`、`components/settings/SettingsLayerHeader.vue:43`、`features/workspace/pages/WorkspaceSettingsView.vue:230,243` 全部是 `max-w-6xl`（72rem = **1152px**），左右 `px-6`（24px）。

**禁止**：局部字面量宽度（`max-w-[920px]` 之类）当作设置区内容宽；标注/注记线按 920/960/1010 等自算数字画。历史 mock 里 `max-w-[920px]` + 注记线 `left-[1010px]` 就是这条的反例（真实列右界 960，注记偏右 50px）。

### H4 计数与徽标：组徽标数入口、行徽标数字段，且必须带图例
同列出现两个量纲时，**形状 + 量词 + 图例**三样缺一不可：

| 位置 | 数什么 | 文案 | 例 |
| --- | --- | --- | --- |
| 分组头徽标 | 该组**入口数** | 「17 个入口」 | `SidebarGroupLabel` 右侧 |
| 行尾徽标 | 该域**字段数** | 「14 项」 | `SidebarMenuBadge` |
| 覆盖/只读统计 | 有效层与锁的**键数** | 「覆盖 3 项 · 只读 2 项」 | 域页头 `Badge variant="outline"` |

[源码] 现状 `SettingsSidebar.vue` **不渲染任何计数**（只有 `items.length > 0` 过滤）⇒ 本条是**新判据**，实施时同批加图例（首次出现处一行 `text-xs text-muted-foreground` 说明），否则量纲歧义照旧。

### H5 字段级编辑闭环：六件套一件不能少
复用 `components/settings/ConfigDomainPanel.vue` 现成结构，不自造：

| # | 能力 | 现成 testid / 入口 |
| --- | --- | --- |
| 1 | 有效层徽标 | `config-key-layer-badge-<domain>-<key>`（:432） |
| 2 | 来源 + 跳层 | `config-source-*`（:441）、`config-source-jump-*`（:448） |
| 3 | env 锁 / 管理员锁（两枚**不同**徽标，不共样式） | `config-env-lock-*`（:474）、`config-admin-lock-*`（:502） |
| 4 | 数值校验错误位 | `config-number-*`（:594）、`config-number-error-*`（:598） |
| 5 | 逐项重置 | `settings.resetToDefault`（:662） |
| 6 | 域级 Save + 脏态 | `common.save`（:674）；保存等真实 PUT 200 才清脏态 |

缺任一条即"比现状退步"。**新增面不许比现有面少能力**（这是 P0 级判据，不是打磨项）。

## 2. 三份输入（快照，2026-11-10 核对）

来源清单见 frontmatter `metadata.source`；正文只保留可执行结论，不依赖外部文件存活。

| 输入 | 快照结论 | 本文怎么用 |
| --- | --- | --- |
| WebUI 组件采用矩阵（task-228） | 已 vendor **34 族 / 187 文件**；缺 6 件（其中 `collapsible`/`field` 的 reka 原语已在树里）；`Sidebar` 三档固定宽 vs 我们 220–360 拖拽宽**模型冲突** | A12 vendor 优先；§3 借/不借 |
| 设置区问题穷尽盘点（task-227） | **75 条**（P0 3 / P1 24 / P2 38 / P3 10）；量化基线 = 左栏 **264px** 固定、内容列 **1152px**、导航 **≥32 项**、**6 档字号**、左栏图标 **0** | H3/A4/A13 的数字依据 |
| 设置页 mock 截图审计（task-20） | 对 20 条初判推翻/修正 **5 处**：①920 标注与渲染不符但**归因相反**（错的是注记线）②底部横滚**不是布局溢出**（截图 DPR/视口现象）③两枚 chip **本就不同 variant**（真问题是无语义分色）④`for/id` **是有的**（缺 `aria-describedby`/`aria-current`）⑤"6 项无展开入口"前提要改（那 6 项**不是真实键**）。P0 四条 = invent 键 / 层模型 / `128k` 写入即崩 / 丢编辑闭环 | §4 反例素材；其 M-01「必须三层」已被 H2 取代 |

## 3. 该借与不该借的 Sidebar 设计（task-257 前置）

**该借的 6 条模式**：①`SidebarGroup`/`SidebarMenu` 语义结构；②`SidebarMenuButton` 尺寸与 tooltip 折叠态；③`collapsible="icon"` 折叠语义；④`Ctrl/Cmd+B` 与 `metaKey||ctrlKey` 判断；⑤`SidebarMenuSkeleton` 加载态；⑥`useSidebar()` 上下文读写。

**不该借的 4 条**：①两层 `SidebarProvider`；②cookie 持久化（我们单一 writer 是 `useWorkspaceLayout` → `xihe-layout-global`）；③宽度 inline 写死（走 CSS 变量收口）；④`fixed left-0` + 移动端双层 Sheet（现有布局是 `AppLayout` flex 链 + `clampNavWidthForViewport`）。

## 4. 反例区：错误写法 → 正确写法

| 错误写法（来自 mock P0/P1） | 正确写法 |
| --- | --- |
| 硬编码 `keys: 9` 并画 6 个 CP 里不存在的键（`embeddingModel`/`indexerEndpoint` 三层 `git grep` 0 命中） | 键集从 `config-schemas/<domain>.json` 读；徽标用 `computed` 数真实键 |
| 数值字段纯文本框，把 `128k`/`8`/`0.35` 当字符串提交 | `type="number"` + 单位/范围说明；越界给 `config-number-error-*`（`128k` 会让 agent `int()` 抛异常） |
| 只画 3 个裸输入框，来源/锁/reset/Save 全丢 | 照 H5 六件套复用 `ConfigDomainPanel` 现成行结构 |
| 注记线 `left-[1010px]` 标"内容列 920" | 不画局部数字；要标就按 `max-w-6xl` 1152 + `px-6` 计算，且标"仅 mock 注记"并做可开关 overlay |
| 组头 `17` 与行尾 `14` 同字号同 `font-mono` 无单位 | 「17 个入口」/「14 项」+ 形状区分 + 图例（H4） |
| 实例层页上写"3 项被下层覆盖"（实例层没有下层） | 「由实例层固定，下层只读」，并指名是哪几个键 |
| 搜索框标 `⌘K`（产品在 Windows 原生） | 运行时判 `/Mac|iPhone/.test(navigator.platform)` → `⌘K` / `Ctrl K`；无功能就别画壳 |

## 5. 验收清单（可直接贴进 PR）

- [ ] **A1 键集**：页面渲染的字段 == `config-schemas/<domain>.json` 的 `properties` 键集；新增键前先改 CP schema 并给出三层消费方。
- [ ] **A2 层模型**：层只由路由 `meta.settingsLayer` / `lib/settingsIa.ts` 决定；组件内无第二份层判定；未"恢复"工作区配置层。
- [ ] **A3 单 Provider**：壳层只有一个 `SidebarProvider`；无第二份折叠状态、无第二份快捷键常量。
- [ ] **A4 宽度**：内容列 `mx-auto w-full max-w-6xl px-6`；全页无设置区专用字面量宽度。
- [ ] **A5 来源闭环**：每个字段行有 `config-source-*` 与跳层入口（可写层才有 jump）。
- [ ] **A6 双锁区分**：env 锁与管理员锁是两枚不同徽标与文案；页面无"锁定开关"入口。
- [ ] **A7 数值控件**：数值域有单位/范围/校验位（`config-number-error-*`），不接受 `128k` 这类带单位字符串。
- [ ] **A8 Save/Reset/脏态**：域级 Save 在无改动时 disabled；有逐项 reset；保存等真实 PUT 200，失败保留草稿。
- [ ] **A9 计数图例**：组徽标数字入口、行徽标数字段、量词不同；首次出现处有图例。
- [ ] **A10 层名单一**：路由/面包屑/左栏/页头四处层名取自同一 i18n 键，无"实例层/实例配置/实例"三名并存。
- [ ] **A11 三态显式**：空态、`settings-not-found`、`SettingsPermissionGate` 的 `no-atom`（信息条 + 照常取数）与 `atom-denied`（403 卡片 + 主体不挂载）不混用。
- [ ] **A12 vendor 优先**：新增块先查 `src/components/ui/`（34 族/187 文件）；手搓须在 PR 写"为什么现有库不能用 + 被否决候选"。
- [ ] **A13 图标**：设置区左栏与页头有 `@lucide/vue` 图标（现状左栏 0 图标是已知缺陷，别复制）。
- [ ] **A14 预览合规**：mock 预览用真组件 + mock 数据，不手写 HTML，不调 `/api/v1/**`；画布 1920×1080 单屏。
- [ ] **A15 浏览器证据**：桌面 + 移动各一张截图（固定 `viewport: 1920×1080`）；mock 截图不得用 `max-w` 局部数当"产品宽度"。

## 6. 诚实边界

- 本文判据来自**源码 + 报告**，无真栈截图读数（两栈当前均未起）；A4/A9 的视觉结论需要下个真栈窗口复核。
- 三份输入的原始报告属**外部快照**（其中 task-20 那份未入库、不保证长期存在）；可复用结论已内联进 §2/§4。改判据前按 frontmatter `metadata.source` 重新核对，不要凭本文的二手数字下判断。
- 层的"两层"是 **UI 产品事实**（Q-1110-45），不是 CP 事实；CP 侧工作区层仍为 deprecated 可写域，恢复 UI 入口须另立 PLAN，不得凭 CP 支持就加回来。
