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
| 在基线，持平且仍超 error | 允许（存量 63 个，见基线 `total`） |

基线生成/收缩：

```powershell
cd packages/ui
node scripts/check-file-size.mjs --write-baseline          # 吸收 warn 以上存量；默认只增不删
node scripts/check-file-size.mjs --write-baseline --prune  # 同批收缩已变小/消失的条目
```

**基线于 2026-11-24 生成时同时扫描了 `HEAD` 与工作树的并集**（`--root . --root <HEAD 快照>`，同路径取最大值）：当时工作树里 task-1027 正在把 `src/i18n/index.ts` 拆成 `src/i18n/messages/**`，若只按工作树写基线，`HEAD`（`i18n/index.ts` 9,431 行）会立刻被判成「新超标」。并集保证基线对两棵树都成立；等 task-1027 合入后，`src/i18n/index.ts` 条目会以 `SHRINK 已消失` 提示，届时用 `--prune` 收账。

## 豁免

- `*.d.ts` 一律豁免（纯类型声明，无运行时代码）；生成器会把扫描到的每个 `.d.ts` 写进基线 `$exempt` 并附理由。
- 其他需要豁免的路径必须手工在基线 `$exempt` 里逐项写明理由 —— 但基线本体仍只由脚本生成；给已有的 `$exempt` 条目保留理由由 `--write-baseline` 原样继承。
- 豁免项只跳过判定，不隐藏读数：报告里会打印 `exempt N`。

## 已知边界

- 只做**文件级**长度，不做单函数长度/复杂度（oxlint 无对应规则，自研 AST 分析不在本卡范围）。
- 行数口径为 `wc -l`（换行符计数，末尾无换行补 1），不做「有效代码行」扣除。
- 本门不要求消除存量；存量拆分由 task-1031（i18n 二次拆）与后续卡推进。
