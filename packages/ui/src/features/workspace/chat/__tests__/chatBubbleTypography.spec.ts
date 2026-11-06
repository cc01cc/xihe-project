import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TextPart from "../components/parts/TextPart.vue";

/*
 * PLAN-0631 T3.3：assistant markdown 气泡正文必须落在气泡正文口径 `text-sm`（14px / 1.55）。
 *
 * 走查实测（有头，2026-11-06）assistant markdown 段落 16px/28px、user 段落 14px/21.7px。
 * 根因不是 specificity，而是 markstream-vue 把字号写在**段落自身**上
 * （`.paragraph-node[data-v-…] { font-size: var(--ms-text-body) }`，`--ms-text-body: 1rem`）——
 * 后代自有声明不继承祖先，故 `typeset.css` 的 `.xihe-chat-markdown { font-size }` 只提供继承基准。
 * 修复 = 在 `.xihe-chat-markdown` 上重定义上游 token（unlayered，压过 `@layer components` 的定义）。
 *
 * 断言层级说明：jsdom 不做 CSS 层叠，Vitest 也不加载产品 CSS（`test.css` 未开启），
 * `getComputedStyle` 在单测里拿不到真实字号；因此这里锁「DOM 前提」+「样式契约」两层，
 * 计算样式的最终确认归真栈浏览器复测（Lead 批量窗口，本任务禁有头浏览器）。
 */

const uiRoot = process.cwd();
const readStyle = (relativePath: string): string =>
    readFileSync(resolve(uiRoot, relativePath), "utf8");

/** 取顶层规则的声明块原文；找不到 selector 视为契约破坏。 */
function declarationBlock(css: string, selector: string): string {
    const open = css.indexOf(`${selector} {`);
    if (open < 0) throw new Error(`样式契约缺失：找不到规则 ${selector}`);
    let depth = 0;
    const start = open + selector.length;
    for (let index = start; index < css.length; index += 1) {
        if (css[index] === "{") depth += 1;
        else if (css[index] === "}") {
            depth -= 1;
            if (depth === 0) return css.slice(open, index + 1);
        }
    }
    throw new Error(`样式契约解析失败：${selector} 的声明块未闭合`);
}

const typeset = readStyle("src/styles/typeset.css");
const main = readStyle("src/styles/main.css");

describe("chat bubble typography（PLAN-0631 T3.3 WFont）", () => {
    it("markstream 根元素与 typeset 作用域是同一元素，段落节点在其内部", () => {
        const wrapper = mount(TextPart, { props: { content: "hello", isStreaming: false } });
        const root = wrapper.element as HTMLElement;
        // token 桥接的前提：`--ms-text-body` 定义与 `.xihe-chat-markdown` 覆盖落在同一元素上。
        expect(root.classList.contains("markstream-vue")).toBe(true);
        expect(root.classList.contains("xihe-chat-markdown")).toBe(true);
        // 覆盖对象的前提：段落在该作用域内，且带 scoped 属性（markstream 选择器形态）。
        const paragraph = root.querySelector(".paragraph-node");
        expect(paragraph).not.toBeNull();
        expect((paragraph as HTMLElement).parentElement?.closest(".xihe-chat-markdown")).toBe(root);
        wrapper.unmount();
    });

    it("气泡正文 token 锚在 14px / 1.55（--text-sm 对）", () => {
        const roots = declarationBlock(main, ":root");
        expect(roots).toContain("--text-sm: 0.875rem");
        expect(roots).toContain("--text-sm--line-height: 1.55");
        expect(roots).toContain("--leading-relaxed: 1.55");
    });

    it("typeset 重定义 markstream 正文 token，段落字号跟随 --text-sm", () => {
        const scope = declarationBlock(typeset, ".xihe-chat-markdown");
        expect(scope).toContain("--ms-text-body: var(--text-sm)");
        expect(scope).toContain("--ms-leading-body: var(--text-sm--line-height)");
        expect(scope).toContain("font-size: var(--text-sm)");
        expect(scope).toContain("line-height: var(--text-sm--line-height)");
    });

    it("typeset 不再出现脱离 token 的字面字号（防回退到 15px 口径）", () => {
        expect(typeset).not.toContain("0.9375rem");
        expect(typeset).not.toContain("font-size: 15px");
    });

    it("markstream 上游仍以 --ms-text-body 驱动段落字号（上游改名即红灯，需同步桥接）", () => {
        const markstream = readStyle("node_modules/markstream-vue/dist/index.tailwind.css");
        expect(markstream).toMatch(/--ms-text-body:\s*1rem/);
        expect(markstream).toMatch(/--ms-leading-body:\s*1\.75/);
        expect(markstream).toMatch(
            /\.paragraph-node\[data-v-[0-9a-f]+\]\s*\{[^}]*font-size:\s*var\(--ms-text-body\)/,
        );
        expect(markstream).toMatch(
            /\.paragraph-node\[data-v-[0-9a-f]+\]\s*\{[^}]*line-height:\s*var\(--ms-leading-body\)/,
        );
    });
});
