import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * task-39：**焦点轮廓必须待在 `@layer base` 里**（静态守卫）。
 *
 * <p>为什么需要一条静态判据：这是纯 CSS 层叠问题，jsdom 不实现层叠层（`@layer`）语义，
 * 单测里 `getComputedStyle` 永远拿不到"无层规则压过 utility"的真实结果 —— 换句话说，
 * 这个缺陷在组件测试里**天然测不到**，只能靠量源码结构 + 真浏览器读数（见卡面证据）。</p>
 *
 * <p>实证（task-39 改动前后各 345 个 Tab 焦点停点）：规则在层外时，`focus:outline-none`
 * 是哑弹，`vendor Input/Textarea` 与三个分隔条全靠这条 2px 纯色近黑 outline 撑着焦点可见性；
 * 搬进 base 层后它们会失去唯一指示 ⇒ 同批给 vendor 输入族与三个分隔条补了自有环。
 * 本 spec 同时钉住"搬层"与"补环"两件事，缺一个就有控件悄悄失去焦点可见性。</p>
 */

/**
 * jsdom 环境下 `import.meta.url` 是 http URL（不是 file:），不能直接喂 `readFileSync`；
 * vitest 的 cwd 是包根 `packages/ui`（`pnpm run test:unit` 就在这里跑）⇒ 用 cwd 拼。
 */
const UI_SRC = process.cwd();

function read(rel: string): string {
    return readFileSync(resolve(UI_SRC, rel), "utf8");
}

/**
 * 给定字符偏移，返回它所在的 `@layer` 名字栈（最外层在前）。
 * 只做本文件需要的最小解析：`@layer <name> {` 入栈、`{`/`}` 配对、忽略注释与字符串里的括号。
 */
function layerStackAt(css: string, offset: number): string[] {
    const stack: string[] = [];
    const layerStack: string[] = [];
    let comment = false;
    for (let i = 0; i < offset; i += 1) {
        const two = css.slice(i, i + 2);
        if (comment) {
            if (two === "*/") {
                comment = false;
                i += 1;
            }
            continue;
        }
        if (two === "/*") {
            comment = true;
            i += 1;
            continue;
        }
        if (css[i] === "{") {
            const head = css.slice(Math.max(0, i - 120), i);
            const match = head.match(/@layer\s+([A-Za-z0-9_.-]+)\s*$/);
            layerStack.push(match ? match[1] : "");
            stack.push("block");
        } else if (css[i] === "}") {
            layerStack.pop();
            stack.pop();
        }
    }
    return layerStack.filter((name) => name.length > 0);
}

function focusRuleOffset(css: string): number {
    const matches = [...css.matchAll(/\*:focus-visible\s*\{/g)];
    expect(matches.length, "main.css 里 *:focus-visible 应该只有一处声明（多处会互相遮掩）").toBe(
        1,
    );
    return matches[0].index ?? -1;
}

describe("task-39 全局焦点轮廓的层归属", () => {
    it("main.css 的 *:focus-visible 在 @layer base 内（在层外就是压过所有 utility 的无层规则）", () => {
        const css = read("src/styles/main.css");
        const offset = focusRuleOffset(css);
        expect(offset, "找不到 *:focus-visible 声明").toBeGreaterThan(-1);
        const layers = layerStackAt(css, offset);
        expect(layers, "落点必须在 @layer base 里；在层外时 focus:outline-none 是哑弹").toEqual([
            "base",
        ]);
        // 规则体本身也要在 base 层内闭合（不是刚好卡在规则名上）
        expect(css.slice(offset, offset + 200)).toMatch(/outline:\s*2px\s+solid\s+var\(--ring\)/);
    });

    it("vendor 输入族有自己的焦点环（否则搬层后它们会失去唯一指示）", () => {
        for (const rel of [
            "src/components/ui/input/Input.vue",
            "src/components/ui/textarea/Textarea.vue",
        ]) {
            const src = read(rel);
            expect(src, rel + " 必须有 focus-visible:ring-3").toContain("focus-visible:ring-3");
            expect(src, rel + " 必须有 focus-visible:ring-ring/50").toContain(
                "focus-visible:ring-ring/50",
            );
        }
    });

    it("两个分隔条保留自有环（键盘可聚焦，DEV-011 §10 要求环形轮廓）", () => {
        // task-175 B：tree-resizer 已随 D-1777/D-1778（e88bfd492，树改为右栏 files 面板）整段删除，
        // 其「不存在」由 WorkspaceWorkbench.spec.ts 的正向判据钉住（搜 tree-resizer 非存在断言）。
        // 产品路径现存的可聚焦分隔条只有 sidebar 与 dock 两个 ⇒ 表收窄到这两个，环判据不放宽。
        const separators: Array<[string, string]> = [
            ["src/layouts/AppLayout.vue", "sidebar-resizer"],
            ["src/features/workspace/components/WorkspaceDock.vue", "dock-resizer"],
        ];
        for (const [rel, testid] of separators) {
            const src = read(rel);
            expect(src, rel + "（" + testid + "）必须有 focus-visible:ring").toContain(
                "focus-visible:ring-2 focus-visible:ring-ring/50",
            );
        }
    });
});
