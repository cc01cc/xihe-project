/**
 * task-286 —— JSON 字段编辑器的语法高亮（**只补 cmTheme 没覆盖的那几个 tag**）。
 *
 * ## 为什么需要这一层（浏览器实测，不是推测）
 *
 * `cmTheme.ts` 的 `cmHighlight` 是给 **Markdown** 调的，覆盖
 * `heading/strong/emphasis/link/url/monospace/processingInstruction/comment/keyword/string/quote`。
 * 而 `@lezer/json` 的 `jsonHighlighting`（`@lezer/json/src/highlight.js`）产出的 tag 是
 * `String / Number / True False / PropertyName / Null / ", :" / "[ ]" / "{ }"`。
 * **两者交集只有 `string`（+ `null` 经 `keyword` 间接命中，见下）** ⇒ 键名、数字、布尔、括号
 * 全部吃默认前景色。实测佐证（迁移前，`probe6.mjs`）：7 行 JSON 只量到 2 个 class、
 * 且是同一个 computed color。
 *
 * 也就是说：**只装 `@codemirror/lang-json` 得不到「语法高亮」** —— 语法包只负责解析，
 * 上色是主题的责任。
 *
 * ## 哪些 tag 我不要声明（声明了也是死代码）
 *
 * `highlightingFor()`（`@codemirror/language/dist/index.js:1753-1765`）把**所有**注册的
 * Highlighter 的 class **拼在一起**返回；两个 StyleModule 的 CSS 同特异性时，谁在样式表里
 * 靠后谁赢，而那由扩展注册顺序决定 —— 实测**先注册的 `cmExtensions` 赢**。于是：
 *
 * | tag | cmTheme 覆盖 | 结果 |
 * | --- | --- | --- |
 * | `string` | 是（`--primary`） | cmTheme 赢 ⇒ 本文件**不声明** |
 * | `null` | 是（`null` 的父 tag 是 **`keyword`**，`t.null.set = [null, keyword]`） | cmTheme 赢 ⇒ 本文件**不声明** |
 * | `number` / `bool` / `propertyName` / `separator` / `brace` / `squareBracket` | 否 | 本文件负责 |
 *
 * （`t.null` 的父 tag 已用脚本核过：`null parents=[keyword]`、`string parents=[literal]`、
 * `bool parents=[literal]`、`propertyName parents=[name]`、`brace parents=[bracket, punctuation]`。）
 *
 * 与其写一条**永远不生效的声明**（读代码的人会以为它在起作用），不如显式不声明并把这件事写清楚。
 * 少一个「看着有、其实没有」的定义，比多一个更值。
 *
 * ## 视觉语法：三层，全部由既有 token 表达
 *
 * | 层 | 元素 | 取值 |
 * | --- | --- | --- |
 * | 骨架 | 键名 `propertyName` | `--foreground` + **600** |
 * | 值 | 字面量（number / bool；string、null 由 cmTheme 给） | `--primary` |
 * | 结构 | 标点 / 括号 / 分隔符 | `--muted-foreground` |
 *
 * 为什么值统一用 `--primary` 而不是 `--foreground`：`string` 由 cmTheme 定在 `--primary`
 * 且我改不动它（见上表）⇒ 若 number/bool 用 `--foreground`，同一份 JSON 里
 * `"str"` 和 `3` 会落在两个明度上，看起来像语义不同。**一致性优先于局部偏好**：
 * 让本文件能控的那几个向 cmTheme 已定的那个看齐，而不是反过来。
 *
 * 约束（沿用仓内既有先例，不发明第二套色阶）：**只用 `var(--token)`，零十六进制**
 * （与 `cmTheme.ts` / `diffTheme.css` 同一契约 ⇒ 自动跟随 `data-xh-color` 换主题、
 * 不需要任何 JS 监听）。键名加 `fontWeight: 600` 是在不新增颜色的前提下做「骨架 vs 值」
 * 的区分 —— DEV-011 §10 的注意力判据是「按用途分配权重」。
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * JSON 专用高亮（只声明 `cmHighlight` 未覆盖的 tag）。
 *
 * 刻意**不含** `t.string` 与 `t.null`：它们分别经 `string` / `keyword` 被 `cmTheme`
 * 抢先命中，且先注册者生效。见文件头两张表。
 */
export const jsonHighlight = HighlightStyle.define([
    // 骨架：键名。加重量而不加颜色。
    { tag: t.propertyName, color: "var(--foreground)", fontWeight: "600" },
    // 值：与 cmTheme 已定的 string/null 同档（--primary），保证同一份 JSON 里值的明度一致。
    { tag: t.number, color: "var(--primary)" },
    { tag: t.bool, color: "var(--primary)" },
    // 结构：标点与括号不承载语义，压低一档，避免和值抢注意力。
    { tag: t.separator, color: "var(--muted-foreground)" },
    { tag: [t.squareBracket, t.brace, t.bracket], color: "var(--muted-foreground)" },
]);

/** 组合成可直接塞进 `extensions` 的扩展。 */
export const jsonHighlighting = syntaxHighlighting(jsonHighlight);

/**
 * 供单测断言：本文件必须只写 token、不得出现十六进制色值；
 * 且必须**不得**声明 `string` / `null`（会被 cmTheme 抢先 ⇒ 死代码）。
 * 与 `cmTheme.ts` 的 `CM_THEME_CONTRACT` 同款口径。
 */
export const JSON_HIGHLIGHT_CONTRACT = {
    /** 本文件必须出现的 token。 */
    requiredTokens: ["var(--foreground)", "var(--primary)", "var(--muted-foreground)"],
    /** 不得声明的 tag（被 cmTheme 抢先）。 */
    forbiddenTags: ["string", "null"],
} as const;
