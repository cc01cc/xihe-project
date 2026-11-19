# UI 包指南

## 定位与技术栈

本包是 Xihe 的 Vue 单页前端，负责 Chat、Workspace、设置与审批等界面。技术版本以 `package.json` 为准（Vue、Vite、Pinia、TypeScript、Vitest、Playwright、vue-tsc、oxlint、Tailwind CSS）。

设计、契约与测试基线：
- [`DEV-010-ui-architecture.md`](../../docs/i18n/zh-Hans/DEV-010-ui-architecture.md)
- [`DEV-011-ui-checklist.md`](../../docs/i18n/zh-Hans/DEV-011-ui-checklist.md)
- [`DEV-020-e2e-test-strategy.md`](../../docs/i18n/zh-Hans/DEV-020-e2e-test-strategy.md)
- [`DEV-021-integration-test-strategy.md`](../../docs/i18n/zh-Hans/DEV-021-integration-test-strategy.md)

## 目录与命令

- `src/features/workspace/`：Workspace 页面、组件、状态与交互；`src/features/workspace/chat/`：Workspace Chat UI、ChatStore、Session 列表与 Chat SSE composables。
- `src/components/`、`src/composables/`、`src/stores/`：跨 feature 共享 UI、composables 与状态；`src/types/`：跨层类型；`src/i18n/`：本地化。
- `src/**/__tests__/`：Vitest 单元测试；`e2e/mock/`：Mock E2E；`e2e/real/`：真实链路 E2E；`e2e/headed/`：真实有头（单窗口串行）；`e2e/page-objects/`、`e2e/helpers/`、`e2e/fixtures/`：共享 Page Object、辅助与固定数据；`e2e/dual-lane/`、`e2e/scripts/`：双车道编排与脚本；`e2e/assets/`、`e2e/evidence/`、`e2e/test-results/`：素材与产物目录（后两者为产物）。
- UI 是 XH 唯一 pnpm 包；`pnpm-workspace.yaml`、pnpm 安全策略和唯一 lock 都归本目录。运行 `pnpm install` 或通过 `mise` UI 任务使用该包根；不要加 `--ignore-workspace`。

Session/ChatRun、Workspace Job、MCP invocation、Agent 可见状态及 UI 交互/设计/无障碍的目标态见 `../../spec/` 对应 proposed SPEC，不能当作已实现事实；UI store 只做本地视图（非权威），不拥有 CP durable lifecycle。

在本目录执行聚焦验证：

```bash
pnpm run test:unit src/features/workspace/chat/__tests__/ChatPanel.spec.ts
pnpm run typecheck
pnpm run typecheck:e2e
pnpm run lint
pnpm run build
```

**e2e 类型门**：`e2e/` 不在 `tsconfig.json` 的 `include` 内（现状只覆盖 `src/**` 与 `vite.config.ts`），所以另立 `pnpm run typecheck:e2e`（`tsconfig.e2e.json` + `scripts/typecheck-e2e.mjs`）：跑 `tsc --noEmit` 后与 `e2e-typecheck-baseline.json` 比对，**只拦新增错误**（存量 **54** 条 / **28** 个「文件 × TS 码」组合（分布在 **20** 个文件）在册 —— `[实测]` 2026-11-20 00:40 按 `e2e-typecheck-baseline.json` 逐条求和（与门脚本比对口径一致），口径 = `e2e-typecheck-baseline.json` 条数之和，来源是 Playwright 1.5x 类型与 DOM lib 的既有冲突，属独立技术债）。**这个数字会随 e2e 文件增删漂移，不是单调递减的债务指标**：58→57 不是修好一条，而是 `e2e/real/goldpath-first-run.spec.ts` 整份被删（`d4ac3f711`，随本地免密模式退役 PLAN-0758/D-787），同批已从基线收账 ⇒ 该场景不再有 E2E 覆盖，这比数字本身更值得注意。基线**只允许缩小**：修好存量后用 `node scripts/typecheck-e2e.mjs --write-baseline` 收账（脚本会打印"已消失条目"）；新增文件不得照搬旧写法，门会红灯。

**改 `src/**` ⇒ `typecheck` 与 lint 同批跑（硬纪律，`task-151`，2026-11-13）**：凡新增或修改 `packages/ui/src/**` 的文件，`pnpm run typecheck` **必须与** `oxfmt`/`oxlint` **同批执行**，不许「先跑 lint、typecheck 等窗口再跑」。理由：**`typecheck` 只覆盖 `src/**`，lint 不查类型** —— 实证 A03 `542217e1`（PLAN-0773 M0-4 预览节）：给 `SectionShell` 传了 `label`，而它要 `title`+`description`（TS2345），**因为窗口 B 段不含新文件，这笔红在窗口里没人会看到**，一直到窗后手工跑 typecheck 才暴露。判据：`pnpm run typecheck` **exit 0** 且在同一批提交前完成；只有 lint 绿**不构成**「类型没问题」。

`pnpm run lint` = `node scripts/lint-gates.mjs`，串 **5 道 gate**：`oxfmt --check .`（格式）、`oxlint .`（lint）、`check-value-namespace.mjs`（value 命名空间）、`check-e2e-time-named-dirs.mjs`（e2e 目录时间命名）、`check-agents-md-budget.mjs`（AGENTS.md 行数/KiB 预算）；单跑某一道用 `pnpm run lint:oxfmt` / `pnpm run lint:oxlint`。**判据：5 道全绿，其中 oxlint 只要求 `0 error`（基线就是 0，不设基线），另 4 道各自 0 命中**；warnings 允许但必须看完整输出（`[实测]` **11808** 条 / oxlint **1.83.0** / **1234** 个文件 —— `pnpm exec oxlint .` 2026-11-13 21:57；**这是基线不是门**（门的判据只有 `0 error`，warnings 不设阈值、不因涨落判红）；该数随文件增删与规则集变化漂移，引用前先现跑一次 —— 模糊的"约 N"永远不会被判过期，故一律写带命令与时刻的实测值）。Oxlint 启用 `typescript`、`import`、`unicorn`、`oxc`；Vitest 插件作用于 `src/**/__tests__/**`、`src/**/*.spec.ts` 和 `src/**/*.test.ts`，并阻断 `require-mock-type-parameters` 与 `require-to-throw-message`，其他 Vitest 规则保持关闭。Vue 插件和 template lint 不属于当前门禁，TypeScript/SFC 类型检查由 `pnpm run typecheck`（`vue-tsc --noEmit`）负责。Vue template lint 为**已知限制**（现状仅 `<script>` 被 lint）：等待 oxlint 原生支持，跟踪 oxc language-plugins umbrella #23207 / Phase-1 #24597 与 [oxc compatibility 页](https://oxc.rs/compatibility.html)；复查触发条件为 oxlint 版本升级或出现真实 template 结构缺陷（`v-for` 缺 key、重复属性等）；裁定见 PLAN-0479 决策 #4。Oxfmt 版本固定为 0.68.0；`.oxfmtrc.jsonc` 显式设置 `tabWidth: 4`、`printWidth: 100`，忽略 Markdown 与 `AGENTS.md`，`proseWrap` 保持未设置以维持原有零漂移行为。全包格式已在 formatter 波次全量应用（419 个历史漂移文件清零），新增/修改文件必须保持已格式化，禁止整包随意 `--write` 后不经 diff 复核入库。

`pnpm run test:unit <spec…>` —— 脚本名后**直接**跟 spec 路径与/或 Vitest 参数（`-t`、`--reporter=dot` 实测透传）。**禁止写 `--`**（`task-25`，2026-11-16 实测 pnpm **10.34.5** / vitest **4.1.11**）：pnpm 把 `--` 原样拼进命令 ⇒ 实际执行 `vitest run "--" <spec>`，而 vitest 收到裸 `--` 会**丢掉过滤条件跑全量**且**零告警**（`timeout 25` 未跑完；25 s 内已跑到 `src/i18n/__tests__/terminology.spec.ts`、`chat/__tests__/ApprovalModal.spec.ts`、`monitor/__tests__/SessionMonitorPanel.spec.ts` 等 **11 个**无关 spec）。单 spec 正确形态实测 **1 file / 5 tests / 2.58 s**；等价写法 `pnpm exec vitest run <spec>`（3.17 s）。完整 `pnpm run test:unit` 与全量 E2E 只在测试波次或里程碑执行；不要把全套验证当作每次小改默认动作。**读旧文档时注意**：`plans/archive/`、`internal/**/evidence/` 里的 `test:unit -- <spec>` 是历史记录（当时确实那样跑），不是可复制的现行用法。

### lint 规则豁免登记 + warnings ratchet（`task-171`，2026-11-15；裁定 `D-1532 ③`）

**为什么有这一节**：用户裁定「直接 `off` 是掩耳盗铃，前面的十余条 style `off` 也不合适 ⇒ 要逐步规范化减少 warning」。`one-var` 的 `off` 本身是对的（规则要求合并声明，`oxfmt` 是一行一声明，修代码等于让代码变差），**错的是一句 `off` 没有登记**。本节 = 全部 `off` 的登记册 + 反「掩耳盗铃」的机器门。

**判据（两条，都能跑）**：

1. **登记条数 == `off` 条数**：在 `packages/ui` 跑 `node scripts/check-lint-rule-registry.mjs` exit 0（不一致会逐条点名「未登记」与「登记已过期」）。**新增 `off` 必须先加登记行**，否则这条门红。
2. **warnings 只许降不许升**：`node scripts/check-lint-warnings.mjs` 打印「warnings N / 基线 B / Δ」；`--enforce` 时超出基线 exit 1 并点名新增了哪些族。**默认 report-only**（接线由 Lead 裁）。基线 `oxlint-warning-baseline.json` 只由 `--write-baseline` 生成/收缩、勿手改；**基线只许变小**，变大必须在卡面写原因。

**收账边界（`task-36`，`D-1685`）—— `--write-baseline` 不许收「别人在途」的新增**：多人并行时基线会把别人还没合入的新警告一并收进来，那批 WIP 从此变成「合法存量」、门不再响（task-261 分批清账期间已反复踩到）。所以收账默认只吸收**自己写面内**的增长：

- `--scope <前缀>`（可重复）声明本次收账的写面，例 `--scope src/components/settings`；**未给 `--scope` ⇒ 任何族增长都算越界**。
- 越界 ⇒ **拒写并 exit 3**，逐条打印「族 / 文件 / file:line」，基线保持原样（可复算：跑前后 `sha256sum oxlint-warning-baseline.json` 不变）。
- `--allow-foreign` 显式放行边界外新增：写盘前先打印 `WARN --allow-foreign 放行 N 处…（留痕）`，并把放行清单写进基线的 `foreignAbsorbed`（**为空则省略该键** ⇒ 「同内容再写一次逐字节不变」这条幂等判据仍成立）。
- 归属单位是 **(族, 文件)**：按每文件计数差找贡献文件；行号漂移不算新增；「族没长但换了文件」（净零）不拦 —— 净零没有放宽 ratchet 的计数，而计数才是门的判据。
- 退出码分层：`0` 正常 / `1` 门红 / `2` 环境问题或 `errors>0` 拒写 / **`3` 收账边界拒绝**。
- 自检：`node scripts/check-lint-warnings.mjs --selftest`（**22 例**，2026-11-19 实测 22/22；含 ⑲–㉒ 区域链点名与 added 不参与判定的红线用例）；改动这两个旗标后必须跑。

<!-- lint-rule-registry 已外置（task-178 B1）：完整登记册（主块 57 / 文件级 5 / 三档 2 / 测试块 72 的表与 fence，含 begin/end 标记）在 [`docs/lint-rule-registry.md`](docs/lint-rule-registry.md)。`check-lint-rule-registry.mjs` 读该文件（B4）；本文件只留分类判据与计数哨兵。新增/恢复 off：改 docs 登记册 + 同步下方计数。 -->

**登记计数哨兵（task-178）**：主块 **57** + 文件级/工具面 **5** + 测试区三档 **2** + 测试块 **72** = **135** 条 `off`。与 docs 登记册不符 ⇒ 以 `check-lint-rule-registry.mjs` 读数为准并回改本行。

- **类 F · 与格式化器轴冲突**：oxfmt 已接管该面（或规则会让代码变差）。恢复条件 = 先做一次性机械重排并单独提交（diff 全审），且用 2 例样本证明 oxfmt 不会反向改写；在此之前恢复只会把千百处风格翻转塞进每条 diff。
- **类 S · 风格取向（仓库与规则方向相反，或规则对互斥）**：恢复条件 = 先定仓库口径并写进本指南（含互斥对处理），再一次性重排。互斥对：no-ternary ↔ unicorn/prefer-ternary、import/no-named-export ↔ import/prefer-default-export、**import/no-namespace ↔ typescript/consistent-type-imports**（type-only 命名空间：前者禁、后者要求；已把前者收窄到值形态，见其登记行）—— 任一侧单独打开都会让存量大面积红，须同时定口径。

**互斥对登记表（4 对，2026-11-19 起）** —— 任一侧单独打开都会让存量大面积红，**必须同时定口径**；
新发现一对先登记到这行表里再动手，别只写在报错/注释里（一天内两次踩同型陷阱：`UP031→UP032`、`no-map-spread→prefer-object-spread`，靠单点实验才发现太贵）。

| 互斥的两族 | 症状（怎么撞） | 正解 | 被否决方案 |
| --- | --- | --- | --- |
| `no-ternary` ↔ `unicorn/prefer-ternary` | 一侧禁用三元、另一侧要求用三元 | 先定仓库口径，再一次性重排 | 单侧打开（存量必大面积红） |
| `import/no-named-export` ↔ `import/prefer-default-export` | 禁具名导出 vs 要默认导出 | 同上 | 同上 |
| `import/no-namespace` ↔ `typescript/consistent-type-imports` | type-only 命名空间：前者禁、后者要求 | 已把前者**收窄到值形态**（见其登记行） | 单侧打开 |
| `oxc/no-map-spread` ↔ `eslint/prefer-object-spread` | map 里浅拷贝元素：前者报 spread 并让你改 `Object.assign`，后者立刻把 `Object.assign` 报回（**同一行**；实测 `0e47e2455`） | **抽成具名函数**，让 spread 不在任何 map 回调体内（本仓 = `src/lib/shallowClone.ts`）——实测两族同时静音 | ① `Object.assign({}, x)`（撞另一族，已实测）② `structuredClone`（深拷，快照/脏值语义会变）③ 两处各写一份本地 helper（重复） |

- **类 Z · 当前 0 命中**：恢复条件 = 直接打开（零存量成本），同批删掉本行即可；打开后若命中非 0，按类 S 处理。
- **类 V · 测试专用块**：只作用于 src/**/__tests__/**、src/**/*.spec.ts、src/**/*.test.ts；该块只阻断 vitest/require-mock-type-parameters 与 vitest/require-to-throw-message 两条（见配置），其余全部不强制。恢复条件 = 开始收敛测试风格时逐条打开（当前全部 0 命中 ⇒ 恢复零成本，同 Z）。
`no-console` 不是"风格偏好"，而是**规则作用域与代码性质不匹配**：CLI/测试/E2E 的 `stdout` 就是它们的输出接口，`no-console` 在那里恒误报。**产品面（`src/**` 非测试非工具）不豁免** —— 那 19 处已按 ③ 逐个改成 `logger.warn`。
规范 SSOT：`one/.agents/skills/test/references/test-lint-area-separation.md`。判据一句话：**这条规则在测试域报的那一条，是不是真的坏**；坏的（`no-shadow`、`no-map-spread`、`prefer-set-has`…）留在**共享档 T-S**，不因「这是测试」变成好事。**「修起来麻烦」不能当关闭理由。**
**产品区不关**（实测 src 有 2 条真命中，`Intl.DateTimeFormat()` 一类，那里语义成立）。另外两条 `T-R` 放宽（`max-params` 测试 8、`unicorn/max-nested-calls` 测试 6）**不是 `off`**，不进本表：它们仍在咬，只是阈值按测试常态拉开（实测默认阈值均为 3，测试侧 76 / 27 条）。

### UI 单测稳定性判据（2026-11-11 实测基线）

- **判据**：同 commit、同机、`CI=1`、串行连跑 **3 轮** —— ①`Test Files`/`Tests` 计数一致 ②`failed` 三轮恒 0 ③`skipped` 恒等 ④`Duration` 极差 ≤5%。四条同时满足才叫"本机稳定"，**一次全绿不算**。
- **基线（`09e71b26` 口径，2026-11-11 三轮实测）**：`206 files / 2080 passed / 3 skipped (2083)`，`Duration 199.96 / 196.92 / 198.30 s`（极差 **3.04 s = 1.54%**，判据 ≤5%）。同机 `CI=1` 串行、独占总线、树 `09e71b26f22` 每轮**起前与止后 HEAD 均相同**且 `dirty=0`。细分（S1）：transform 4.80 · setup 9.54 · import 46.22 · tests 33.30 · environment 87.13 s。
  上版（`b6fb7d9ec`，2026-11-11）为 `205 files / 2076 passed / 3 skipped (2079) / 202.75 s` ⇒ **+1 文件 / +4 用例**（`task-110` 夹具转义守卫 `src/preview/__tests__/mockData.long.spec.ts`）**/ 时长 −4.0 s**。
  上上版（`39a8e929`，2026-11-06）为 `165 files / 1720 passed / 3 skipped / 151–153 s`：四个月 +40 文件 / +356 用例 / +50 s。
  **耗时涨的是 import（+19 s）与 environment（+16 s），不是 tests（33.6 vs 21.7 s）** ⇒ 抱怨「单测变慢」时先看加载与环境开销，不要默认是用例变重。
- **能测出**：顺序性/随机 flake、明显性能回归、"修完只跑一次"的假绿。**测不出**：慢机器/CI（真实 `sleep` 类等待会先崩）、并发与分片 flake（`BL-308` 记过分片敏感）、时区/日期/随机种子边界、跨文件全局状态污染、真实网络/DB（全 mock）。
- **进阶检查**：`--sequence.shuffle`（随机顺序，可配 `--sequence.seed=<n>` 复现）与 `--maxWorkers=1`（单 worker）。2026-11-06 实测：**shuffle 暴露 5 文件 / 8–9 用例的顺序依赖（可复现）**，而 `--maxWorkers=1` 全绿 ⇒ 污染只在多 worker 场景；隔离单跑那 5 个文件也全绿。
- **至少跑 3 个种子**：单种子 `--sequence.shuffle` 通过**不构成**稳定性证据 —— 2026-11-06 实测 `2/3` 通过（一条是已知 1/3 偶发，另一条换种子才照出来的 `Sidebar.spec.ts` 顺序依赖）。判据：**3 个种子全绿**才算 shuffle 干净。
- **经验值 ≠ 推导值**：`SessionMonitorPanel.spec.ts` 的 `sleep(650)`（真墙钟）与 `MessageListVirtual.spec.ts` 的 `for (round < 4) nextTick()`（"够用"的轮数）都是经验值，慢机会崩；改它们前先看文件内注释。

### async 组件替身（`defineAsyncComponent`）约定 —— 假红坑（`task-234`，2026-11-13 `[实测]`）

**先记症状**：替身形状给错时子组件**不会挂**，渲染成空注释节点并打 `[Vue warn]: Component is missing template or render function: { default: … }`。此时业务断言不是在测页面，是在测一个不存在的元素 —— 红得莫名其妙（`Error: Unable to get [data-testid="…"] within:`），也**可能一路绿**。**这条红被误判成页面 bug 已经发生过两次**（`task-210` / `task-231`：去改业务代码，真因是替身），成本是把人引到错误的文件里。

约定（`defineAsyncComponent` 的 loader 返回值）：

1. **必须是模块形状**：`async () => ({ __esModule: true, default: comp })`。只写 `{ default: comp }` 会被 `defineAsyncComponent` 当成「组件本身」—— 它只对 `__esModule` / `Symbol.toStringTag === "Module"` 解包 `.default` ⇒ 空注释节点 + 上面的警告。
2. **组件用 `setup()` + `h()`**：与生产构建一致、不依赖模块解析条件（理由见下条纠正；**不是**因为「否则报 missing template」）。

**可执行判据（先判替身，再判业务）**：spec 里出现 `defineAsyncComponent` 替身时，**必须先**断言目标子组件真的挂上 —— `expect(wrapper.find('[data-testid^="…"]').exists()).toBe(true)`（或 `findComponent(...).exists()`）—— **再**断言业务行为。差别是可读性而非「会不会红」：没有这条时，同一个错误替身会让红落在业务断言上（消息指向"元素找不到"⇒ 你会去查页面）；有这条时红落在替身判据上（`expected false to be true` + Vue 警告原文点名替身形状）。

**自检（正负两侧都钉着，别只跑正例）**：

```bash
node ../../../internal/A03-xihe/evidence/2026-11-13-async-stub-convention/stub-shape-check.mjs
```

四例：正例绿；负例 A（裸对象 + 有存在性判据）红且**红在判据上**；负例 C（同一个错误替身 + 没有判据）红在业务断言上（就是假红的样子）；另一例是被**证伪的假设**（下条）。退出码 0 = 四个都对上，1 = 与预期不符，2 = 环境问题或仓库里残留临时 spec。

**一条纠正（`[实测]` 2026-11-13，本包 `vue` 3.5.44）**：「`vue` 是 runtime-only，所以替身不能写字符串 `template`」这半句**在本包单测里不成立**。Vitest 在 `node` 解析条件下把 `vue` 落到 `node_modules/vue/index.mjs → index.js → dist/vue.cjs.js`，那是**带编译器**的开发构建 ⇒ 字符串 `template` 能正常编译（自检用例里的 `PROBE compile = function` 就是这条读数，`2 passed`）。runtime-only 的是 `package.json` 的 `module` 字段（`dist/vue.runtime.esm-bundler.js`），**那是 Vite 给浏览器打包用的**。⇒ 上面第 2 条保留，但理由是「与生产构建一致、不依赖解析条件」。**同一份 `WorkspaceResourcesView.spec.ts` 注释里的旧说法已由 `task-340` 收口（2026-11-13）**：该文件内关于 `template` 的说法**只剩一条**（= 与生产构建一致、不依赖解析条件），旧说法原文已删而不是并列保留；哨兵 fixture 的路径写在该注释里（解析条件真变了它会红）。

## 跨层与交互规则

- API、SSE 事件、TypeScript types、Pinia store、i18n 四层必须同波次同步；字段以 API/inventory 契约为准，不在 UI 私自重命名或猜测。
- 设置页 Provider 侧（ProviderHub、API 请求模板面板）与 Embedding 面板：层选择与「清除以继承」语义见 DEV-003 §3b；保存必须等真实 PUT 200；模板发布诊断来自 CP validator，UI 不得自动修复原文；embedding 固定模型/768 从 CP `contract` 读取，不硬编码；连接选择器按 `operation=chat` 过滤；连接名称 trim 后 1–40 个 code point 且不得含控制字符（PLAN-0563），DB 列宽仍为 128。连接弹窗不再提供 scope 选择：新建取当前页 scope，编辑沿用连接自身 scope；实例层只给用户/工作区层的跳转入口，工作区层入口指向 `/workspace/:id/settings?tab=config`（PLAN-0560）。
- 工作区设置页：四 tab `config|mcp|skills|general` + 成员一级页 `/workspace/:id/members`；凭据/知识库在资源区（MCP/技能层只给 `WorkspaceLayerMovedNotice` 指路卡）；`PUT /config/workspace/{domain}` 仍 `deprecated`（BL-571）；上下文逐 tab、禁写 localStorage（`workspaceContext` 唯一 SSOT）；历史链见 `settings-m2-migration-matrix.md`。
- 工作区成员**页**（PLAN-0565；task-236 后不再是设置页 tab）：一级页 `/workspace/:id/members`（order 45），`WorkspaceMembersView.vue` 壳 + `WorkspaceMembersPanel` 承载列表/添加（按 username）/改角色/移除（AlertDialog 确认）；设置页成员 tab 已撤，`?tab=members` ⇒ 200 + watch 立即 `router.replace` 到成员页（e2e `toHaveURL` 钉终态）；`canViewMembers` 过滤渲染（裁定 #2 VIEWER 不渲染）；readonly 传 `!canManageWorkspace`（EDITOR 只读）；错误按 `ApiError.problem.code` 映射（裁定 #6 文案等），CP 权威、前端不复制授权逻辑。
- ~~Composer 模型标签（PLAN-0555）三段展示~~ **已废止（2026-11-04 用户裁定：移除 composer 模型选择器）**：`ModelPopover` 与工具栏入口已删除，composer 不再展示模型/连接段（避免"看起来像已绑"的误导，见 C1 `modelDisplay` 契约）；模型绑定改为发送时自动补绑（`bind-defaults`）+ 引导弹窗，`modelDisplay.ts` 仅作为"发送时会用什么"的只读解析器保留。
- 凭据页（PLAN-0553）：连接弹窗只做「输入 key 快速新建凭据」；凭据页「关联到连接」用 `PATCH /provider-connections/{id}` 的 `credentialId` 换绑，展示引用计数与删除 409 提示；不在连接弹窗里选择已有凭据。
- Vue `t()` 消息不得包含 `{...}` placeholder；locale 文本按实际插值参数编写。机器判据：`mise run lint:i18n`（`scripts/i18n-scan.mjs`，只读三查：两侧键差集 / 同键占位漂移 / 源码 `t("…")` 静态引用；通过时零输出）。改 locale 前后都跑它 —— 它抓到过 `chat.*` 写 `workspace.*` 键的裸 key 事故。
- 语言切换（PLAN-0602）：唯一入口 `src/i18n/locale.ts#applyLocale`（同时写 `i18n.global.locale` 与 `<html lang>`），持久化经 `useSettingsStore().setLanguage` 落到 `xihe-language`（VueUse 字符串序列化 = **raw 字符串**，不是 JSON）；启动期由 `main.ts` 的 `initLanguage()` 统一应用。业务代码**禁止**直接写 `i18n.global.locale` 或改 `<html lang>`；新增语言只加 `SUPPORTED_LOCALES` 与两侧资源。
- 新增或修改 UI 合同、焦点/键盘行为、弹窗、流式交互或动画/过渡时必须用真实浏览器验证；组件单测不能替代 Playwright 证据。
- 新 E2E 禁止固定 `sleep`/`waitForTimeout`；使用显式 timeout、readiness、事件或轮询。具体命令与超时策略见 [`command-execution-strategies`](../../../.agents/skills/command-execution-strategies/SKILL.md)。
- E2E 必须覆盖代表性移动 viewport；响应式改动至少检查移动与桌面。截图断言只证明接近 baseline，不能不经 actual/diff 与 DOM/computed-style 复核就更新 snapshot。
- 不得无审查执行 snapshot 更新；必须先做视觉 diff review，并记录为何接受差异。
- 跨模块 API/SSE/持久化改动按 [`xc-cross-cutting-checklist`](../../../.agents/skills/xc-cross-cutting-checklist/SKILL.md) 对齐契约、实现、测试与证据。
- **注意力预算（2026-11-03 用户裁定，配色判定标准）**：视觉权重按注意力的用途分配，不按元素身份。判定新元素该不该上彩色先问三题：多常用 / 多不可逆 / 多难发现 —— **会误操作才值得上色**（例：「新建对话」低频可逆 ⇒ 中性不用品牌色）。层级：L0 表面 / L1 内容 / L2 可操作（中性）/ L3 强调（主 CTA、选中指示、焦点环，**每屏 ≤2**）/ L4 危险（红，**每屏 ≤1**，只在确认时出现）。状态矩阵：hover 只加浅底；**focus 必须环形轮廓且与 hover 可区分**；selected 用左侧 2px 指示条+浅底不整行填色；disabled 保持 ≥3:1；danger 红只染危险元素。判定细则与完整表见 [DEV-011 §10](../../docs/i18n/zh-Hans/DEV-011-ui-checklist.md)。
- **页面高度链不变式（2026-11-03，PLAN-0626 P2 修复）**：`AppLayout` 在有页签栏（桌面 `/workspace/*`）时把 `main` 变 **flex 列**，路由页放入 `min-h-0 flex-1 overflow-y-auto` 容器（`data-testid=workspace-route-viewport`）——**页面拿到的是页签栏以下的剩余高度**。会话列与 `ChatPanel` 必须逐层 `min-h-0`/`flex-1`（`h-full` 会因页签栏多出一整屏 —— 该行为 `h-8` = **32px**（D-1842 后 4px 栅格；旧注释写 36px 名义值、3.5px 栅格下实测 31.5px），任何「按 36/32 记账」的算式都先核实这两条）。此前该链断裂导致**消息视口不限高（`clientH == scrollH`，长会话滚不动）**与 **dock 底部被裁一整条页签栏**两个症状，实证与回归见 `plans/PLAN-0626-XH-workspace-side-tabs/tasks.md`。全局路由（`/settings/*` 等）仍由 `main` 自身滚动，行为不变。
- 布局持久化（PLAN-0582）：键与语义固定 —— 全局 `xihe-layout-global` = `{ navOpen, navWidth }`；每 workspace `xihe-layout-ws:<id>` = `{ treeCollapsed, treeWidth, dockCollapsed, dockWidth, dockTabs, activeDockTab, dockMode, dockFocus, openTabs, activeColumn, openTarget }`（`dockMode` **恒 `"pinned"`**，字段只为解析旧键而留；`dockModeManual` **已删**，见下条）。**折叠态与宽度分开存**（收起不改宽度、展开回原宽）；登出清理 workspace 键。唯一实现入口 `composables/useWorkspaceLayout.ts`（几何常量 `:30-76`、状态接口 `:155-196`、读 `:537` / 写 `:599`），不要另建第二份布局状态。
- ~~dock 两模式（PLAN-0582 §1.5-B）~~ **已退场（`D-1754 ④` 判据 3，用户 2026-11-17 裁定「我们现在没有设计浮窗的」）**：右栏**恒为正常列**（pinned 语义），**不是** absolute overlay。**退场已落地，不是「待退场」**（`task-94` S1/S2/S4 + `task-162`，2026-11-17）。
  - **代码现状**：`DockMode = "pinned"` **单值**（`useWorkspaceLayout.ts:153`）⇒ 任何地方写 `"floating"` **编译失败**，这就是防复活的门闩；`deriveDockMode`（视口 <1800 ⇒ floating）与 `dockModeManual` 字段**已整段删除**；`dockMode` 字段**只为解析旧键而保留** —— 读侧 `isDockMode` 把旧值 `"floating"` **归一为 pinned**，写侧恒落 `"pinned"`。`WorkspaceDockviewDock.vue` 的 `mode` prop 与 `addFloatingGroup` 分支同批删除；locale 里 5 个形态/挤压提示键 + `dockModeManual`/`dockModeAuto` 两个标签键已删（`task-162 ②`）。
  - **「判据 3 被推翻」≠「floating 是 bug」**：浮窗在 PLAN-0582 时代是**有效设计**（1800 断点 + 手选优先 + 非模态），只是用户改判了产品形态。随之作废的历史结论：`D-1276 C1`「浮动态底边让开 composer」、`D-1289`「浮动态不得带 `h-full`」、「只有 floating 允许阴影」、「floating 不是模态」—— **别再当现行约束引用**（pinned 态的 flex 让位语义仍然有效）。
  - **原「三条不变式冲突」的最终解是「640 自己让位」（`D-1829` / 条目 58B，用户 2026-11-18 裁定：主列允许破 640 + 首次破线一次性提示）**：三条不变式里 ① 禁浮窗是用户明确的话、② 不关 dock（A 方案否决 = pinned 静默失效）、③ 640 是 Lead 自定底线 ⇒ 冲突时**用户的话优先**，640 从硬底线降级为**提示线**。落地形态：`computeWorkbenchSqueeze` 不再返回 `forceSingleColumn`（字段物理删除，复活即编译失败），主列 <640 原样返回；`WorkspaceWorkbench` 桌面恒两栏（`containerMode` 只看 `isMobile`），首次破线 `toast.info` 一次（`workspace.mainFloorHint`），标记落 `xihe-main-floor-hint-shown`、登出随 `clearLayoutStorage` 清。单栏只剩移动壳（`isMobile`，`D-1545`）一个入口。
  - **仍适用 / 已成死代码的两半**：pinned 是 flex 子项（主列让位）这条**仍有效**；`InputArea.vue` 仍用 `useElementSize` 发布 `--xh-composer-h`，但**消费方已随浮窗删净**（`var(--xh-composer-h` 全仓 0 命中，2026-11-17 实测）⇒ 该发布现在是**无消费方的死代码**。清它是独立小卡，别在别的卡里顺手删（`InputArea.vue` 不在多数 UI 卡的 write_scopes 里）。
  - **易踩的残留名**：`DOCK_INLINE_MIN_VIEWPORT`（1800）名字还叫 inline，但**唯一消费方已是首启默认**（`defaultWorkspaceLayoutForViewport`：≥1800 首启展开右栏、<1800 首启收起但页签与激活项就位）—— **它不再决定任何形态**。
  - **指针**：`D-1754 ④`（`internal/A03-xihe/docs/lead-decisions-ledger.md:14997`，判据 3 原文在 `:15053`）、落地证据 `internal/A03-xihe/evidence/2026-11-17-task94-dock-tree/README.md` §11（S1/S2/S4）与 §12（task-162）、设计口径 `internal/A03-xihe/docs/workspace-shell-refresh-design.md` §3.4.1（**组级浮窗 ≠ 手写 dockMode，两条轴不可合成一条**）。
- **dockview 已停用但依赖保留（PLAN-0756；用户 2026-11-10 裁定：保留依赖、MVP 不使用）**：`WorkspaceDock.vue` 里 `import WorkspaceDockviewDock` 与 dockview 渲染分支**整段注释**，`dockviewEnabled` 恒 false ⇒ **产品路径只有手写 dock 一条**，`useDockview` prop 与 `globalThis.__xhUseDockview` 注入**当前均无效**。保留未删：`WorkspaceDockviewDock.vue`、`src/lib/dockview.ts`（含单测，仍须绿）、`styles/dockview-theme.css`、`dockview-vue`/`dockview-core` 依赖、`e2e/mock/pl0756-dockview.spec.ts`（已 `test.describe.skip`）。**重新启用三步**（注释块内也写了）：① 取消 import 与模板分支注释；② 接 `import "dockview-vue/dist/styles/dockview.css"`（**BL-564**：产品侧至今未引，翻旗后布局无样式，且须排在 `dockview-theme.css` 之前）；③ 先定 **BL-561** 键盘语义（dock 整体宽度 vs dockview 组边界）。设计史（若恢复仍适用）：两个渲染分支并存、**持久面单一 writer 不变**（`xihe-layout-ws:<id>` 的 `dockTabs`/`activeDockTab`/`dockWidth`/`dockMode`/`activeColumn`/`openTarget`；`dockModeManual` 已删），dockview 序列化只作投影，往返纯函数在 `src/lib/dockview.ts`；三条硬约束：① `DOCKVIEW_OPTIONS.proportionalLayout` **必须 false**；② `theme` 只能传 `dockview-core` 的 `themeLight` **对象**（字符串抛 `TypeError`）；③ **jsdom 不能测 dockview**，集成验证一律 Playwright，单测只覆盖 `lib/dockview.ts`。
- **dockview 复活面（task-369 S1，D-1222/D-1231，2026-11-14）—— 上一条的「注入当前均无效」已过期**：新增 `features/workspace/components/WorkspaceShellDockview.vue`（**一个实例横跨中栏+右栏**，树是可关可重开的面板），`WorkspaceWorkbench` 的 `useDockview` prop 与 `globalThis.__xhUseDockview` 注入面**已复活但默认 false** ⇒ 产品路径仍只有手写 dock 一条。**BL-564 的基础 CSS 已在该壳内引入**（`dockview-vue/dist/styles/dockview.css` 排在 `styles/dockview-theme.css` 之前，宿主加 `.dockview-host` 类让变量映射生效）。**BL-561 已裁（task-326 裁 b）**：sash 键盘契约由 `components/dockSashA11y.ts` 承担（量纲是**相邻两组占比**，不是 dock 像素宽 —— 后者有持久键、前者没有，塞进同一手柄会让 `aria-valuenow` 播错值）；**树宽只在折叠态锁死**（`locked = props.treeCollapsed`），展开态是产品夹取区间 200–320（task-486 S2 拆锁）⇒ 旧文「S1 树宽恒锁死、无可拖分隔条」已过期。**单栏投影已接线（task-162 ③）**：壳收 `containerMode` / `activeColumn` 两 prop，单栏用库自身的 `api.maximizeGroup(panel)`（面板级 `setVisible` 被 dockview 8.9 显式 Omit，不可用）；已知边界 = 树是独立 group，单栏右 active 时投在右栏的树会被一起遮，翻旗时须 Playwright 裁。`WorkspaceDock.vue` 的注释分支与其恒 false 的 `dockviewEnabled` **未动**（那是另一条路径）。模型判据与浏览器读数见 `e2e/mock/task369-container-callable.spec.ts`（7 条，单 spec = L0）；翻默认仍需浏览器全套（L2）。
- 三处栏宽（PLAN-0582 §1.5-A）：导航面板 **220–360**（默认 280）、文件树 **200–320**（默认 240、收起 40）、dock **320–480**（默认 360）——一律引用 `useWorkspaceLayout.ts` 常量（`:49-76`），不写字面量。分隔条统一：`role="separator"` + `aria-valuenow/min/max`、方向键 ±16（`*_KEYBOARD_STEP`）、`Home`/`End` 到边界、**双击复位默认宽**、拖拽时显示实时宽度浮标。窄屏夹取（`clampNavWidthForViewport`：<1280 → 240、<1440 → 260、否则 360）**只影响渲染，不得写回**用户原值。防挤压按 spec §1.5-C，**`D-1829` 后的现行模型**（`computeWorkbenchSqueeze`，`useWorkspaceLayout.ts` 文件尾）：右栏开着且主列 <**720**（`MAIN_COMFORT_MIN_WIDTH`）让**导航面板**让位 → 仍 <640 且导航尚未让过则再让一次 → **让尽仍 <640 ⇒ 主列就破 640 两栏同行**（不再切单栏），首次破线一次性提示（见上条）。**树不再进这个模型**（它是右栏的一个页签，宽度含在 `dockWidth` 里）⇒ 「先让树」那一档已不存在；**出口不是浮窗、不关 dock、也不切单栏**。移动端抽屉开态宽度走 `mobileDrawerWidth`（`D-1828` 条目 57B：永不负宽、永不窄于 `MOBILE_DRAWER_MIN_WIDTH` 且不出视口 —— 移动态会话行必须容得下截断标题）。
- 工作区选择面（PLAN-0608 C′）：`/workspace` 在**无 tab 上下文**时渲染 `components/WorkspacePicker.vue`（角色取 `GET /workspaces` 权威值）；`WorkspaceView` 收到 `400 WORKSPACE_CONTEXT_CONFLICT` / `409 WORKSPACE_CONTEXT_REQUIRED` 时**回选择面**，不得只弹 toast 成死路。**I6：登录响应里的 workspace 只是 fallback**，绝不写进 tab 上下文——`stores/auth.ts` 的 `hydrateWorkspace` 不再用 `/workspaces/current` 回填（与上文「工作区上下文逐 tab 存取、`workspaceContext` 为唯一 SSOT」同源）；新建会话走路径形式 `POST /api/v1/workspaces/{workspaceId}/sessions`。
  - ~~**I6 例外（2026-11-01 裁定，BL-169）**~~ **已随 PLAN-0758（D-787）移除**：本地模式免密自动登录分支删除后，I6 无例外——登录响应消费方一律不得回填 tab 上下文。

### 错误面：错误码 → 文案（`task-45`，2026-11-16）

**唯一入口**：`src/lib/errorMessages.ts#presentCauseError(t, cause, fallback)` —— 返回 `{ copy, code, technicalDetail }`。新增或修改任何错误面**不得**手拼 `` `${code}: ${detail}` ``，也**不得**把 `ApiError.message` 当文案用（它就是 CP `detail`：可能是英文，或客户端兜底的 `API error 500`）—— 那正是 `AUDIT_ERROR: API error 500` 的来路。DEV-011「不得直显 CP 英文 detail」在代码侧就靠这一条收紧。

**两种面两种处置**（不要一律塞折叠控件；**只有两档，别再开第三档形态** —— Lead 2026-11-19 裁 ②，总账 §十四 `fc327a318`）：

| 面 | 怎么判 | 处置 |
| --- | --- | --- |
| **诊断面** | **持久在屏**的错误条：设置/配置页（数据控制、工具面、变更面板、文件树、定时任务）**与弹窗内的持久错误条都在这一档**。弹窗内那条要同时满足三件才算诊断面：① 持久在屏（不是自动消失的 toast）② 给出下一步动作 ③ 错误码是用户能报给管理员的**报障凭据**（`task-61` 提出，Lead 裁：三件缺一就走瞬时面） | 渲染 `copy`；**`code` 与 `technicalDetail` 一起收进同一个 vendor `Collapsible`**（**默认折叠**；两者都空时 `v-if` 不渲染空壳）。**码不许删、只挪进折叠区**（区内 `错误码：{code}` + 原文）—— DEV-011 §14.5 只豁免**折叠**内容，**常在屏的码不在豁免内** |
| **瞬时面** | toast、**弹窗内的瞬时提示**、聊天气泡（ChatPanel / SessionList / ApprovalModal / SSE 错误帧）—— 弹窗内**持久**错误条归上一档，**不在此列** | 只渲染 `copy`；原文交给同处 `logger.warn/error` 的 cause **留痕** |

**「可复制」的语义随裁 ② 变了，文案必须跟着变**：码进折叠区后，「可见可复制」只在**展开后**成立 ⇒ 凡文案要求用户「提供 / 报出错误码」，同一句就必须给出**动作**（展开「技术详情」）。实做：`errors.unknownCode` 中英两侧同批改成「请展开「技术详情」，把其中的错误码报给管理员」—— 改前那句要求用户出示一个界面藏起来的东西，正是 `task-67` 记过的形态。
实证（`task-58` 一手）：门在真栈判红过一次格子 `session` 的「权限原子/枚举常量」形态，样例就是常在屏的 `CHECKPOINT_UNAVAILABLE` —— 那不是 HMR 噪音，是**两把尺子在同一面上打架**；裁 ② 后该面已收敛（码进折叠区）。

**断言判据**：新错误面的单测三件事齐判 —— 可读文案在 + 不含错误码 + 不含 `API error \d+`。改既有断言同理：把「记录缺陷」的 `toContain("CODE")` 换成这一套，**不许只删不加**（删掉正向判据就是放宽）。 **挪码进折叠区时还要加第四件**：折叠态码节点**未渲染**（不是 `display:none`）、展开后出现并含码 —— 这是「不删只挪」的机器判据，缺它下一个人就会把「既然不进正文」读成「那就删掉这行」（`task-61` 实测形态）。

### Reka UI 交互陷阱

- `ComboboxContent position="popper"` 的触发器必须由 `ComboboxAnchor` 包裹，否则内容可能定位到视口外且没有报错。
- `CollapsibleTrigger` 已自带切换行为，不得再绑定一次 click，否则会双重翻转。
- `AlertDialogAction` 点击后**无条件关闭**（它是 reka-ui `DialogClose` 的包装）；需要"校验失败保窗"或"确认后要执行副作用"时都别用它，改用普通 destructive `Button` + 显式控制关闭顺序。**机制（顺序不能记反）**：点击 → 关闭先同步触发 `@update:open` → 我们把"待确认 payload"清空 → 我们自己的 click handler 才跑、读到 `null` ⇒ 表现为"**点了确认但一个请求都没发**"（`task-312` 实测）。**症状**：确认框文案断言**全过**、请求计数 **0**（`expected "vi.fn()" to be called 1 times, but got 0 times`）—— 这条红最容易被误判成"mock 没接上"，于是有人去改 mock、越改越远；**排查方向**：先在 click handler 里打印它收到的 payload，是 `null` 就是本陷阱。实测改法见 `src/components/settings/PersonalSkillCreateDialog.vue`（先取 payload → 再关 → 再提交）。
- MenuItem 的程序化选择不由 jsdom 覆盖；交互行为用 Playwright 验证。

## UI 预览（mock）工作流（2026-11-03 用户裁定）

- **禁止手写静态 HTML 预览稿**。所有 UI 预览、评审稿、宣传配图稿必须用**真组件 + mock 数据**渲染——手写 HTML 只仿外形，组件、图标、间距与真实不一致，已造成一次返工。
- 载体优先 `preview.html` + `src/preview/main.ts`（Vite 多入口，独立 `createApp`，**不进产品路由**）；退路 `/__ui-preview` 路由且必须用 `import.meta.env.DEV` 守卫，生产不可达。
- 图标用 `@lucide/vue`；样式只用产品 token 与 `components/ui/*`；**不新增色阶、不引入第二套设计语言**。
- 全部 mock（本地对象/ref），**不调任何 `/api/v1/**`**；每个区块在 **1920×1080**（最小）下单屏可截图、不跨屏截断；1440×900 只作为"窄屏不塌"的附加检查，不作为交付尺寸。
- 覆盖面为常态维护项：工作台主面板（含 **TO / CC**）、智能体面板、记忆面板、配置页（ProviderHub + API 请求模板）、凭据与角色页、审批卡与工具调用卡、空/加载/错误/无权限四态。
- 「页面上点了保存没反应」这类问题，真栈 E2E 才能发现；预览页只解决"看"，不替代 E2E 证据。
- **截图执行器**：`packages/ui/scripts/ui-mock-shot.mjs` —— 交付图的唯一拍法（自起自关 dev server，或 `--url` 复用已起的；连拍两次比 sha，抖动即非 0 退出；输出目录取 `--out`，默认 `../../.tmp/xh/ui-mock-shot`）。**禁止手拍交付图**：手拍的 PNG 无法用「commit sha + 一条命令」重建。
  - **探活（task-84 修好，2026-11-11 实测自起自关可用）**：两条路径都先探活，候选列表**并行**打 —— vite 自己打印的 `Local:` host → `127.0.0.1` → `localhost` → `[::1]`，**每个请求各自 2 s 上限**，所以一个挂住的请求吃不掉整个预算（旧版没有单次超时：一次挂住 = 循环再也检查不到 deadline，最后报「120 s 没就绪」，与根因脱钩）。探不通时 exit 2 并打印**每个 URL 的尝试次数 / 最后一次耗时 / 错误码** + 一层 TCP 直连诊断（区分「没人听」与「听了但 HTTP 不应答」）+ vite 输出尾部；`--url` 复用模式在 TCP 也连不上时**约 1 s 快速失败**（2026-11-11 实测 1 s / exit 2，旧版是 120 s 黑盒等待）。manifest 新增 `server: { mode: "spawned"|"reused", base, readyVia }` —— 图是自起拍的还是复用拍的，事后可从 manifest 读。自检：`node packages/ui/scripts/ui-mock-shot.mjs --selftest`（不开浏览器、不起 server，实测 10 项 ~0.6 s）。**浏览器指纹（task-92，2026-11-11）**：manifest 新增 `browser: { channel, version, chromiumArgs }`，控制台也打一行 `浏览器: <channel> <version> args=…` —— 换浏览器整张图就会变（实测 `--channel chrome`/`msedge` 让 04 主图从 `0525a43b` 变成 `8901dbee`），而在此之前产物里没有任何字段能说明这件事，只能靠"主图 sha 只被某个 channel 复现"反推 —— **靠反推才能知道的事实等于没有记录**。`--chromium-arg` 可重复传、原样进 `chromium.launch` 的 `args`（例：`--chromium-arg=--disable-gpu` 强制软件合成），用于把"同一 commit 两批图不一样"的变量逐个关掉。
    > **版本注记（task-84，2026-11-11）**：本行只对**本分支**成立 —— 自 `39f52a530`（`task/34-mock-gates`）起才有 `--selftest` 与并行探活；`develop`（截至 `f13178d2a`）的 `ui-mock-shot.mjs` **没有**这两个能力，自起自关仍会 120 s 超时、manifest 也没有 `server` 字段。该提交并入 develop 后请把本行改成「已随合并在 develop 生效」或直接删掉。
  - **脏树交付的判据是「证明」而不是「树干净」**（2026-11-11 改，取代旧口径「交付图不得带 `allowDirty: true`」）：脏树仍然默认拒拍（`git status --porcelain` 非空即 exit 1），但可用 `--allow-dirty --dirty-proof <json>` 出交付批次 —— **每个**脏路径必须给一条**可复算命令**，脚本亲自跑它、把 `command` / `exit` / 实际 `output` 一起写进 `manifest.dirtyNonRendering`，缺一条就 exit 1 点名缺哪条；证明里写 `expect: "empty"` 时「命令有输出」直接报错。旧口径废止的理由：它把手段（干净树）当目的，结果是任何队友的未提交 WIP 都能永久卡死交付，而唯一出路（动别人的文件）恰是我们明令禁止的 —— **一条会把人逼去做被禁止之事的门是负价值门**。 证明文件本身通常不进 git（放在 `.tmp`/`one/.tmp` 下），所以 manifest 只能钉住它的 `sha256_16`（`dirtyProof`）：**那个 `path` 只是当时的位置，丢了证明文件就无法复算**，要留证据就把证明 JSON 一起归档到证据包。

  - **批次比对判据（2026-11-11 裁定，取代「7/7 逐字节相同才对」）**：旧判据隐含「截图是纯确定性的」这个假设，而滚动帧的抗锯齿覆盖率取整会受合成路径影响 ⇒ **判据会假红**；一条会假红的判据会被绕过，且绕过它的人是对的（与「dirty 必须为空」同病：把手段当目的）。现行判据：**通过 = 逐字节相同 ≥6/7，且差异张必须给出「坐标清单 + 每点通道与 Δ + 差异像素占全图比例 + 该位置是否落在文本字形/布局/位移上」**；差异落在内容（字形/布局/位移/颜色语义）⇒ 不通过；只落在抗锯齿覆盖率最低位（每通道 ≤1 LSB）⇒ 通过，但必须记为「**合成级差异**」。实证（task-72 第 3 腿）：6/7 逐字节相同，第 7 张 4 个像素各差 1 LSB 且只在蓝通道、占比 1.9e-6、位置是左栏搜索框 `rounded-full` 圆角 AA ⇒ 判通过（合成级差异）。**注意**：判"通过"与"机制已查明"是两件事 —— 前者靠四条互相独立的排除证据（内容/浏览器构建/服务路径/树内 WIP 各自堵死一条替代解释），后者才需要合成假设被验证。


## UI 交付前自审（截图五维，2026-11-11 用户裁定 D-926）

> 用户原话：UI 开发完成后先截图自审 ——「各个按钮的布局 以及是否有意义；字体，图标，整体交互以及静态元素」。
> 交付前（合入前）必须过这一遍；可 Lead 自审或派独立审阅卡，但**图与人眼判据都要留证**。

**五维↔六维映射（D-929 后两套口径并存，审阅时先声明用哪套）**：按钮布局→B 一致性+F 布局；按钮有意义→A 反馈与可用性；字体→C 层级与排版；图标→B 一致性+D 无障碍；交互与静态元素→E 内容与真实性+A。六维判据全文见 one 根池 `ui-review` skill，通用流程以它为准。

**五维判据（每条都要落到具体图 + 具体位置）**

| 维 | 要看什么 | 典型问题 |
| --- | --- | --- |
| 按钮布局 | 同组按钮对齐、主次分明（primary/secondary/destructive 不混）、间距一致、不出现孤立按钮 | 一排 5 个等权按钮、保存与删除同色、按钮贴边/换行 |
| 按钮有意义 | 每个按钮点下去都有可观察结果；不能存在「点了没反应」「该禁用却能点」「语义重复的第二个入口」 | 禁用态缺失、同一动作两个按钮（rail 有入口 + 页内又有返回链接） |
| 字体 | 字阶连续（标题/正文/辅助三级以上差异可见）、行高不拥挤、数字/代码用等宽、无中英混排错位 | 四级标题同样大小、长值撑破行宽、CJK 与拉丁基线跳动 |
| 图标 | 同一语义同一图标（lucide 集内）、尺寸一致（12/16/20 档）、有 `aria-label`/`title`、不用纯 emoji 替代 | 同一功能两处不同图标、图标比文字大 |
| 交互与静态元素 | 空态/加载/错误态都有文案与出口；徽标与计数与数据一致；分隔/描边/圆角同档；无「本域 N 项配置」但无字段这类矛盾 | 计数与可见项不符、空态无出口、徽标是推导线但看起来像事实 |

> **两条读数注脚（`task-218` / `task-233`，2026-11-13）—— 都是「名义值 vs 实渲染」的坑，判据必须能第二人复算**
>
> **① 双轴：rem 轴 ≠ spacing 轴 —— 别把「3.5 单位」当成 14 px**
> - **rem 轴**（字号/行高，基数 16 px）：`--text-sm` = `0.875rem` = **14 px**、`--text-sm--line-height` = Tailwind 默认 `calc(1.25 / 0.875)` ⇒ **20 px**；这条轴与 `--spacing` 无关。
> - **spacing 轴**（`p-*` / `gap-*` / `size-*` / `m*-*`，基数 `--spacing` = Tailwind 默认 **`0.25rem` = 4 px**，`main.css` 的 `:root` **不再覆盖**它，D-1842 起）：`p-2`/`gap-2` ⇒ **8**、`size-4` ⇒ **16**、`h-8` ⇒ **32**、`ml-3.5` ⇒ 3.5 × 4 = **14**。
> - 所以本表「图标 12/16/20 档」是**名义档**：实渲染走 spacing 轴乘积（`size-4` ⇒ **16 px**），名义 16 档自 D-1842 起**可达**（此前 3.5px 栅格下是 14，交付差 0.875 倍）。
> - **动机（`task-224` 的真实反例）**：`GlobalRail.vue` 旧注释写过「3.5 × 3.5 = 14px」，并把「logo 与居中位逐像素相同」当事实 —— 实测 **12.25**（差 1.75 px），由 `ede53f115` 改成固定左内距修掉。**注释里的算式同样是读数，也得能被复算**；D-1842 后同一类名 `ml-3.5` 的读数是 **14px**（3.5 单位 × 4），值变了、类名与判据都没变。
> - **判据（可跑）**：`node internal/A03-xihe/evidence/2026-11-13-rail-metrics/rail-metrics.mjs <输出目录>`（`channel: chrome-beta` / 1920×1080 / dpr 1），读 `rail-metrics.json`：`rows[*].box.h` = **`h-8` = 8 × `--spacing` = 32**（D-1842 前 `task-287` 曾用 `h-9` = 31.5，已撤回）、行内 `svg` 盒 = **4 × `--spacing` = 16**、`fontSize` = **14px**（rem 轴，与 `--spacing` 无关）。**拿「3.5px 时代的 31.5 / 14」去对图即判为假缺陷**（过期读数当现值）。
>
> **② rail footer 动作组与框架控件组的间距 = 17 px = `gap-2`×2 + `h-px`（有规则出处，不许再被当魔数改掉）**
> - `SidebarFooter` 是 vendor 的 `gap-2 p-2 flex flex-col` ⇒ 子项间距 = **`gap-2` = 2 × `--spacing` = 8 px**；`task-214`（用户 2026-11-13 裁定）在「动作组（设置 / 退出登录）」与「框架控件（收起）」之间插了 vendored `SidebarSeparator`（`Separator` 的 `h-px`）⇒ 组间 = 8 + **1** + 8 = **17 px**，末行 centerY 相对上一行 = **导航行高 + 17**。
> - **判据（两态各一组，±0 px）—— 钉公式，不钉派生数**：`footer` 末行 centerY − 上一行 centerY = **导航行高 + (2 × `gap-2` + 1)**，其中 `gap-2` = 2 × `--spacing`。
>   - 展开态：行高 = `h-8` = 32 ⇒ **49**（D-1842 口径，类名已从 `h-9` 撤回 `h-8`）
>   - 折叠态：行高 = `size-8` = 32 ⇒ 同样 **49** —— **两态差已随 D-1842 消失**（见图下注）
>   - **为什么写公式**：49 是派生数（行高 + 17）。行高变了而 49 留在文档里 ⇒ 静默过期，改它的上游的人必须回来考古。写成公式后行高再变也不会错 —— 与 `D-1137`「一致性断言必须锚独立基准」是同一形态：**别钉结果，钉算法**。
>   - 同批钉子（这两个是**独立基准**，不随行高变）：`[data-sidebar="separator"]` 的 rect `h` = **1**，其上下 `gap` = **`gap-2` = 8 px**（D-1842 前为 7）。跑法 = `rail-metrics.mjs` 同口径，取数时刻写进报告。
> - **两态差已消失（D-1842，2026-11-16 根治）**：此前展开态 `h-9` = 9 × 3.5 = **31.5**、折叠态 vendor `size-8!` = 8 × 3.5 = **28**，差 3.5 被记为「有意」。`task-287` 的补偿（`h-8` → `h-9` + `py-1.5`）已在 D-1842 撤回：**`--spacing` 回 4px 后展开态 `h-8` = 32、折叠态 `size-8!` = 32，两态同高**，补偿因此不再需要。判据仍是「这一态里有没有需要行高承载的文字」（折叠态 6 行可见文字全为空、`span` 被 `group-data-[collapsible=icon]:hidden`），但现在**不靠判据豁免也一致** —— 若有人再加 `h-9` 恢复「两态差」，那是把已根治的问题改回来。证据：`internal/A03-xihe/evidence/2026-11-13-rail-metrics/README.md` §「已知两态差」（其中 31.5/28 是 3.5px 栅格时代读数）。
> - **四条「看起来像微调」的非法改法**（要改组间距只有这四条路，全部不合法）：① `gap-2` 改 6/10 px 之类的任意值；② 去掉 separator 只留间距（回到动作项与框架控件混排，`task-214` 裁定不许）；③ **重新覆盖 `--spacing`**（D-1842 已把全站栅格根治回 4px，再覆盖 = 回到 12.5% 缩小 + 全站补偿；见 `main.css` 的 `:root` 注释）；④ **把 `SidebarSeparator` 换成 `my-[8px]` / `mt-[…]` 任意值 class** —— 这条最隐蔽：它把 token 换成魔数，却看起来像「微调间距」。出现任一条即判回归。

**做法**（钉在 commit 上，别用脏树）

```text
1. node packages/ui/scripts/ui-mock-shot.mjs --url http://127.0.0.1:5199   # 已起的 mock 实例；不许新起 server 抢端口
2. 逐页看五维，每个问题写「页码 + 坐标/元素 + 现象 + 判据」，不写“感觉不好看”
3. 问题分三档：P0 阻断（点不动/数据矛盾）/ P1 明显（布局或语义错）/ P2 打磨（字阶/间距）
4. P0/P1 一律转卡，不许口头放过；P2 攒批
```
## Session / Agent Principal

- 新建 Session 必须显式携带已绑定 Agent 的 `agentPrincipalId`（`POST /api/v1/sessions`）；principal-null 空 Session **不再**在首次发送前于 UI 选择 principal——会话身份绑定在创建时确定（PLAN-0689 B3 删除 F6 占位路径）。
- Workspace Agent 管理面板读写 `/api/v1/workspaces/{id}/agents`，principal 创建走 `/api/v1/agent-principals`；创建与绑定分别授权（`CREATE_ACCOUNT` / `MANAGE_WORKSPACE_AGENTS`）。契约见根级 `spec/agent/principal-workspace-binding.md`。

## 权限边界

允许修改本包源码、测试与本包构建配置；新增依赖、破坏式 API、跨包协议变更和生产部署须先获批准。不得把 Mock E2E 当作真实链路完成证据，不得提交本地截图工件或凭据。

测试策略见 [`test`](../../../.agents/skills/test/SKILL.md) 与 [`playwright`](../../../.agents/skills/playwright/SKILL.md)；跨层契约同步见上方 checklist。

父级指南：[`A03-xihe/AGENTS.md`](../../AGENTS.md)。

- 配置页来源展示（PLAN-0554）：使用 GET /config/{domain}/meta，只读展示 source/继承/env 锁定；不出现锁定开关；Provider 连接的新建只在 User/Workspace 层。
- 管理员锁定（PLAN-0556）：锁定页是独立 ADMIN 路由 `/settings/config-locks`，导航项仅 ADMIN 可见，非 ADMIN 直链渲染 403 视图；普通配置页只显示「由管理员锁定」徽标与原因并禁用控件，不提供锁定/解锁入口；env 锁定与管理员锁定必须用不同徽标与文案。
- 设置信息架构（PLAN-0752）：层只由路由 `meta.settingsLayer` 定；域宇宙/矩阵以 `settingsIa.ts` 唯一 SSOT（`INSTANCE_DOMAINS` **12 域**≠矩阵格数）。组页=`SETTINGS_GROUPS` 注册表（组 id≠域 id）。后端缺口=**标缺口的按钮**；权限两面不混用：`no-atom`（照常取数）vs `atom-denied`（403 卡、不挂载）。工作区层入口=tab（计数写死 **4**）；依据 `settings-m2-migration-matrix.md` §8.2。
- 管理员 Principal 授权（PLAN-0585）：`/settings/principal-grants` 是独立 ADMIN 路由（nav 仅 ADMIN 可见，非 ADMIN 直链渲染 403 视图）；按 **username 精确匹配**（不折叠大小写）寻址，只写目标账号的 `source='direct'` 授权行；`CREATE_ACCOUNT` 的 resource 固定 `*`，`MANAGE_WORKSPACE_AGENTS` 必须填具体 workspace UUID（禁 `*`，UI 负责格式校验与去重）；保存走 PATCH 差集，按回显 `changed:true|false` 展示（false = 幂等重放、无新审计）；错误按 `ApiError.problem.code` 映射本地化文案，**不得直显 CP 英文 detail**；无权限的 Agent 创建/绑定入口必须给出指向本页的可操作提示（F-02）。


