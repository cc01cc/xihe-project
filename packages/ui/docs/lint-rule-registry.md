# lint 规则豁免登记册（packages/ui）

> task-178 B1 外置：本文件是 `packages/ui/AGENTS.md`「lint 规则豁免登记」节的**登记册**（三张表 + 测试块 fence，含 `lint-rule-registry:begin/end` 标记）。
> 机器门 `node scripts/check-lint-rule-registry.mjs` 读本文件标记区间（B4）；**分类判据（类 F/S/Z/V）与收账边界的权威表述在 AGENTS.md 该节**，不在此重复。
> 新增/恢复 `off` 规则：在下方对应表加/删行，并同步 AGENTS.md 的计数哨兵。

<!-- lint-rule-registry:begin -->

**当前登记 134 条`off`** = 主块 56 + 文件级/工具面 5 + 测试区放宽/关闭档 2（`task-43` 的 `new-cap` 两片）+ 测试块 72（71 vitest + `no-console`）。「实测命中」= 把该规则**临时置 warn** 后一次全包 lint 的条数（oxlint 1.83.x / 1353 文件 / 2026-11-15；跑法：生成临时配置 + `pnpm exec oxlint . -c <tmp> -f json`）—— 它是「恢复这条规则要付多少成本」的读数，**不是**「该不该恢复」的裁定。

#### 主块 56 条

| 规则 | 实测命中 | 为什么 off（依据） | 类 |
| --- | ---: | --- | --- |
| `no-underscore-dangle` | 114 | 允许 __esModule、_internal* 这类约定前缀 | S |
| `no-useless-constructor` | 1 | 1 处是有意保留的空构造（子类占位） | Z |
| `sort-keys` | 8996 | 键序按语义分组（id → 必填 → 可选）；oxfmt 不排序键 ⇒ 规则只带来 8996 处重排 | F |
| `sort-imports` | 2998 | 导入按语义分组（vue → 第三方 → 内部 → 相对），字母序会打散分组 | F |
| `func-style` | 4227 | function 与箭头混用是常态（4217 处），无统一取向 | S |
| `no-ternary` | 2283 | 三元用于内联表达式与模板；与 unicorn/prefer-ternary 互为反向 ⇒ 两者都不强制 | S |
| `no-magic-numbers` | 9995 | 数值字面量在颜色/尺寸/超时里就是语义（9995 处），命名常量表尚未建立 | S |
| `no-nested-ternary` | 101 | 同上（101 处），且与 unicorn/no-nested-ternary 重复 | S |
| `arrow-body-style` | 11 | 与 oxfmt 输出一致（单表达式直接返回） | F |
| `capitalized-comments` | 3450 | 中文注释没有大小写概念（3450 处） | S |
| `curly` | 3135 | 单行 if (x) return; 是主流写法（3135 处），强制花括号要整仓重排 | F |
| `id-length` | 1365 | i/j/el/x 等短名在循环与数学表达里是惯用法（1365 处） | S |
| `init-declarations` | 195 | 允许 let x; 先声明后赋值（195 处） | S |
| `max-statements` | 1657 | 函数长度由 review 把关，不做机械化条数上限（1657 处） | S |
| `no-await-in-loop` | 585 | 串行 await 常是语义要求（顺序依赖、限流），并行化会改行为（585 处） | S |
| `no-continue` | 131 | guard-clause 循环里 continue 比嵌套更清楚（131 处） | S |
| `no-implicit-coercion` | 33 | !!x / +x 惯用（33 处） | S |
| `one-var` | 12448 | 与 oxfmt 方向相反：本仓一行一声明（printWidth 100 产物），规则要求合并声明（12448 处）；裁定 D-1532 ③ | F |
| `prefer-destructuring` | 281 | 解构与否按可读性取舍（281 处） | S |
| `prefer-exponentiation-operator` | 0 | 当前 0 命中 ⇒ 保留 off 无成本 | Z |
| `prefer-named-capture-group` | 238 | 手写解析正则用具名捕获组会加噪音（238 处） | S |
| `prefer-template` | 524 | + 拼接多用于空值兜底（524 处），模板字符串不总是更清楚 | S |
| `import/no-unassigned-import` | 10 | 需要副作用导入（样式、polyfill；10 处） | S |
| `import/no-named-export` | 1791 | 仓库约定具名导出；本规则要求默认导出，方向相反（1791 处） | S |
| `import/prefer-default-export` | 52 | 同上相反（52 处）⇒ 两者都不强制 | S |
| `import/no-named-as-default-member` | 0 | 当前 0 命中 | Z |
| `import/consistent-type-specifier-style` | 547 | type 说明符 inline/exports 两种风格混用（547 处） | S |
| `import/exports-last` | 638 | 导出靠近定义，不强制堆到文件末尾（638 处） | S |
| `import/group-exports` | 1425 | 同上（1425 处） | S |
| `no-duplicate-imports` | 159 | 同一意图已由 import/no-duplicates: error 把守（159 处为合并同源 import 的误报） | S |
| `import/no-nodejs-modules` | 406 | e2e/** 与 scripts/** 必须用 Node 内置模块（406 处） | S |
| `import/no-namespace` | 59 | **判据过宽 ⇒ 由更窄的检查器接管它真正该管的那一半**（不是弃用 oxlint）：该规则对 `import type * as` 照样报，而 type-only 命名空间在运行时被完全擦除、不产生任何命名空间对象 ⇒ 其立法目的（运行时对象 / 阻碍 tree-shaking）对它不适用；实测 59 条命中里 **57 条是 type-only**、值形态仅 2 条。规则唯一选项 `ignore` 是模块 glob，`allowTypeOnly` 被配置解析拒绝（oxlint 1.83.0 实测，上游 `NoNamespaceConfig` 亦只有 `ignore`）⇒ 无法按形态豁免。改由 `scripts/check-value-namespace.mjs` **只报值命名空间**（做的事比原规则少），已并列接进 `pnpm run lint`。恢复条件 = 上游能按形态豁免时，删本行与该检查器并把规则打开 | S |
| `unicorn/filename-case` | 895 | 文件名按 Vue/TS 惯例混用（组件 PascalCase、composable camel，895 处） | S |
| `unicorn/no-null` | 3315 | wire 契约用 null；强制 undefined 会与 API 语义冲突（3315 处） | S |
| `unicorn/prefer-global-this` | 216 | 浏览器/Node/测试三环境差异（216 处） | S |
| `unicorn/no-nested-ternary` | 94 | 与 eslint/no-nested-ternary 同义重复 | S |
| `unicorn/catch-error-name` | 302 | err/e 是惯用名（302 处） | S |
| `unicorn/consistent-existence-index-check` | 45 | indexOf(...) !== -1 与 includes 混用（45 处） | S |
| `unicorn/no-await-expression-member` | 180 | (await x).y 可读（180 处） | S |
| `unicorn/no-zero-fractions` | 15 | 1.0 等写法在数值常量里有意义（15 处） | S |
| `unicorn/numeric-separators-style` | 311 | 长数字分组风格未统一（311 处） | S |
| `unicorn/prefer-array-find` | 12 | filter(...)[0] 与 find 混用（12 处） | S |
| `unicorn/prefer-optional-catch-binding` | 0 | 当前 0 命中 | Z |
| `unicorn/prefer-response-static-json` | 50 | Response.json 与手写 new Response(JSON.stringify(...)) 混用（50 处） | S |
| `unicorn/prefer-spread` | 68 | concat/apply 与展开混用（68 处） | S |
| `unicorn/prefer-ternary` | 12 | 与 eslint/no-ternary 相反 ⇒ 两者都不强制 | S |
| `unicorn/switch-case-braces` | 201 | case 里是否加块按需要（201 处） | S |
| `unicorn/consistent-function-scoping` | 231 | 内部函数就地定义便于读（231 处） | S |
| `unicorn/no-array-sort` | 84 | 就地 sort() 在局部副本上安全且更直接（84 处） | S |
| `unicorn/no-useless-fallback-in-spread` | 8 | ...(x ?? []) 防御写法（8 处） | S |
| `unicorn/prefer-add-event-listener` | 6 | Vue 模板 @event 之外的赋值写法（6 处） | S |
| `typescript/array-type` | 405 | T[] 与 Array<T> 混用（405 处） | S |
| `typescript/consistent-generic-constructors` | 0 | 当前 0 命中 | Z |
| `typescript/consistent-type-definitions` | 92 | interface 与 type 按语义选择（92 处） | S |
| `typescript/method-signature-style` | 22 | 方法签名简写与属性函数混用（22 处） | S |
| `typescript/no-misused-new` | 1 | 1 处为声明合并必需 | Z |

#### 文件级/工具面 5 条（第一波 `no-console` 收敛的产物，`task-171 ③`，2026-11-15）


| 规则 | 作用域（`files`） | 实测命中 | 为什么 off | 类 |
| --- | --- | ---: | --- | --- |
| `no-console` | `e2e/**`、`scripts/**`、`src/**/__poc__/**`、`vite.config.ts` | 217 | 这四类都是脚本/构建配置，控制台输出就是它们的**接口**（E2E 诊断、生成器报告、poc 运行器、vite 配置打印） | S |
| `no-console` | `src/lib/logger.ts` | 3 | **logger 的实现**本身要落到 `console.*`（`emit` 里的三元选函数）；禁它等于禁掉日志落点 | S |
| `no-console` | `src/**/__tests__/**`、`*.spec.ts`、`*.test.ts` | 5 | 测试里的 `console.log` 是失败现场诊断（如 `[specdbg]`），不进产品包 | V |
| `no-console` | `src/test-utils/**` | 1 | 测试夹具的告警（`i18nKeys` 缺键提示），同为诊断面 | V |
| `unicorn/prefer-dom-node-text-content` | `e2e/real/**`、`e2e/mock/**` | 21 | E2E 断言常比对 `textContent`；该规则要求 `innerText`，与既有断言口径冲突 | S |

#### 测试区三档判据（`task-43` / `D-1692`，2026-11-16）—— 只 1 条 `off`，其余留共享档


| 规则 | 作用域（`files`） | 档 | 为什么（不是「麻烦」） |
| --- | --- | --- | --- |
| `new-cap` | `src/**/__tests__/**`、`src/**/*.spec.ts`、`src/**/*.test.ts`、`src/test-utils/**` | T-O 关闭 | 规则要求「大写开头的函数只能当构造器用」，而测试里大写名是**API 调用与工厂**（`KEYDOWN()` 造键盘事件、`Mount(...)` 包组件），本来就不是构造 ⇒ **规则语义在测试域不成立** |
| `new-cap` | `e2e/**` | T-O 关闭 | 同上；e2e 与 src 内测试同为测试区，若只放宽一边就是新的不一致（SSOT §2.1 的 e2e vs `__tests__` 待遇差） |

#### 测试块 72 条（`files: ["src/**/__tests__/**", "src/**/*.spec.ts", "src/**/*.test.ts"]`）


逐条登记（全部 0 命中）：

```text
no-console
vitest/consistent-each-for
vitest/consistent-test-filename
vitest/consistent-test-it
vitest/consistent-vitest-vi
vitest/expect-expect
vitest/hoisted-apis-on-top
vitest/max-expects
vitest/max-nested-describe
vitest/no-alias-methods
vitest/no-commented-out-tests
vitest/no-conditional-expect
vitest/no-conditional-in-test
vitest/no-conditional-tests
vitest/no-disabled-tests
vitest/no-duplicate-hooks
vitest/no-focused-tests
vitest/no-hooks
vitest/no-identical-title
vitest/no-import-node-test
vitest/no-importing-vitest-globals
vitest/no-interpolation-in-snapshots
vitest/no-large-snapshots
vitest/no-mocks-import
vitest/no-restricted-matchers
vitest/no-restricted-vi-methods
vitest/no-standalone-expect
vitest/no-test-prefixes
vitest/no-test-return-statement
vitest/no-unneeded-async-expect-function
vitest/padding-around-after-all-blocks
vitest/padding-around-test-blocks
vitest/prefer-called-exactly-once-with
vitest/prefer-called-once
vitest/prefer-called-times
vitest/prefer-called-with
vitest/prefer-comparison-matcher
vitest/prefer-describe-function-title
vitest/prefer-each
vitest/prefer-equality-matcher
vitest/prefer-expect-assertions
vitest/prefer-expect-resolves
vitest/prefer-expect-type-of
vitest/prefer-hooks-in-order
vitest/prefer-hooks-on-top
vitest/prefer-import-in-mock
vitest/prefer-importing-vitest-globals
vitest/prefer-lowercase-title
vitest/prefer-mock-promise-shorthand
vitest/prefer-mock-return-shorthand
vitest/prefer-snapshot-hint
vitest/prefer-spy-on
vitest/prefer-strict-boolean-matchers
vitest/prefer-strict-equal
vitest/prefer-to-be-falsy
vitest/prefer-to-be-object
vitest/prefer-to-be-truthy
vitest/prefer-to-be
vitest/prefer-to-contain
vitest/prefer-to-have-been-called-times
vitest/prefer-to-have-length
vitest/prefer-todo
vitest/require-awaited-expect-poll
vitest/require-hook
vitest/require-local-test-context-for-concurrent-snapshots
vitest/require-test-timeout
vitest/require-top-level-describe
vitest/valid-describe-callback
vitest/valid-expect-in-promise
vitest/valid-expect
vitest/valid-title
vitest/warn-todo
```

<!-- lint-rule-registry:end -->
