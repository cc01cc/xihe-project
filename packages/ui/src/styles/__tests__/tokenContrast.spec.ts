/**
 * task-74 → task-119：色板 token 的「层次」与「冷色」门（默认档 = light / neutral）。
 *
 * <p><b>task-119（用户 2026-11-20 00:48 裁定）</b>：卡片层次**不再用 card/bg 面差衡量**，
 * 改为「阴影 + 边框」两层表达 —— 用户原话「那你就用阴影与边框呀？难道阴影与边框不能用吗？」。
 * 依据是结构事实：neutral 的 card/bg 只有 1.091，slate light 的 --background 与 --card
 * 同为 oklch(1 0 0) ⇒ card/bg 恒 1.000，**任何面差门都过不了**（task-103 三选项测算已证，
 * one/.tmp/xh/ui-gates/slate-gate-options/README.md）。所以原来的 MIN_CARD_OVER_BG=1.15
 * 面差门在这里**删除**，换成三条可执行判据：
 *
 * <ol>
 *   <li>卡片必须带**非 none 阴影**（Card.vue 消费 --shadow-card，且该 token 在 main.css 的
 *       :root 与 :root.dark 都有定义）—— 层次的第一层；</li>
 *   <li>卡片**可见边界**（Card.vue 的 ring-foreground/10：10% 的 --foreground 画成卡片外圈的
 *       1px box-shadow，压着的是**页面底**）对 --background ≥ 1.20 —— 层次第二层，
 *       卡片与背景同色时仍能看见轮廓；</li>
 *   <li>--border 装饰线**不回退**：≥ 1.15（现状值，亮 1.155 / 暗 1.252）。</li>
 * </ol>
 *
 * <p>关于 ② 与 --border 的区别（读完再改阈值）：Lead m01168 的「border 门降 1.20」用的是
 * **slate** 读数（1.232 / 1.252），而默认档是 **neutral**，其亮色 --border/bg 只有 **1.155**，
 * 按 1.20 判会在默认档亮色**恒红**；同时 --border 本身不属 WCAG 1.4.11（装饰线，Lead
 * 2026-11-13 裁定不动，见 color-shadcn-neutral.css:47-52），1.35 是 task-74 自拍值。
 * 故：1.20 只判**卡片实际可见边界**（环对页面底：亮 1.240 / 暗 1.245，四 palette 全过；
 * 真机像素 1.253 / 1.223），--border 保留 1.15 的不回退下限。改这里之前先把这两条读完。</p>
 *
 * <p>两档都要判（Lead task-74 补口径 ①）：亮色与暗色各一套 boundary / border / muted-fg。
 * 浏览器侧实测锚（Chromium + 真机 12640 的 /preview.html，task-119 取证目录
 * internal/A03-xihe/evidence/2026-11-20-card-shadow-gate/，含两份截图与像素采样 readings.json）：
 * light 环对页面底 1.240（像素实测 1.253：#dcdcdc 对 #f5f5f5）/ border 1.155 / muted-fg 4.841；
 * dark 1.245（像素 1.223：#202020 对 #090909）/ 1.252 / 7.633。
 * 本文件的数由 8bit 通道四舍五入后计算，与实测差 ≤0.03（--muted-foreground 最明显 4.816 vs 4.841）。</p>
 *
 * <p>为什么必须有会红的断言：ConfigDomainPanel.spec.ts 这类只断言「用了哪个 token」的用例，
 * 在色板被改回纯灰时依旧全绿（D-1162 ③ 的同一形态）。证据只证明某个时刻。</p>
 *
 * <p>C2 的判据形态：src/styles/main.css 的文案自称「中性冷白」，而 6 个底色 token 的
 * chroma 全为 0（纯灰）⇒ 文案与实现二者必须有一边改；本 spec 只负责让这件事无法静默共存。</p>
 *
 * <p>实现说明：不手写 CSS parser（postcss 是 vite 的硬依赖，按 vite 的位置解析它）；
 * 色彩数学全在 ./helpers/colorMath.ts，与 input-contrast.spec.ts 共用同一份，
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
const MAIN_CSS = join(THEMES, "..", "main.css");
const CARD_VUE = join(THEMES, "..", "..", "components", "ui", "card", "Card.vue");

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

/** 从 main.css 里取 :root（亮）与 :root.dark（暗）两块的 --shadow-card。 */
function shadowCards(): { light: string | undefined; dark: string | undefined } {
    const src = readFileSync(MAIN_CSS, "utf8");
    const base = createRequire(import.meta.url);
    let postcss: any;
    try {
        postcss = base("postcss");
    } catch {
        postcss = createRequire(base.resolve("vite"))("postcss");
    }
    if (typeof postcss?.parse !== "function")
        throw new Error("postcss 解析不可用：拒绝静默跳过阴影门");
    let light: string | undefined;
    let dark: string | undefined;
    postcss.parse(src).walkRules((rule: any) => {
        const sel = String(rule.selector || "").trim();
        if (sel !== ":root" && sel !== ":root.dark") return;
        for (const node of rule.nodes || []) {
            if (node.type !== "decl" || node.prop !== "--shadow-card") continue;
            if (sel === ":root") light = String(node.value).trim();
            else dark = String(node.value).trim();
        }
    });
    return { light, dark };
}

const { light, dark } = parseNeutral();

const SURFACES = ["--background", "--card", "--popover", "--muted", "--sidebar"] as const;
const COOL_SURFACES = [...SURFACES, "--border"] as const;

/** 卡片可见边界门：ring-foreground/10 合成后的比值（task-119）。 */
const MIN_CARD_BOUNDARY = 1.2;
/** Card.vue 的 ring 类写死 ring-foreground/10，即 --foreground 的 10% alpha。 */
const CARD_RING_ALPHA = 0.1;
/** --border 装饰线的不回退下限（现状 1.155 / 1.252）；1.20 是对**卡片边界**的判据，不是它。 */
const MIN_BORDER_OVER_BG = 1.15;
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

/**
 * 卡片可见边界 = --foreground 以 10% alpha 叠在**页面底**上（= Card.vue 的 ring-foreground/10）。
 *
 * <p>为什么底是 --background 而不是 --card：`ring-1` 是 box-shadow，画在卡片**外圈**，
 * 它压着的面是页面底。真机像素取证（task-119，--0.75px 亚像素位置）：
 * light 环 #dcdcdc 对页面底 #f5f5f5；dark 环 #202020 对页面底 #090909 ——
 * 与「10% 的 --foreground 叠在 --background 上」的理论值一致（误差 ≤1 个 8bit 通道）。</p>
 */
function cardBoundary(block: Block = light): number {
    const page = surface("--background", block);
    const ring = { ...tokenToRgba(block.decls, "--foreground"), alpha: CARD_RING_ALPHA };
    return round3(contrastRatio(compositeOver(ring, page), page));
}

describe("C1 层次：卡片阴影 + 可见边界（task-119 改判，默认档 light / neutral）", () => {
    it("卡片必须带非 none 阴影：Card.vue 消费 --shadow-card，且 light / dark 双档都有定义", () => {
        const cardVue = readFileSync(CARD_VUE, "utf8");
        expect(
            cardVue,
            "Card.vue 没有消费 --shadow-card ⇒ 卡片层次只剩 10% 的 ring，等于没做阴影层。改法：根节点 class 里加 shadow-[var(--shadow-card)]",
        ).toContain("shadow-[var(--shadow-card)]");

        const shadows = shadowCards();
        expect(
            shadows.light,
            "main.css 的 :root 没有定义 --shadow-card（亮色档）⇒ Card.vue 的 shadow-[var(--shadow-card)] 会解析成 none，阴影门形同虚设",
        ).toBeTruthy();
        expect(
            shadows.dark,
            "main.css 的 :root.dark 没有定义 --shadow-card（暗色档）⇒ 深色主题下阴影消失。深底上的黑阴影必须加不透明度并放大扩散才看得见",
        ).toBeTruthy();
        for (const [label, value] of [
            ["light", shadows.light],
            ["dark", shadows.dark],
        ] as const) {
            expect(
                Boolean(value && !/^none$/i.test(value.trim())),
                label +
                    " 档的 --shadow-card 是空值或 none（main.css 里必须是真实的 box-shadow 列表）",
            ).toBe(true);
        }
    });

    it("卡片可见边界（ring-foreground/10 对页面底 --background）≥ 1.20（今天 1.240；真机像素实测 1.253）", () => {
        const ratio = cardBoundary(light);
        expect(
            ratio,
            "环在页面底那一侧看不见（环是 box-shadow 画在卡片外圈，合成底是 --background 而不是 --card）。读数：" +
                where("--foreground") +
                " 以 10% 叠在 " +
                where("--background") +
                " 上 = " +
                ratio +
                " < " +
                MIN_CARD_BOUNDARY,
        ).toBeGreaterThanOrEqual(MIN_CARD_BOUNDARY);
    });

    it("border / background ≥ 1.15（装饰线不回退；今天 1.155 刚过线，浏览器实测 1.155）", () => {
        const bg = surface("--background");
        const border = compositeOver(tokenToRgba(light.decls, "--border"), bg);
        const ratio = round3(contrastRatio(border, bg));
        expect(
            ratio,
            "描边掉得比现状还淡。读数 " +
                where("--border") +
                " 合成到 " +
                where("--background") +
                " = " +
                ratio +
                " < " +
                MIN_BORDER_OVER_BG +
                "；注意 1.20 是对**卡片可见边界**（ring 合成）的判据，不是 --border —— " +
                "默认档 neutral 亮色的 --border 只有 1.155，按 1.20 判会恒红，且 --border 属装饰线不归 WCAG 1.4.11（Lead 2026-11-13 裁定）",
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
        const mainCss = readFileSync(MAIN_CSS, "utf8");
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
                "（纯灰）⇒ 要么给 token 加冷色 chroma，要么改 main.css 的文案",
        ).toBeGreaterThan(0);
    });
});

describe("色彩数学自检（与浏览器实测对账）", () => {
    it("--input 对 5 底面的最差 = 浏览器实测 3.136（同 input-contrast.spec.ts 的 MEASURED）", () => {
        const input = tokenToRgb(light.decls, "--input");
        const worst = Math.min(...SURFACES.map((n) => contrastRatio(input, surface(n))));
        expect(round3(worst)).toBeCloseTo(3.136, 2);
    });

    it("阈值会咬：把 --foreground 覆写成 --background 的值 ⇒ 边界 1.0 < 1.20（证明卡片边界门不是恒定绿）", () => {
        const patched = new Map(light.decls);
        patched.set("--foreground", tokenSource(light.decls, "--background"));
        const page = surface("--background");
        const ring = { ...tokenToRgba(patched, "--foreground"), alpha: CARD_RING_ALPHA };
        const ratio = round3(contrastRatio(compositeOver(ring, page), page));
        expect(ratio).toBe(1);
        expect(ratio).toBeLessThan(MIN_CARD_BOUNDARY);
    });
});

describe("C1 层次：卡片阴影 + 可见边界（暗色档 dark / neutral）", () => {
    it("卡片可见边界（ring-foreground/10 对页面底 --background）≥ 1.20（今天 1.245；真机像素实测 1.223）", () => {
        const ratio = cardBoundary(dark);
        expect(
            ratio,
            "暗色档环在页面底一侧看不见。读数：" +
                where("--foreground", dark) +
                " 以 10% 叠在 " +
                where("--background", dark) +
                " 上 = " +
                ratio +
                " < " +
                MIN_CARD_BOUNDARY,
        ).toBeGreaterThanOrEqual(MIN_CARD_BOUNDARY);
    });

    it("border / background ≥ 1.15（今天 1.252 已达标；浏览器实测 1.252）", () => {
        const bg = surface("--background", dark);
        const border = compositeOver(tokenToRgba(dark.decls, "--border"), bg);
        const ratio = round3(contrastRatio(border, bg));
        expect(
            ratio,
            "暗色档描边掉得比现状还淡（--border 自带 10% alpha，先合成再算）。读数 " +
                where("--border", dark) +
                " 合成到 " +
                where("--background", dark) +
                " = " +
                ratio +
                " < " +
                MIN_BORDER_OVER_BG,
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
