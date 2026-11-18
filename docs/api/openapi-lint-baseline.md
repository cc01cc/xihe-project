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

## 当前基线（2026-11-19 02:1x 实测，HEAD = a1c756b9f + 本卡改动）

| 计数 | 值 | 说明 |
|---|---|---|
| errors | **4** | 全部是 \`DelegateSpawnSession\` 的 \`nullable\`（见下表） |
| warnings | **126** | 存量清账归 task-245，本门不设 \`--max-warnings\` ⇒ 不阻断 |
| 门退出码 | **1（红）** | redocly 按 errors 退出；本门已接入 \`validate.depends\`（task-313）⇒ \`mise run validate\` 这条腿一直是红点，靠 keep-going 如实显示而非阻断 |

**判据：errors 只许减不许增。** 基线 = 4。任何提交让 errors > 4 ⇒ 该门红且必须在本卡/新卡里说明；把 4 清到 0 的提交必须同步改本文件与 \`mise.toml\` 的基线数字。

## 剩余 4 条明细（同一行 flow schema：openapi.yaml:7427）

| # | 指针 | 规则 | 性质 |
|---|---|---|---|
| 1 | \`#/components/schemas/DelegateSpawnSession/properties/parentSessionId/nullable\` | struct | \`nullable\` 是 OpenAPI **3.0** 关键字；本文档 \`openapi: 3.1.0\` ⇒ 3.1 里它被当未知键**忽略** |
| 2 | 同上 \`/title/nullable\` | struct | 同上 |
| 3 | 同上 \`/runStatus/nullable\` | struct | 同上 |
| 4 | 同上 \`/spawnedAt/nullable\` | struct | 同上 |

**为什么不在本卡清**：修法是把 \`nullable: true\` 换成 3.1 写法 \`type: [x, 'null']\`，那是**声明该字段可空** = 改声明契约，须逐字段核对视图实际会不会返回 null（例如该路由的行都来自 \`Session.spawnedFromSessionId\`，子会话的 parentSessionId 实际非空 ⇒ 直接改成可空反而可能与代码不符）。按 D-1879 的课，这种判断不能靠猜，故留契约面另卡，本卡只把注释与计数改准。

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

## 待同步面（本卡写面之外，已报 Lead）

「errors 当前 0 / 124 warnings」这句在 HEAD 上已失真，除 mise.toml 外还出现在：
- \`A03-xihe/AGENTS.md:31\` —— 把 \`check:openapi:lint\` 归入 **report-only（默认恒 exit 0）**，实测 exit **1** ⇒ 分类失真（更严重的一条）。
- \`A03-xihe/README.md:190\` —— 命令表注「errors-only (124 warnings don't block)」。
- \`docs/i18n/zh-Hans/DEV-002-developer-guide.md:608\` 与 \`docs/i18n/en/DEV-002-developer-guide.md:661\` —— 双语各一份「判据只有 errors（当前 0）/ the measured 124 warnings」。

按工作区规则「改 \`mise run\` 命令须同批同步 README、AGENTS.md 与该命令所在 DEV 编号（中英）」，这四处应与本卡同批改；task-56 写面只有 \`mise.toml\` + \`docs/api\`，故在此登记并请求扩 scope 或另卡。
