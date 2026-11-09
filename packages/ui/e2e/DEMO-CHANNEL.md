# X 宣传图文/截图出图通道（demo lane）runbook

> 为什么有这份文件：task-116 审计 mock 全量 8 条 skip 时发现 —— `XIHE_E2E_DEMO` /
> `XIHE_E2E_DEMO_DIR` **只出现在 4 个 spec 自身**，仓内没有任何 runbook（`mise.toml`、
> `package.json`、DEV 文档、`internal/` 全无）⇒「要不要跑 demo、怎么跑」只能读源码考古。
> 本文件是这条通道的唯一说明；从仓根 `grep XIHE_E2E_DEMO` 应能命中它。

## 这条通道是什么 / 不是什么

- **是**：人工出图通道 —— X 宣传卡 PNG、单文件 HTML 长图文、演示截图；产物给发布/宣传用。
- **不是**：回归面。它**默认不跑**（mock 全量里表现为 4 条 skip：`x-demo-card`、
  `x-demo-html-selfcheck`、`x-demo-to-cc` ×2），这是设计，**不是被遗忘的覆盖**
  （8 条 skip 的逐条审计见 task-116）。
- **当前处于冻结态**：D-111（用户 2026-11-05 裁定）——**截图冻结在 v5，不再重拍**，只允许
  HTML/CSS 层改动（声明文案、裁空白、加竖线），**不允许为取景改产品代码**。
  ⇒ 动手前先确认「这次是否被授权重拍」，别把冻结素材重跑一遍覆盖掉。

## 门控变量

| 变量 | 作用 | 示例 |
| --- | --- | --- |
| `XIHE_E2E_DEMO` | mock 变体总开关（card / html-selfcheck / to-cc） | `1` |
| `XIHE_E2E_DEMO_REAL` | real 变体开关（real-to-cc；card / html-selfcheck 也认它） | `1` |
| `XIHE_E2E_DEMO_DIR` | **产物目录**（截图落这里；card 与 html-selfcheck 读它的**上一级**放 HTML）。`to-cc` 未设即 throw | `one/.tmp/xh-demo/shots` |
| `DEMO_VARIANT` | 变体：`mock`（默认）/ `en` / `real`（html-selfcheck 另认 `real-en`） | `en` |
| `XIHE_UI_PORT` | UI dev server 端口。mock 变体复用**真组件**，页面要由 **develop 树**的 dev server 渲染（主检出默认 12630） | `12630` |
| `XIHE_DEMO_STATE_FILE` | **仅 real**：demo 账号状态 JSON（token / sessionId / workspaceId / connectionId；只读不打印） | — |
| `XIHE_CP_PORT` | **仅 real**：CP 端口（默认 12631；Node 24 会把 localhost 解析成 `::1`，spec 内固定 `127.0.0.1`） | `12631` |

## 输入契约（**不在本仓**，跑之前必须先就位）

`card` 与 `html-selfcheck` 读的是**已生成的 HTML**，位置固定为 `dirname(XIHE_E2E_DEMO_DIR)`：

| spec | 需要的输入 HTML |
| --- | --- |
| `x-demo-card` | `xh-to-cc-card.html` / `xh-to-cc-card-en.html` / `xh-to-cc-card-real.html` |
| `x-demo-html-selfcheck` | `xh-to-cc-multi-principal.html` / `-en.html` / `-real.html` / `-real-en.html` |

这些 HTML 历史上落在 `one/.local/evidence/x-demo-2026-11-04/`（**gitignored**），
**仓内没有生成器**。⇒ 若这些目录已被清理，两条 spec 缺输入就跑不了（会直接读文件失败）。
重新出图时请把输入 HTML 落到可追溯位置（`plans/PLAN-XXXX/evidence/` 或
`internal/A03-xihe/evidence/`），不要把「证据指针指向 gitignored 路径」这个坑再挖一遍。

## 三步顺序

1. **起 UI dev server（develop 树）**：`mise run dev:host`（或复用已在跑的 12630），
   确认 `XIHE_UI_PORT` 指向它。mock 变体**不写任何 CP 数据**（全部 mock 路由）。
2. **出截图 / 卡片**（产物落 `XIHE_E2E_DEMO_DIR`）：
   - `x-demo-to-cc` → `01-to-cc-chips.png`、`02-delivery-header.png`、`03-members-panel.png`、
     `04-run-grouping-actor.png`、`05-delegation-dag.png`
   - `x-demo-card` → `card.png` / `card-en.png` / `card-real.png`（1600×1200 单帧，零外链）
3. **自测长图文**：`x-demo-html-selfcheck`（`file://` 打开输入 HTML：零外链、图片 `naturalWidth>0`、
   打印媒体不塌；无产物，只断言）。

real 变体（另计 token 预算，见 D-77：一个会话最多 2 个 run、提示词写死短答、**构图问题只重截不重发**）
需要 demo 账号 + `XIHE_DEMO_STATE_FILE` + 真栈（UI 12630 / CP 12631）。

## 示例命令（PowerShell，在 `packages/ui` 下）

```powershell
# 前置：UI dev server 已起（develop 树），HTML 输入已放到 dirname(XIHE_E2E_DEMO_DIR)
$env:XIHE_E2E_DEMO = '1'
$env:XIHE_E2E_DEMO_DIR = '<产物目录>/shots'   # card / html-selfcheck 读它的上一级
$env:XIHE_UI_PORT = '12630'
$env:XIHE_E2E_BROWSER_CHANNEL = 'chrome-beta'  # 有头单窗口，见 playwright skill

# 2) 截图
pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/x-demo-to-cc.spec.ts --workers=1
# 2) 卡片（先有 HTML 输入）
pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/x-demo-card.spec.ts --workers=1
# 3) 长图文自测
pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/x-demo-html-selfcheck.spec.ts --workers=1
```

## 已知缺口（审计结论，别重复踩）

1. **输入 HTML 在仓外且无生成器**（见上）⇒ 通道可复现性依赖一个 gitignored 目录，属
   「只有当事人知道怎么跑」的慢性丢失风险。
2. **本文件之前不存在**：4 条 demo skip 的「在等什么」只能读 spec 注释；现在以本文件为准，
   spec 头部各留一行指针。
3. **冻结不等于废弃**：D-111 冻结的是「重拍」，不是这条通道本身；解冻时先核对 v5 素材是否仍在。
