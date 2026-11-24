# 文件长度门：为什么是自研而不是 oxlint（task-1030）

> 机器门：`node scripts/check-file-size.mjs`（`pnpm run gate:file-size`），已接进 `pnpm run lint` 的 gate 链。
> 基线：`packages/ui/file-size-baseline.json`，只能由脚本 `--write-baseline` 生成/收缩。

## 为什么不直接用 oxlint

**oxlint 1.83.0 不实现任何长度规则。** 判据是直接 grep 运行时插件表（[实测]，2026-11-24，`packages/ui`）：

```text
$ node -e "console.log(require('oxlint/package.json').version)"
1.83.0
$ Select-String -LiteralPath node_modules/oxlint/dist/plugins.js -Pattern <rule> -SimpleMatch
max-lines: 0
max-lines-per-function: 0
max-statements: 0
max-depth: 0
complexity: 0
max-nested-callbacks: 0
```

六条规则在 `node_modules/oxlint/dist/plugins.js` 中**全部零命中**：即使写进 `.oxlintrc.json`，oxlint 也不会报（未知规则被忽略），所以「配置一下就行」这条路不存在。

补充事实：

- 本门加入前，17 个 `scripts/check-*.mjs` 里没有一个量文件长度；`check-lint-rule-registry.mjs` 只管「`off` 规则要在登记册写明理由」。
- `oxlint-warning-baseline.json` 的 `byRule` 没有任何长度规则（同上，规则不存在）。
- 登记册里的 `max-statements` 是**单函数语句数**且已 `off`，与「文件长度」不是同一维度，不能替代本门。

因此本门是自研的**文件级**长度检查，不是重复 oxlint 已有的能力。若未来 oxlint 原生支持 `max-lines`，应优先删掉本门并改用规则；届时需同步删掉本文件与 `file-size-baseline.json`。

## 阈值（首版）

| 范围 | warn | error |
| --- | ---: | ---: |
| 通用 `.ts` / `.vue` | > 500 行 或 > 24,000 B | > 900 行 或 > 48,000 B |
| `src/i18n/messages/**` | > 900 行 或 > 90,000 B | > 1,200 行 或 > 120,000 B |
| `*.d.ts` | 豁免（逐项登记在基线 `$exempt`） | 豁免 |

取值理由：

- **行数是主信号**：500 行是「一个文件开始难以整体阅读」的经验线，900 行是「必须拆」的硬线。
- **字节是兜底**：单行几千字符的生成/内联数据文件行数可能不高但体积过大；24,000 / 48,000 B 约对应 500 / 900 行的常见 TS 密度（约 48–53 B/行）。
- **i18n 文案放宽**：`src/i18n/messages/**` 以键值文案为主，行数密度天然高（实测 60–65 B/行），按卡面放宽到 1,200 行 error；warn 定在 900 行作为提前信号。
- 扫描范围：`src/**` 的 `.ts` / `.vue`，整目录跳过 `__tests__`、`preview`、`e2e`（测试与预览不是产品源文件）。

## ratchet 语义

与 `oxlint-warning-baseline.json` 同一手法，但记录的是每文件 `{ lines, bytes }`：

| 情形 | 结果 |
| --- | --- |
| 不在基线，且超 error 阈值 | **exit 1**（新文件不许一上来就超标） |
| 在基线，但行数或字节变大 | **exit 1**（存量只许变小） |
| 在基线，且变小 / 文件消失 | 打印 `SHRINK` 提示，不阻断 |
| 在基线，持平且仍超 error | 允许（存量数 = 基线 `total`，当前 61，task-1041 收缩后） |

基线生成/收缩：

```powershell
cd packages/ui
node scripts/check-file-size.mjs --write-baseline          # 吸收 warn 以上存量；默认只增不删
node scripts/check-file-size.mjs --write-baseline --prune  # 同批收缩已变小/消失的条目
```

**基线于 2026-11-24 生成时同时扫描了 `HEAD` 与工作树的并集**（`--root . --root <HEAD 快照>`，同路径取最大值）：当时工作树里 task-1027 正在把 `src/i18n/index.ts` 拆成 `src/i18n/messages/**`，若只按工作树写基线，`HEAD`（`i18n/index.ts` 9,431 行）会立刻被判成「新超标」。并集保证基线对两棵树都成立；等 task-1027 合入后，`src/i18n/index.ts` 条目会以 `SHRINK 已消失` 提示，届时用 `--prune` 收账。

## 什么情况允许重生成基线（task-1041，2026-11-25）

`--write-baseline` 会把扫描树里的**当前值**写成新的允许值，对「基线内变大」的文件等于**永久放行这类增长**。
所以重生成不是收尾动作，而是**裁决动作**，必须同时满足下面四条；缺任何一条 ⇒ 不重生成，改成把文件拆小。

1. **逐文件写明「为什么必须变大」**，落在卡面或本文件，不接受「功能需要」这类空泛理由。
   可接受的理由形态只有**结构性必需**：新增了一个独立的交互控件 / 能力实体，无法用改写既有行表达，
   且**已经**用它替换掉的旧实现的删行抵扣过（判据：`git diff --numstat <commit>^ <commit> -- <file>` 的净增数
   与 diff 里的新增实体一一对得上）。
   反例（一律不允许写进基线）：加注释、加日志、加参数拼装、复制粘贴第二段分支、纯格式换行。
2. **该增长必须有测试钉住**——新增的控件/分支要有断言引用它，否则它属于可删项，应先删再重生成。
   判据不是「有测试文件」，而是测试里真的按 `data-testid` / 导出名选中了新增的那一处。
3. **增长后仍低于 error 阈值**。超 error 的增长只能拆，不能靠重生成基线消化——本门的存量豁免只发给
   「历史遗留」，不发给「刚刚变胖」。
4. **只重生成裁决过的那几条，禁止顺手吸收别的**。执行方式固定为**对已提交的 `HEAD` 快照跑 `--root`**，
   不在实工作树上直接跑：
   ```powershell
   # 在 A03 仓根，把某个已提交树导出到工作区外的临时盘（只读，不动工作树）
   git archive <被裁决的 commit> packages/ui | tar -x -C <盘符>:\zeotmp\<任务>\head-tree
   cd packages/ui
   node scripts/check-file-size.mjs --root <盘符>:\zeotmp\<任务>\head-tree\packages\ui --write-baseline --prune
   ```
   这样基线只会收敛到**该 commit 已知且已审**的读数。直接在实工作树上跑会把**并行 lane 在途的
   WIP / 别的卡未经裁决的增长**一起吸收（task-1041 实测：同一命令在 `2e0862b48` 快照上收敛 4 条、
   在当时的实工作树上多吸收 6 条未裁决增长）。
   重生成后必须**双向复跑**留证：① 对裁决树 `PASS`；② 对当前 develop `HEAD` 跑，确认剩余 `FAIL`
   恰好等于**未裁决**的那些（一条都不能少），以此证明没洗绿。

另外两条自证要求：连续两次 `--write-baseline` 的产物 SHA256 必须相同（脚本在内容等时会保留
`generatedAt`，不同即说明扫描树不稳定或有多根漂移）；`$exempt` 的理由由脚本原样继承，**不接受**
为了过门往 `$exempt` 里手工加路径。

> **禁止的做法**：改 `THRESHOLDS` 常量来「让门变绿」。「基线变小」和「阈值放宽」是两回事——
> 前者是把某个文件的历史读数往下压（收紧），后者是对全仓所有文件一次性放行（放宽）。
> 阈值变更属独立裁决，不在任何收缩卡的写域内。

本次（task-1041）据此重生成，逐条去向：

| 条目 | 变化 | 依据 |
| --- | --- | --- |
| `src/composables/api.ts` | 6,682 / 283,793 → **移出基线**（实 210 行） | task-1032 按域拆分，已低于 warn，`--prune` 收账 |
| `src/i18n/index.ts` | 9,431 / 587,587 → **移出基线**（实 111 行） | task-1027 按 32 域拆分，同上 |
| `src/components/settings/SettingsSidebar.vue` | 644 / 35,751 → 639 / 35,675 | task-1023 净变小（+63/−68），纯收缩 |
| `src/components/sidebar/Sidebar.vue` | 620 / 30,872 → **626 / 31,413** | 见下条裁决，满足判据 1–3 |

`Sidebar.vue` 的 +6 行裁决（`583ce8326`，2026-11-24 用户裁定「新建工作区」一步直达）：

- 构成是 `+1` 图标 import、`+2` 注释净增、`+10` 新增独立 `+` 按钮、`−7` 删除被取代的菜单项、
  触发器改属性 `±0`，`git diff --numstat` 实测 `19/13` ⇒ 净 **+6**，与 +541 B 同源。
- **必需性**：旧实现是 `+` → 菜单 →「添加 Workspace」两步。要一步直达就必须让 `+` 成为
  **直接触发** `openAddWorkspace` 的 `button`，而原来的 `+` 是 `DropdownMenuTrigger`，同一次点击
  不能既是直达又是开菜单 ⇒ 两个控件必须并存，`+10` 属新增实体而非改写；紧邻的 chevron 菜单
  承接导入源，被取代的菜单项 `−7` 已抵扣。抽公共 class 常量不会减少行数（+1 常量 −0 模板行），
  且属源码重构，不在本卡写域。
- **测试钉住**：`src/components/__tests__/Sidebar.spec.ts` 13 处断言按 `sidebar-new-workspace` /
  `sidebar-workspace-actions` / `sidebar-import-source` 选中新增控件；
  `e2e/mock/task-1023-first-click.spec.ts` 断言直达后 `sidebar-add-workspace` 数量为 0。
- **仍低于 error**：626 行 / 31,413 B « 900 行 / 48,000 B，属「比基线大」而非「超限」。

## 豁免

- `*.d.ts` 一律豁免（纯类型声明，无运行时代码）；生成器会把扫描到的每个 `.d.ts` 写进基线 `$exempt` 并附理由。
- 其他需要豁免的路径必须手工在基线 `$exempt` 里逐项写明理由 —— 但基线本体仍只由脚本生成；给已有的 `$exempt` 条目保留理由由 `--write-baseline` 原样继承。
- 豁免项只跳过判定，不隐藏读数：报告里会打印 `exempt N`。

## 已知边界

- 只做**文件级**长度，不做单函数长度/复杂度（oxlint 无对应规则，自研 AST 分析不在本卡范围）。
- 行数口径为 `wc -l`（换行符计数，末尾无换行补 1），不做「有效代码行」扣除。
- 本门不要求消除存量；存量拆分由 task-1031（i18n 二次拆）与后续卡推进。
