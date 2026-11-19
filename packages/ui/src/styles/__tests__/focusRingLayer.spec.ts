import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

/**
 * B1（task-74）：**焦点环不得与常驻 border 同时画出第二条边**。
 *
 * <p>缺陷形态（Lead 2026-11-19 清单 B1）：composer 容器用 `has-[textarea:focus-visible]:ring-2`
 * 代为显示聚焦，但自己还留着常驻 `border`（1px，`--border` = oklch(0.922 0 0)）⇒ 聚焦时
 * 一圈浅灰描边 + 一圈 50% 近黑环 = 双层边，看起来像两个控件套在一起。</p>
 *
 * <p>正确形态树里就有（shadcn vendor `InputGroup.vue:16`）：`…:border-ring` 与环同一批上，
 * 边框在聚焦时变成环色 ⇒ 视觉上仍是一条边。判据就守这条机制，不靠人肉白名单。</p>
 *
 * <p>判据钉在**同一元素**上（Lead task-74 补口径 ②）：命中的是「自己带常驻 border、又用
 * `has-[…:focus-visible]:ring` 代为聚焦」的那层容器，不是 composer 外框 —— 按外框层数断言会
 * 永远通过（audit-2 实测那层 896×92 外框 focus 前后 `box-shadow` 完全不变），双层发生在内层
 * 容器上。所以门必须落在「带 ring 类的那一个开标签」。</p>
 *
 * <p>「focus 后 borderWidth 与 box-shadow 环层不得同时非零」在 jsdom 里算不出来：没有 Tailwind
 * 引擎，utility 不产生 computed style，`box-shadow` 恒为空 ⇒ 本 spec 把像素级判据落成等价的
 * **结构性**判据：常驻 border 必须在同一批 focus-visible 类里收到 `border-ring`（边框变色 ⇒
 * 视觉上仍是一条边）。像素侧复核归浏览器门（`input-contrast.spec.ts` 那类实测）。</p>
 *
 * <p>扫描面 = `src` 下全部 .vue 的 class 属性；注释先抹空白，`class=` / `:class=` 都算，
 * 同一开标签内任一属性带 `border-ring` 即视为合规。</p>
 */
/**
 * 合规形态二选一（task-67 补）：
 * ① 常驻 border 保留 ⇒ 同批收 `:focus-visible]:border-ring`（vendor InputGroup 形态，视觉仍一条边）；
 * ② 常驻 border 去掉 ⇒ 必须**显式**写 `border-0`（配合 `ring-1 ring-<color>` 画出静止态那一条边）。
 * ② 是 composer 的真实形态：容器若保留 1px border 又画环，浏览器门
 * `e2e/real/ui-baseline.spec.ts` ④ 会判 `ringer.borderWidthPx === 0` 失败 —— 两门互相约束，
 * 所以这一条不是放宽，是承认「去掉 border」是合法解法，且要求它被显式写出来（省掉 `border-0`
 * 而靠默认无边框看不出意图，也挡不住以后有人把 `border` 加回来）。
 */
function hasNoConstantBorder(classText: string): boolean {
    return /(^|[\s"])border-0(?![0-9])/.test(classText);
}

describe("B1 focus 环与常驻 border 不得同画", () => {
    it("「容器代为聚焦」（has-[…:focus-visible]:ring）必须同时把 border 收到环色", () => {
        const violations: string[] = [];
        let candidates = 0;
        for (const abs of vueFiles(resolve(UI_SRC, "src"))) {
            const rel = relative(UI_SRC, abs);
            const raw = readFileSync(abs, "utf8");
            const masked = maskComments(raw);
            for (const literal of classAttributes(raw)) {
                if (!literal.text.includes(":focus-visible]:ring")) continue;
                candidates += 1;
                if (literal.text.includes(":focus-visible]:border-ring")) continue;
                // 同一元素可能把 class 拆成 class= 与 :class= 两个属性 ⇒ 按所在开标签判，
                // 不按单个属性判（拆开写的合规写法被误报也是门失效）。
                if (enclosingTag(masked, literal.at).includes(":focus-visible]:border-ring")) {
                    continue;
                }
                // 显式零宽也算合规：这层已经**不画**常驻 border，环独自承担唯一一条边
                // （task-67 composer：`border` → `border-0 ring-1 ring-border`）。此时
                // `border-ring` 无从收色（宽度 0），硬要它出现就是逼人补一个没有视觉作用的类。
                if (hasNoConstantBorder(literal.text)) continue;
                violations.push(rel + ":" + literal.line + "「" + literal.text.trim() + "」");
            }
        }
        expect(
            candidates,
            "扫描没命中任何「容器代为聚焦」形态 ⇒ 判据已失效（pattern 变了？）",
        ).toBeGreaterThan(0);
        expect(
            violations,
            "下列容器聚焦时会画出两层边（常驻 border + 焦点环）—— 环那一批上要带 " +
                "`:focus-visible]:border-ring`：\n" +
                violations.join("\n"),
        ).toEqual([]);
    });

    it("合规判定自检：border-ring 与 border-0 都放行，裸 border 必须报", () => {
        // 正例 ②：显式零宽（composer 形态）
        expect(hasNoConstantBorder("rounded-lg border-0 px-3 ring-1 ring-border ring-2")).toBe(true);
        // 负例：只写 `border`，或写成 `border-t`/`border-b`，都不算显式零宽
        expect(hasNoConstantBorder("rounded-lg border px-3 has-[input:focus-visible]:ring-2")).toBe(
            false,
        );
        expect(hasNoConstantBorder("border-t border-border/60 ring-2")).toBe(false);
        expect(hasNoConstantBorder("rounded-lg")).toBe(false);
    });

    it("反向自检：InputGroup 的规范形态不被误判（否则门只会在别处假绿）", () => {
        const src = readFileSync(
            resolve(UI_SRC, "src/components/ui/input-group/InputGroup.vue"),
            "utf8",
        );
        const candidates = classAttributes(src).filter((l) =>
            l.text.includes(":focus-visible]:ring"),
        );
        expect(candidates.length, "InputGroup 里应存在「容器代为聚焦」形态").toBeGreaterThan(0);
        expect(candidates.map((l) => l.text.includes(":focus-visible]:border-ring"))).not.toContain(
            false,
        );
    });
});

/** 递归列出 dir 下全部 .vue（绝对路径）。 */
function vueFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...vueFiles(abs));
        else if (entry.name.endsWith(".vue")) out.push(abs);
    }
    return out;
}

/**
 * 把注释（HTML 注释、块注释、行注释）抹成等长空白：
 * 注释里的引号（「user's」这种）会被 scanner 当成字面量起点，一路吞到下一个引号 ——
 * 第一次实跑就是这么误报的（RecipientField.vue 的半句注释被当成 class 字面量）。
 * 等长替换保证行号不变。
 */
function maskComments(src: string): string {
    const parts = src.split("");
    const blank = (from: number, to: number): void => {
        for (let k = from; k < to; k += 1) {
            if (parts[k] !== "\n") parts[k] = " ";
        }
    };
    let i = 0;
    while (i < src.length) {
        if (src.startsWith("<!--", i)) {
            const end = src.indexOf("-->", i + 4);
            const to = end === -1 ? src.length : end + 3;
            blank(i, to);
            i = to;
            continue;
        }
        if (src.startsWith("/*", i)) {
            const end = src.indexOf("*/", i + 2);
            const to = end === -1 ? src.length : end + 2;
            blank(i, to);
            i = to;
            continue;
        }
        if (src[i] === "'" || src[i] === '"' || src[i] === "`") {
            const quote = src[i];
            i += 1;
            while (i < src.length && src[i] !== quote) {
                if (src[i] === "\\") i += 1;
                i += 1;
            }
            i += 1;
            continue;
        }
        if (src.startsWith("//", i)) {
            const end = src.indexOf("\n", i + 2);
            const to = end === -1 ? src.length : end;
            blank(i, to);
            i = to;
            continue;
        }
        i += 1;
    }
    return parts.join("");
}
/**
 * 取全部 class 属性值（`class="…"` / `:class="[…]"` 都算），带属性起始行号。
 *
 * 只扫 class 属性而不是「文件里所有字符串字面量」：第一版扫字面量时，注释里的引号
 * （「user's」这种）会被当成起点一路吞到下一个引号，把半句注释当成 class 报出来。
 * 注释先抹成空白（等长，行号不变），再按属性取值。
 */
function classAttributes(srcRaw: string): Array<{ text: string; line: number; at: number }> {
    const src = maskComments(srcRaw);
    const out: Array<{ text: string; line: number; at: number }> = [];
    let line = 1;
    let cursor = 0;
    for (const m of src.matchAll(/:?class\s*=\s*(["'])/g)) {
        const at = m.index ?? 0;
        for (let k = cursor; k < at; k += 1) {
            if (src[k] === "\n") line += 1;
        }
        cursor = at;
        const quote = m[1];
        const start = at + m[0].length;
        const end = src.indexOf(quote, start);
        if (end === -1) continue;
        out.push({ text: src.slice(start, end), line, at: start });
    }
    return out;
}
/** 取 `at` 所在的整段开标签 `<…>`（在已抹注释的源上扫，属性值里的 `>` 不算结束）。 */
function enclosingTag(masked: string, at: number): string {
    let start = at;
    while (start > 0 && masked[start] !== "<") start -= 1;
    let end = at;
    let quote: string | null = null;
    while (end < masked.length) {
        const ch = masked[end];
        if (quote !== null) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === ">") {
            break;
        }
        end += 1;
    }
    return masked.slice(start, end + 1);
}
