# `packages/ui/e2e` 说明（车道级事实）

> 本文件只登记**车道级**的读数与口径（分母、标记、命令、门现状）；包级规则仍在 [`../AGENTS.md`](../AGENTS.md)。
> 选这里而不写进 `packages/ui/AGENTS.md` 的理由：①这是 mock 车道的**分母口径**，作用域就是 `e2e/`，写在使用处才不会与包级指南漂移；②`packages/ui/AGENTS.md` 体量已大且本批任务与 `task-117` 的写面重叠，**只加车道文件、不动包级指南的相关段落**可避免"两处各记一份"。

## 「产品文案/IA 覆盖」的分母口径（2026-11-12，`task-311` §2b）

**分母只有一个数 = `expected` 计数 − `[mock-self]` 计数 = 328 − 1 = 327。**

> `347` 是 **collected**（`expected 328` + `skipped 20`），**不是分母**。skipped 用例本来就没在证明任何覆盖，把它算进分母等于让分母虚高、覆盖率虚低；两个数并列会被下一个人各取所需，故此处只认 327。（"skipped 里有的其实在跑断言"是另一件事：那要先把 skip 去掉再进 `expected`，不混进分母口径。）

**什么叫 `[mock-self]`（只有一型，必须落到来源 `file:line` 才能标）**

| 型 | 定义 | 判定证据（两条都得有） |
| --- | --- | --- |
| **页面自洽** | 被测页面是 preview 稿面本身（`/preview*.html` 或 `/__ui-preview`），断言的期望文本由**该页面自己的源码**产出 | ① `goto()` 指向 preview 页；② 期望字面量在 `src/preview/**` 有 `file:line`，且在产品源码 `src/**`（排除 `src/preview/**`）**零命中** |

**为什么"桩给定文案"不算 `[mock-self]`（`D-1062` §2 `b` 裁定后由 Lead 补硬的判据）**

> `plan-0750` 那类断言的实质是「**给定一段文案，产品能不能把它显示出来**」—— 那是**渲染行为**，真 E2E 就该测它，正确性不依赖"文案由谁拥有"。而 `[mock-self]` 要标的是另一种病：「断言值只存在于 mock 稿面，**产品把它改坏了也照样绿**」。
> ⇒ 分界不是"数据从哪来"，而是 **"产品侧有没有第二处能独立产生这个值"**：文案由桩给、产品原样渲染 ⇒ 产品侧没有第二处，但它**也不冒充产品文案**，因此不污染"产品文案覆盖"的分母。

**不算 `[mock-self]`（常见误判，别扩大分母扣减）**

- 断言**数据内容**（聊天正文、技能名、资源名、数字计数）由桩提供 —— 那是"给定数据能渲染出来"，属数据渲染验证；
- `expect(value, "说明缺的是什么")` 的**第二个参数是失败消息**，不是期望值，不要拿它当判据；
- 期望值在产品源码里以**字符串拼接/插值**形式存在（如 `实例层继承自` 由「继承自」+ 层名拼出，见 `src/components/settings/ConfigDomainPanel.vue:217/283`）⇒ 它仍受产品文案约束，**不标**。

**复算命令（现算，不靠记忆）**

```powershell
cd H:\zeogit\one\A03-xihe
# ① expected 计数（分母的基数；同一命令顺带打出 collected 供对照，别拿它当分母）
node -e "const s=require('./packages/ui/e2e/.mock-report.json').stats;console.log('expected='+s.expected,'skipped='+s.skipped,'collected='+(s.expected+s.skipped))"

# ② 已标 [mock-self] 的用例数（标题或文件头标记都算；同一用例只写一处）
(Select-String -Path packages/ui/e2e/mock/*.spec.ts -Pattern '\[mock-self\]' -AllMatches).Count

# ③ 分母 = ①的 expected − ② = 328 − 1 = 327
```

**已知存量（`[实测]` 2026-11-12 20:1x，`task-311`）**：`expected=328` / `skipped=20` / `collected=348`；`[mock-self]=1`（`e2e/mock/plan-0714-modal-popover.spec.ts`，页面自洽型：断言 `已选择：层级正确` 由 `src/preview/sections/ModalOverlaySection.vue:12` 产出）⇒ **分母 = 327**。

> 命名与标记纪律：标记写在**用例标题最前面**（`test("[mock-self] …")`）或**文件头**（`// [mock-self] <理由 + 来源 file:line>`）；两种都算，但同一用例只写一处。新增 preview 稿面用例必须当批标注。

## 基线门现状（`scripts/check-mock-baseline.mjs`，`[实测]` 2026-11-12 20:2x）

**当前读数 = exit 2 / `E_STALE_REPORT`：改前 4 条、改后 5 条**（不是"应该不变"）。

| 时点 | 读数原文（首行） | 二级判红条数 | 归因 |
| --- | --- | --- | --- |
| 本次改动**前**（spec 为 HEAD 版本） | `E_STALE_REPORT: 4 spec(s) newer than the report` | 4 | `agent-principals` / `full-ui-acceptance` / `knowledge-base` / `resources-ia`：**提交时间晚于报告 mtime**（`11:51:55Z`/`12:12:01Z` > `08:55:20Z`） |
| 本次改动**后** | `E_STALE_REPORT: 5 spec(s) newer than the report` | 5 | 上述 4 条 + **`plan-0714-modal-popover.spec.ts`：未提交（untracked / dirty / staged）** |

- 门的两级判据（D-1039 ②）：一级 mtime 只标"可疑"（两次都 5 条），**二级定性**才判红（改前 4 / 改后 5）—— 差别就是本卡那个**未提交**的 spec。
- ⇒ **该门当前走不到 counts / skip 标题比对那一层**（staleness 前置就 exit 2），所以"我只改了非 skip 的标题 ⇒ 门读数不变"这句话**不成立**：读数从 4 条变 5 条，原因是脏树，不是计数。
- 门绿的通路只有两条：①把改动提交后重跑全量 `mise run test:mock` 再判；②`--allow-stale-report` 显式接受（须写明理由，别当默认）。
