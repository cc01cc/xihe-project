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

/**
 * 取**全部**匹配规则的声明块（按出现顺序），找不到时返回空数组。
 *
 * task-362：`main.css` 现在有**两处**顶层 `:root` —— `bc98a2459` 为 `color-scheme` 与滚动条
 * 加了一个更早的 `:root`，字阶 token 留在原来那一处。旧 helper 只取**第一处**匹配，于是在
 * `:root` 变 2 块之后永远读不到字阶块（红在「取哪一块」，不在「token 对不对」）。
 * 字阶 token 定义在第几处 `:root` **不是**契约内容，所以取块方式必须与块数无关。
 */
function declarationBlocks(css: string, selector: string): string[] {
    const blocks: string[] = [];
    let from = 0;
    for (;;) {
        const open = css.indexOf(`${selector} {`, from);
        if (open < 0) return blocks;
        let depth = 0;
        let end = -1;
        for (let index = open + selector.length; index < css.length; index += 1) {
            if (css[index] === "{") depth += 1;
            else if (css[index] === "}") {
                depth -= 1;
                if (depth === 0) {
                    end = index;
                    break;
                }
            }
        }
        if (end < 0) throw new Error(`样式契约解析失败：${selector} 的声明块未闭合`);
        blocks.push(css.slice(open, end + 1));
        from = end + 1;
    }
}

/** 取第一处匹配的声明块；找不到 selector 视为契约破坏。 */
function declarationBlock(css: string, selector: string): string {
    const blocks = declarationBlocks(css, selector);
    if (blocks.length === 0) throw new Error(`样式契约缺失：找不到规则 ${selector}`);
    return blocks[0] as string;
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

    it("气泡正文 token 锚在 14px / 1.55（--text-sm 对），且字阶 token 全站只定义一次", () => {
        const roots = declarationBlocks(main, ":root").join("\n");
        expect(roots.length, "main.css 至少要有一处顶层 :root").toBeGreaterThan(0);
        expect(roots).toContain("--text-sm: 0.875rem");
        expect(roots).toContain("--text-sm--line-height: 1.55");
        expect(roots).toContain("--leading-relaxed: 1.55");

        // 不变量：**字阶 token 全站只定义一次，主题切换不改字号节奏**。
        //
        // 上面三条 toContain 的搜索面已从「第一处 :root」放宽到「全部 :root」（task-362，
        // D-1200 事前批：更松必须事前批）——放宽的部分由下面这条唯一性断言守着：
        // 以后真有人按主题重定义 `--text-sm`，这里会**红**；红着改到「含目标 token 的那个块」
        // = 有人看了一眼；绿着放过 = 没人知道约定变了。
        expect(main.match(/--text-sm:\s/g)?.length ?? 0, "--text-sm 只能定义一次").toBe(1);
        expect(
            main.match(/--text-sm--line-height:\s/g)?.length ?? 0,
            "--text-sm--line-height 只能定义一次",
        ).toBe(1);
        expect(
            main.match(/--leading-relaxed:\s/g)?.length ?? 0,
            "--leading-relaxed 只能定义一次",
        ).toBe(1);
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
