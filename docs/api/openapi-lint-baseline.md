# check:openapi:lint 的 errors 基线与「只许减不许增」判据

> 落点理由（task-56）：判据要能被下一个人复跑核对，就必须和契约文档放一起，而不是只活在 mise 注释里。
> 检索过 \`docs/api/\`（inventory.md / inventory.generated.md / mcp-tools.md / mcp-protocol-matrix.md / problem-details.schema.json）与
> \`docs/i18n/**\`：没有任何地方记录 redocly 的计数基线，故新建本文件。

## 复跑命令

```
cd A03-xihe && mise run check:openapi:lint
# 等价直调（要更多问题时加 --max-problems）：
cd packages/ui && pnpm exec redocly lint --config ../../.redocly.yaml ../../docs/api/openapi.yaml --max-problems 400
```

## 当前基线（2026-11-19 03:0x 实测，HEAD = task-60 改动）

| 计数 | 值 | 说明 |
|---|---|---|
| errors | **0** | task-60 把最后 4 条 `nullable` 清到 0（明细与证据见下节） |
| warnings | **126** | 存量清账归 task-245，本门不设 `--max-warnings` ⇒ 不阻断 |
| 门退出码 | **0（绿）** | redocly 按 errors 退出；本门是 `scripts/validate-run.mjs` 的 `GATES` 成员（task-313 接线，task-176 起门列表在脚本里而非 mise `depends`）⇒ 它红则 `mise run validate` 红 |

**判据：errors 只许减不许增。** 基线 = **0**。任何提交让 errors > 0 ⇒ 该门红、`mise run validate` 红，必须在本卡/新卡里说明并修掉（没有「加一条基线」这条路）。

## 已清的 4 条（task-60，2026-11-19）

| # | 指针（原） | 规则 | 清法 |
|---|---|---|---|
| 1 | `#/components/schemas/DelegateSpawnSession/properties/parentSessionId/nullable` | struct | 改 3.1 写法 `type: [string, 'null']`，保留 `format: uuid` 与描述 |
| 2 | 同上 `/title/nullable` | struct | 同上（`title` 描述里「null when unreadable / 可读但无标题」的原意不变） |
| 3 | 同上 `/runStatus/nullable` | struct | 同上 |
| 4 | 同上 `/spawnedAt/nullable` | struct | 同上，`format: date-time` 保留 |

**为什么这次可以清**（task-56 当时不敢清，是对的）：`nullable` 是 OpenAPI **3.0** 关键字，本文档是 `openapi: 3.1.0` ⇒ 3.1 下它被当未知键**忽略**，即发布契约实际写的是「不可空」，而生产视图会返回 null —— 声明与实现不符，属**低估可空性**。
逐字段核对生产视图 `WorkspaceAgentController.toSpawnSessionsView`（`packages/control-plane/.../controller/WorkspaceAgentController.java:359-389`）：`parentSessionId`（:373-374）、`title`（:378）、`runStatus`（:380）、`spawnedAt`（:382）**四处都显式产出 null**。故 3.1 写法不是「新增可空声明」，而是把 `nullable: true` 原本想表达、却被 3.1 忽略掉的那层意思写对。

**顺带一条真结论**：本门此前**恒 exit 1** ⇒ `mise run validate` 在 `develop` 上恒红（`aggregateExit`：任一 1 ⇒ 1），而 `AGENTS.md:31` 又把它归进 report-only ⇒ 恒红的门被所有人当噪音绕过。task-60 同批把四处说法改准（见末节）。
## 本卡已修的 5 条（不是格式问题，是文档正文被吃掉）

原 9 errors 里 5 条属同一类：**flow 标量没加引号，而描述文本里有逗号** ⇒ YAML 在逗号处截断标量，后半句变成一个**野键**挂到父对象上。redocly 报的是「Property \`…\` is not expected here」，实际后果是**渲染出的 API 文档里那句描述只剩前半截**。

| 位置 | 被截断的描述 | 野键 |
|---|---|---|
| \`openapi.yaml:1375\`（follow-ups POST 200） | \`Idempotent replay - same key\` + 后半句丢失 | \`same text; nothing was written twice\` |
| \`openapi.yaml:1380\`（同路由 409） | \`One of the queue's own codes\` + 后半句丢失 | \`passed through unchanged - …\` |
| \`openapi.yaml:7668\`（ChatRunWaitingQuestionView.items.answer） | \`(durable\` 处截断 | \`inside the CP-to-Agent trust domain)\` |
| \`openapi.yaml:7728\`（TeamTaskRow.revision） | \`advisory CAS identity — visible to readers\` 后截断 | \`never gated on\` |
| \`openapi.yaml:7736\`（TeamTaskRow.writeScopeWarnings） | \`server-derived advisory overlap warnings — derived at read time\` 后截断 | \`never stored\` |

修法：给描述加引号（含撇号的用双引号），**类型、required、$ref 一律未动** ⇒ 零声明语义变化。证据：redocly errors **9 → 4**，warnings 126 不变；\`node scripts/validate-openapi.mjs\` 仍绿（paths 297）。

**顺带一条门盲区**：\`validate-openapi.mjs\`（check:openapi，语法 + 冻结切片）对这 5 处**全绿放行**，只有 redocly 的 struct 规则抓到 ⇒ 「四道门各管一轴」不是套话，这条门的存在价值就在这。

## 四处说法已同步（task-60 同批，A1）

「errors 当前 0 / 124 warnings」与「report-only / 不接 validate」这两类失真，task-60 已按工作区规则（改 `mise run` 命令须同批同步 README、AGENTS.md 与该命令所在 DEV 编号中英）逐处改准：

- `A03-xihe/AGENTS.md:31` —— 从 **report-only** 名单里移出，改标「属 validate 门段（`scripts/validate-run.mjs` 的 `GATES`，errors-only，基线 0）」并注明「它 exit 1 时 `mise run validate` 恒红」。
- `A03-xihe/README.md:190` —— 命令表注改为 `errors baseline 0 since task-60`，warnings 计数 124 → 126。
- `docs/i18n/zh-Hans/DEV-002-developer-guide.md:608` 与 `docs/i18n/en/DEV-002-developer-guide.md:661` —— 「接入 `validate.depends`」改为「接入 `validate` 门段（task-176 起门列表在 `scripts/validate-run.mjs` 的 `GATES`）」；「当前 0」改为「基线 0」，并补一句「2026-11-19 前该门因 4 条 `nullable` 恒 exit 1 ⇒ validate 恒红」。
- `A03-xihe/mise.toml` —— 任务 description 的基线 4 → 0；接线注释块（原写「dev-only；lint 未接入 validate」「本门 report-only 且无自动执行者」）改为如实描述；另一处「实测 errors=0 / warnings=124」更新为 0 / 126 并注明 task-60 清账。

复跑核对（2026-11-19 实测）：`mise run check:openapi:lint` **exit 0**（0 errors / 126 warnings）、`mise run check:openapi` **exit 0**（paths 297，冻结切片全过）。
