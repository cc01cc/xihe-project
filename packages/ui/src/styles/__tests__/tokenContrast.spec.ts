/**
 * task-74：色板 token 的「面差」与「冷色」门（默认档 = light / neutral）。
 *
 * <p>四道阈值来自 Lead 2026-11-19 UI 问题清单 v1（C1）+ 21:37 修正口径：
 * card/bg ≥ 1.15、border/bg ≥ 1.35、muted-fg/bg ≥ 4.5、ring 的实际渲染形态（50% 合成）
 * 对 5 个相邻底 ≥ 3.0。前两条今天**是红的**（1.090 / 1.155）—— 这是问题的固化，不是笔误。</p>
 *
 * <p>注意这两条阈值的性质：`--border` 不属 WCAG 1.4.11（装饰线，Lead 2026-11-13 裁定不动，
 * 见 color-shadcn-neutral.css:47-52 注释），所以 border 这一条是**设计面差门**，不是无障碍门；
 * 要把它改绿必须先重开那条裁定，而不是把阈值调低。</p>
 *
 * <p>两档都要判（Lead task-74 补口径 ①）：亮色与暗色各一套 card / border / muted-fg。
 * 只判亮色会漏 —— 暗色档这两条同样不达标（card 1.104、border 1.26），而来回切换主题时
 * 用户看到的正是暗色档。浏览器侧实测锚（Chromium）：light 1.091 / 1.155 / 4.841、
 * dark 1.105 / 1.252 / 7.633，出处 `internal/A03-xihe/evidence/2026-11-19-ui-baseline-measure/readings.json`；
 * 本文件的数由 8bit 通道四舍五入后计算，与实测差 ≤0.03（`--muted-foreground` 最明显 4.816 vs 4.841）。</p>
 *
 * <p>为什么必须有会红的断言：`ConfigDomainPanel.spec.ts` 这类只断言「用了哪个 token」的用例，
 * 在色板被改回纯灰时依旧全绿（`D-1162` ③ 的同一形态）。证据只证明某个时刻。</p>
 *
 * <p>C2 的判据形态：`src/styles/main.css:154` 的文案自称「中性冷白」，而 6 个底色 token 的
 * chroma 全为 0（纯灰）⇒ 文案与实现二者必须有一边改；本 spec 只负责让这件事无法静默共存。</p>
 *
 * <p>实现说明：不手写 CSS parser（postcss 是 vite 的硬依赖，按 vite 的位置解析它）；
 * 色彩数学全在 `./helpers/colorMath.ts`，与 `input-contrast.spec.ts` 共用同一份，
 * 并由本文件最后两例与浏览器实测 3.136 对账 —— 算错了先在这里红。</p>
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    compositeOver,
    contrastRatio,
    parseOklch,
    round3,
    tokenSource,
    tokenToRgba,
    tokenToRgb,
} from "./helpers/colorMath";

function themesDir(): string {
    let dir = resolve(process.cwd());
    for (let i = 0; i < 6; i++) {
        const candidate = join(dir, "src", "styles", "themes");
        if (existsSync(join(candidate, "color-shadcn-neutral.css"))) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error("找不到 src/styles/themes（从 " + process.cwd() + " 向上 6 层）");
}

const THEMES = themesDir();

interface Block {
    decls: Map<string, string>;
    lines: Map<string, number>;
}

/** 解出中性冷白的 light / dark 两块；解析不到就抛（跳过 = 又一个不会红的门）。 */
function parseNeutral(): { light: Block; dark: Block } {
    const base = createRequire(import.meta.url);
    let postcss: any;
    try {
        postcss = base("postcss");
    } catch {
        postcss = createRequire(base.resolve("vite"))("postcss");
    }
    if (typeof postcss?.parse !== "function") {
        throw new Error("postcss 解析不可用：拒绝静默跳过本门（D-1162 ③）");
    }
    const root = postcss.parse(readFileSync(join(THEMES, "color-shadcn-neutral.css"), "utf8"));
    const light: Block = { decls: new Map(), lines: new Map() };
    const dark: Block = { decls: new Map(), lines: new Map() };
    root.walkRules((rule: any) => {
        const sel = String(rule.selector || "");
        if (!/html\[data-xh-color=/.test(sel)) return;
        const target = sel.includes(".dark") ? dark : light;
        for (const node of rule.nodes || []) {
            if (node.type !== "decl") continue;
            const prop = String(node.prop);
            if (!prop.startsWith("--")) continue;
            target.decls.set(prop, String(node.value).trim());
            target.lines.set(prop, node.source?.start?.line ?? 0);
        }
    });
    if (light.decls.size === 0) throw new Error("解析默认档失败：light 块为空");
    if (dark.decls.size === 0) throw new Error("解析暗色档失败：dark 块为空");
    return { light, dark };
}

const { light, dark } = parseNeutral();

const SURFACES = ["--background", "--card", "--popover", "--muted", "--sidebar"] as const;
const COOL_SURFACES = [...SURFACES, "--border"] as const;

const MIN_CARD_OVER_BG = 1.15;
const MIN_BORDER_OVER_BG = 1.35;
const MIN_MUTED_FG = 4.5;
const MIN_RING_RENDERED = 3.0;
const MIN_COOL_CHROMA = 0.004;
const RING_ALPHA = 0.5;

/** 报错用：「--card = oklch(1 0 0)（neutral.css:29）」——读数必须能顺着地方找回去。 */
function where(name: string, block: Block = light): string {
    const line = block.lines.get(name) ?? 0;
    return name + " = " + tokenSource(block.decls, name) + "（neutral.css:" + line + "）";
}

function surface(name: string, block: Block = light): { r: number; g: number; b: number } {
    return tokenToRgb(block.decls, name);
}

describe("C1 面差：默认档（light / neutral）", () => {
    it("card / background ≥ 1.15（今天 1.090 ⇒ 红）", () => {
        const ratio = round3(contrastRatio(surface("--card"), surface("--background")));
        expect(
            ratio,
            "卡片与画布几乎同色，层次只能靠描边撑。读数 " +
                where("--card") +
                " 对 " +
                where("--background") +
                " = " +
                ratio +
                " < " +
                MIN_CARD_OVER_BG,
        ).toBeGreaterThanOrEqual(MIN_CARD_OVER_BG);
    });

    it("border / background ≥ 1.35（今天 1.155 ⇒ 红；设计面差门，非 1.4.11）", () => {
        const bg = surface("--background");
        const border = compositeOver(tokenToRgba(light.decls, "--border"), bg);
        const ratio = round3(contrastRatio(border, bg));
        expect(
            ratio,
            "描边太淡，与底色区分不开。读数 " +
                where("--border") +
                " 合成到 " +
                where("--background") +
                " = " +
                ratio +
                " < " +
                MIN_BORDER_OVER_BG +
                "（改绿需先重开「--border 不动」那条裁定）",
        ).toBeGreaterThanOrEqual(MIN_BORDER_OVER_BG);
    });

    it("muted-foreground / background ≥ 4.5（WCAG 1.4.3 正文；今天 4.816 已达标）", () => {
        const bg = surface("--background");
        const fg = tokenToRgb(light.decls, "--muted-foreground");
        const ratio = round3(contrastRatio(fg, bg));
        expect(
            ratio,
            "次要正文掉到正文标准以下。读数 " +
                where("--muted-foreground") +
                " 对 " +
                where("--background") +
                " = " +
                ratio +
                " < " +
                MIN_MUTED_FG +
                "；注意对 --muted 只有 " +
                round3(contrastRatio(fg, surface("--muted"))),
        ).toBeGreaterThanOrEqual(MIN_MUTED_FG);
    });
});

describe("B1/B2 focus ring 的可视强度", () => {
    it("ring 的实际渲染形态（50% 合成）对 5 个相邻底最差 ≥ 3.0（今天最差 3.223）", () => {
        const ring = tokenToRgba(light.decls, "--ring");
        const rendered = { ...ring, alpha: RING_ALPHA };
        const rows = SURFACES.map((name) => {
            const base = surface(name);
            return {
                name,
                ratio: round3(contrastRatio(compositeOver(rendered, base), base)),
            };
        });
        const worst = rows.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
        expect(
            worst.ratio,
            "焦点环在最差底面上看不见。最差 = " +
                worst.ratio +
                " @ " +
                worst.name +
                "；逐底面 " +
                rows.map((r) => r.name + "=" + r.ratio).join(" / ") +
                "（" +
                where("--ring") +
                "，环按 ring/50 叠在常驻 border 上 —— 见 InputArea.vue 的 focus-visible 类）",
        ).toBeGreaterThanOrEqual(MIN_RING_RENDERED);
    });
});

describe("C2 「中性冷白」不是纯灰", () => {
    it("main.css 自称「中性冷白」⇒ 底色 token 必须有可测到的冷色 chroma", () => {
        const mainCss = readFileSync(join(THEMES, "..", "main.css"), "utf8");
        expect(
            mainCss,
            "C2 判据的前提已变：main.css 不再自称「中性冷白」，本断言需要重写而不是删",
        ).toContain("中性冷白");
        const readings = COOL_SURFACES.map((name) => {
            const value = parseOklch(tokenSource(light.decls, name));
            if (value === null) throw new Error("token 不是 oklch 字面量：" + name);
            return { name, c: value.c, h: value.h };
        });
        const cool = readings.filter((r) => r.c >= MIN_COOL_CHROMA && r.h >= 200 && r.h <= 290);
        expect(
            cool.length,
            "文案说「中性冷白」，但 6 个底色 token 的 chroma 全是 " +
                readings.map((r) => r.c).join(" / ") +
                "、色相 " +
                readings.map((r) => r.h).join(" / ") +
                "（纯灰）⇒ 要么给 token 加冷色 chroma，要么改 main.css:154 的文案",
        ).toBeGreaterThan(0);
    });
});

describe("色彩数学自检（与浏览器实测对账）", () => {
    it("--input 对 5 底面的最差 = 浏览器实测 3.136（同 input-contrast.spec.ts 的 MEASURED）", () => {
        const input = tokenToRgb(light.decls, "--input");
        const worst = Math.min(...SURFACES.map((n) => contrastRatio(input, surface(n))));
        expect(round3(worst)).toBeCloseTo(3.136, 2);
    });

    it("阈值会咬：card 覆写成 background 的值 ⇒ 1.0 < 1.15（证明上面的门不是恒定绿）", () => {
        const patched = new Map(light.decls);
        patched.set("--card", tokenSource(light.decls, "--background"));
        const ratio = round3(contrastRatio(tokenToRgb(patched, "--card"), surface("--background")));
        expect(ratio).toBe(1);
        expect(ratio).toBeLessThan(MIN_CARD_OVER_BG);
    });
});

describe("C1 面差：暗色档（dark / neutral）", () => {
    it("card / background ≥ 1.15（今天 1.104 ⇒ 红；浏览器实测 1.105）", () => {
        const bg = surface("--background", dark);
        const ratio = round3(contrastRatio(surface("--card", dark), bg));
        expect(
            ratio,
            "暗色档卡片与画布几乎同色。读数 " +
                where("--card", dark) +
                " 对 " +
                where("--background", dark) +
                " = " +
                ratio +
                " < " +
                MIN_CARD_OVER_BG,
        ).toBeGreaterThanOrEqual(MIN_CARD_OVER_BG);
    });

    it("border / background ≥ 1.35（今天 1.26 ⇒ 红；浏览器实测 1.252）", () => {
        const bg = surface("--background", dark);
        const border = compositeOver(tokenToRgba(dark.decls, "--border"), bg);
        const ratio = round3(contrastRatio(border, bg));
        expect(
            ratio,
            "暗色档描边太淡（`--border` 自带 10% alpha，先合成再算）。读数 " +
                where("--border", dark) +
                " 合成到 " +
                where("--background", dark) +
                " = " +
                ratio +
                " < " +
                MIN_BORDER_OVER_BG +
                "（同亮色那条：改绿需先重开「--border 不动」裁定）",
        ).toBeGreaterThanOrEqual(MIN_BORDER_OVER_BG);
    });

    it("muted-foreground / background ≥ 4.5（今天 7.663 已达标；浏览器实测 7.633）", () => {
        const bg = surface("--background", dark);
        const ratio = round3(contrastRatio(tokenToRgb(dark.decls, "--muted-foreground"), bg));
        expect(
            ratio,
            "暗色档次要正文掉到正文标准以下。读数 " +
                where("--muted-foreground", dark) +
                " 对 " +
                where("--background", dark) +
                " = " +
                ratio +
                " < " +
                MIN_MUTED_FG,
        ).toBeGreaterThanOrEqual(MIN_MUTED_FG);
    });
});
