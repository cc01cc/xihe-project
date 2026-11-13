/**
 * task-286 —— `jsonFieldHighlight` 契约单测。
 *
 * 为什么这些断言值得写：本文件的**正确性无法靠肉眼看出**。CM6 的
 * `highlightingFor()`（`@codemirror/language/dist/index.js:1753-1765`）把**所有**注册的
 * Highlighter 的 class **拼在一起**返回；两个 StyleModule 的 CSS 同特异性时，谁在样式表里
 * 靠后谁赢，而那由扩展注册顺序决定 —— 实测**先注册的 `cmExtensions` 赢**。
 *
 * 后果：若本文件给 `string` 或 `null` 也写了颜色，那段声明**永远不生效**，
 * 而 review 时它看起来完全正确。这类「死代码 + 看起来对」的组合只能靠机器断言拦住，
 * 所以三条判据钉成测试：① 零十六进制；② **不得声明被抢先的 tag**；③ 必须覆盖剩下的 tag。
 *
 * 取数口径（踩过的坑）：`HighlightStyle` **不能用 `JSON.stringify`** —— 它的
 * `specs[].tag` 是 `Tag` 实例，带 `set -> Array -> 自身` 的循环引用，会抛
 * `TypeError: Converting circular structure to JSON`。正确读法是
 * `style.module.getRules()`（真 CSS 文本）与 `style.specs[].tag.toString()`（tag 名）。
 */
import { describe, expect, it } from "vitest";
import { tags as t } from "@lezer/highlight";
import { JSON_HIGHLIGHT_CONTRACT, jsonHighlight, jsonHighlighting } from "../jsonFieldHighlight";

/** 取真 CSS 文本（含 token、可查十六进制）。 */
function cssText(): string {
    return (jsonHighlight as unknown as { module: { getRules(): string } }).module.getRules();
}

/** 取被声明的 tag 名集合。 */
function declaredTags(): string[] {
    const specs = (jsonHighlight as unknown as { specs: { tag: { toString(): string } }[] }).specs;
    return specs.flatMap((spec) =>
        String(spec.tag)
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
    );
}

describe("jsonFieldHighlight —— token 契约", () => {
    it("CSS 只写 var(--token)，不含任何十六进制色值", () => {
        const css = cssText();
        for (const token of JSON_HIGHLIGHT_CONTRACT.requiredTokens) {
            expect(css).toContain(token);
        }
        // 与 cmTheme 同一判据：一旦写死 #rrggbb，换主题就不跟随了。
        expect(css).not.toMatch(/#(?:[0-9a-fA-F]{3,8})\b/);
    });

    it("组合扩展可直接用于 extensions", () => {
        expect(jsonHighlighting).toBeDefined();
    });
});

describe("jsonFieldHighlight —— 不得声明被 cmTheme 抢先的 tag", () => {
    // 这两条是真实的坑，不是假想：`null` 的父 tag 是 `keyword`
    // （`t.null.set = [null, keyword]`，脚本实测），cmTheme 已把 `keyword` 定到 --primary；
    // `string` 则由 cmTheme 直接覆盖。声明它们 = 写一段永远不会生效的代码。
    it.each([...JSON_HIGHLIGHT_CONTRACT.forbiddenTags])("不声明 tag %s", (name) => {
        expect(declaredTags()).not.toContain(name);
    });

    it("文档化的成因仍然成立：null 的父 tag 是 keyword", () => {
        // 若上游把 null 的父 tag 改了，这条会先红 —— 提醒复核「不声明 null」是否还成立。
        expect(t.null.set).toContain(t.keyword);
    });

    it("文档化的成因仍然成立：string 的父 tag 是 literal（cmTheme 直覆盖 string）", () => {
        expect(t.string.set).toContain(t.literal);
    });
});

describe("jsonFieldHighlight —— 必须覆盖 JSON 实际产出且 cmTheme 未管的 tag", () => {
    /**
     * `@lezer/json/src/highlight.js`：String / Number / True+False / PropertyName /
     * Null / ", :" / "[ ]" / "{ }"。除 `string`、`null` 外都必须由本文件覆盖，
     * 否则那些 token 回落默认前景色 = 页面上「没有高亮」。
     */
    it.each(["propertyName", "number", "bool", "separator"])("覆盖 tag %s", (name) => {
        expect(declaredTags()).toContain(name);
    });

    it("覆盖括号族（squareBracket / brace / bracket 至少其一）", () => {
        const tags = declaredTags();
        expect(
            tags.some((tag) => tag === "squareBracket" || tag === "brace" || tag === "bracket"),
        ).toBe(true);
    });

    it("规则条数可数得出来（≥5，proof 而非 prose）", () => {
        const specs = (jsonHighlight as unknown as { specs: unknown[] }).specs;
        expect(specs.length).toBeGreaterThanOrEqual(5);
    });
});

describe("jsonFieldHighlight —— 值的明度与 cmTheme 已定的一致", () => {
    it("number / bool 用 --primary（与 cmTheme 的 string/null 同档）", () => {
        const css = cssText();
        // 若这里改成 --foreground，同一份 JSON 里 "str" 和 3 会落在两个明度上，
        // 看起来像语义不同 —— 那是假信息。
        expect(css).toContain("var(--primary)");
    });

    it("propertyName 用 --foreground 且加重量（骨架靠字重而非新色相）", () => {
        const css = cssText();
        expect(css).toContain("var(--foreground)");
        expect(css).toContain("font-weight: 600");
    });
});
