/**
 * PLAN-0755 M6 —— CodeMirror 6 主题层（POC task-182 验收① 的生产落地）。
 *
 * 契约（硬验收 V1）：CM6 的所有样式**只写 `var(--token)`**，不出现任何十六进制色值
 * ⇒ 编辑器跟随 A03 的 `data-xh-color` 换色机制（`styles/main.css` :root / .dark /
 * `html[data-xh-color="c1|c3"]`）零 JS 监听。POC 实测三方案 `--primary` 逐值一致。
 *
 * 与 POC 的差异：POC 用 `@lezer/highlight` 的 `tags`；生产走 CM6 官方
 * `@codemirror/language` 的 `HighlightStyle` + `syntaxHighlighting`（同 API，
 * POC harness/src/theme.ts 已验证 `var(--token)` 产物）。
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** 编辑器容器/光标/行号栏/选区 —— 全部走 token。 */
export const cmTheme = EditorView.theme({
    "&": { color: "var(--foreground)", backgroundColor: "var(--background)" },
    ".cm-content": { caretColor: "var(--primary)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
    ".cm-gutters": {
        backgroundColor: "var(--muted)",
        color: "var(--muted-foreground)",
        borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine": { backgroundColor: "var(--accent)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--accent)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--secondary)",
    },
    ".cm-scroller": {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        lineHeight: "1.55",
    },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "3.2em" },
});

/** 焦点环用 `--ring`（DEV-011 注意力预算：focus 必须环形轮廓且与 hover 可区分）。 */
export const cmFocus = EditorView.theme({
    "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "-1px" },
    "&:not(.cm-focused)": { outline: "1px solid transparent" },
});

/** Markdown 语法高亮 —— 颜色全部走 token（与 POC pocHighlight 逐条对齐）。 */
export const cmHighlight = HighlightStyle.define([
    { tag: t.heading, color: "var(--primary)", fontWeight: "700" },
    { tag: t.strong, fontWeight: "700", color: "var(--foreground)" },
    { tag: t.emphasis, fontStyle: "italic", color: "var(--foreground)" },
    { tag: t.link, color: "var(--primary)", textDecoration: "underline" },
    { tag: t.url, color: "var(--primary)" },
    {
        tag: t.monospace,
        color: "var(--card-foreground)",
        backgroundColor: "var(--muted)",
        borderRadius: "3px",
    },
    { tag: t.processingInstruction, color: "var(--muted-foreground)" },
    { tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
    { tag: t.keyword, color: "var(--primary)" },
    { tag: t.string, color: "var(--primary)" },
    { tag: t.quote, color: "var(--muted-foreground)" },
]);

/** 供 jsdom 断言：这些选择器/属性必须出现在注入的 CSS 里（POC theme.dom.test 同款口径）。 */
export const CM_THEME_CONTRACT: Array<[string, string]> = [
    ["cm-editor", "var(--background)"],
    ["cm-editor", "var(--foreground)"],
    ["cm-gutters", "var(--muted)"],
    ["cm-focused", "var(--ring)"],
];

/** 组合扩展：主题 + 焦点环 + 语法高亮（不含 keymap/行号，由宿主按需叠加）。 */
export const cmExtensions = [cmTheme, cmFocus, syntaxHighlighting(cmHighlight)];
