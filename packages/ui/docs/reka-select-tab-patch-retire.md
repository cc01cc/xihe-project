# reka-ui Select Tab patch 的退役判据（task-1040）

> 机器判据：`node scripts/check-reka-select-tab-patch.mjs`
> 触发点：依赖升级卡（升 reka-ui 时）与定期巡检（`--registry`），**不进** `pnpm run lint` 链（理由见末节）。

## 一句话

`patches/reka-ui@2.11.0.patch` 让 Select 弹层里的 **Tab 关层并把焦点前移到触发器之后**，
而不是把 Tab 无条件吞掉。上游已在 PR **unovue/reka-ui#3168** 修好并合入 `v3` 分支，
但**没有任何已发布版本包含它**。所以现在 patch 仍必须存在；退役只在「上游发了等价版本」后发生。

## 事实（可复现）

| 项 | 读数 | 来源 |
| --- | --- | --- |
| patch 内容 | 92 行 / 4 hunk，改 `dist/Select/SelectContentImpl.js` 与 `.cjs` 各 2 处 | `fccc6bee0`（task-31） |
| 上游原行为 | `if (event.key === "Tab") event.preventDefault();`（Tab 被吞，键盘用户离不开弹层） | 2.11.0 tarball 源码 |
| patch 后行为 | `if (event.key === "Tab" && !isModifierKey) { preventDefault(); if (!shiftKey) tabFocusOut(); onOpenChange(false); return; }` 加 `onUnmountAutoFocus` 里 `tabFocusedOut` 放弃回焦 | 本地 dist 源码 |
| PR #3168 | merged，base=`v3`，`2026-11-06T12:44:17Z`，merge `ae34c682`，7 文件 +211/−10 | GitHub API 实测 |
| 2.11.0 发布 | `2026-10-05T06:31:12Z` | npm registry 实测 |
| 3.0.0-alpha.0 发布 | `2026-11-05T08:35:41Z` | npm registry 实测 |
| alpha.0 是否含修复 | **不含**。Tab 分支在 `dist/Select/useSelect.js:590`，仍是 `if (event.key === "Tab") event.preventDefault();` | tarball 实测 |
| dist-tags | `latest: 2.11.0`、`alpha: 3.0.0-alpha.0` | npm registry 实测 |

**时序推论**：alpha.0 发布（11-05）早于 PR 合并（11-06），所以 alpha.0 不可能含修复。
这也是为什么「拉 alpha 试一下」不能替代本门。

## 退役触发条件（机器可验）

存在一个**已发布（非 prerelease）**的 reka-ui 版本，其 tarball 的 dist 里 Tab 行为等价于 `ae34c682`
（Tab 关层 + 非 Shift 前移焦点 + 不提交高亮项）。不是「等上游发版再看」。

```bash
# A. 查有没有已发布版本自带修复
node scripts/check-reka-select-tab-patch.mjs --registry
#   registry-verdict: PATCH_REQUIRED        ← 仍需 patch
#   registry-verdict: PATCH_OBSOLETE 3.x.y  ← 可以退役，附版本号

# B. 拿「当前安装版本」的上游 tarball 与本地 dist 对照（退役前最后一道）
node scripts/check-reka-select-tab-patch.mjs --upstream
```

结论口径（离线永不判退役）：

| 本地 dist | 上游 tarball | 结论 | 含义 |
| --- | --- | --- | --- |
| 关层前移 | 吞掉 | `PATCH_REQUIRED` | 是 patch 在干活，不能删 |
| 关层前移 | 关层前移 | `PATCH_OBSOLETE <版本>` | 上游自带，可退役 |
| 吞掉 | 吞掉 | `PATCH_DECLARED_NOT_APPLIED` | 声明了 patch 但没打上（E1/E3 同族） |
| 吞掉 | 未对照 | `PATCH_REQUIRED` | 键盘可达性缺口 |
| 关层前移 | 未指定 | `PATCH_EFFECT_INSTALLED` | 只说「现在起作用」，不是退役许可 |

## 缓存红线（写进脚本行为，不靠口头）

`.vite/deps/reka-ui.js`（约 1.55 MB 预打包副本）是**第二个代码来源**，可与 `dist` 各自独立过期：

- 缓存旧、dist 新时，行为验证会**假红**（E3）
- 两者都旧时，会**假绿**（E1）

因此本门在 `dist` 与预打包副本结论不一致时**拒绝给结论**（exit 2，`INCONCLUSIVE_CACHE_STALE`），
要求先 `--purge-cache`。删缓存有副作用（正在跑的 dev server 会重新优化依赖），故不自动执行。

```bash
node scripts/check-reka-select-tab-patch.mjs --purge-cache
```

## 退役动作清单（**本卡不执行**）

1. 删 `patches/reka-ui@2.11.0.patch`。
2. 删 `pnpm-workspace.yaml` 的 `patchedDependencies` 里 `reka-ui@2.11.0` 那一行（**只删这一行**，
   `source-map-resolve@0.6.0` 保留）。
3. 升 `reka-ui` 到含修复的版本并 `pnpm install`（lock 的 `patch_hash` 应消失）。
4. **同批**跑 `packages/ui/e2e/real/select-tab-apg.spec.ts`，必须仍绿 —— 这是「行为等价」的唯一证明，
   本门只证 dist 文本语义。

**反证要求**：删 patch 后若 spec 红在 `expect(locator).toBeHidden()` 的 `Received: visible`
⇒ 上游语义不等价，**恢复 patch 并停下报告**，不许改成「接受差异」。

## 同型待办（**本卡不实施**）

`patches/source-map-resolve@0.6.0.patch`（843 B）是 ESM default 导出兼容补丁，上游包已 deprecated。
可固化的同类判据是「装上的包是否已自带等价导出」，形态与本文一致（读安装树 + 对照上游 tarball）；
现在没有 reconfirm 机会，先登记待办，不写脚本。

## 为什么它不接进 `pnpm run lint`

1. 它读 `node_modules/` 与 npm registry，不是本仓源码：干净检出/CI 无 `node_modules` ⇒ 只能
   `NOT_EVALUATED`，接进 lint 只会造噪声。
2. 它红表示「上游发版了该退役」，不是本仓缺陷，不该阻断无关改动的 lint。
3. 正确触发点是升级卡与巡检，不是每次提交。

**接线点**：升 `reka-ui` 的依赖升级卡必须跑 `--upstream` 并把结论贴进卡面；巡检用 `--registry`。
