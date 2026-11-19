/**
 * task-74 → task-119 → task-132：色板 token 的「层次」与「色板保真」门（默认档 = light / neutral）。
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
 * <p>C2 的判据形态（task-132 改判）：<b>不</b>判 chroma 够不够「冷」。用户 2026-11-20 00:49 裁定
 * 不换色板，而本仓色板 = shadcn neutral registry 原样照抄（chroma 全 0），要求 chroma &gt; 0
 * 等于要求改色值 —— 那不是回归门，是设计偏好。故 C2 改为<b>色板保真门</b>：31 个中性 token
 * 逐个与 registry cssVarsV4 比对（oklch 数值一致 + 中性键 chroma = 0），并把文件头已声明的
 * <b>有意偏离</b>写成显式白名单（--ring/--sidebar-ring → var(--primary)、--input、
 * 「面差」5 键、--destructive 的 task-89 解 L）。本门只防漂移、不表达设计偏好；
 * 任何擅自改色值、加 chroma、换 palette 都会红。官方值取自
 * https://www.shadcn-vue.com/r/colors/neutral.json 的 cssVarsV4（2026-11-20 核对）。</p>
 *
 * <p>旧 C2（断言 main.css 文案含「中性冷白」且 chroma &gt; 0）已删除：main.css:154 的
 * 「中性冷白 / 蓝拆分色板」是 A″ 固化基线的<b>标签</b>（2026-11-06 用户裁定），不是
 * 「每个 token 必须带色相」的承诺；拿它反推色值等于用文案当判据。</p>
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

/** 解出 neutral 色板的 light / dark 两块；解析不到就抛（跳过 = 又一个不会红的门）。 */
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

/** 卡片可见边界门：ring-foreground/10 合成后的比值（task-119）。 */
const MIN_CARD_BOUNDARY = 1.2;
/** Card.vue 的 ring 类写死 ring-foreground/10，即 --foreground 的 10% alpha。 */
const CARD_RING_ALPHA = 0.1;
/** --border 装饰线的不回退下限（现状 1.155 / 1.252）；1.20 是对**卡片边界**的判据，不是它。 */
const MIN_BORDER_OVER_BG = 1.15;
const MIN_MUTED_FG = 4.5;
const MIN_RING_RENDERED = 3.0;
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

type Theme = "light" | "dark";

/**
 * shadcn neutral registry 的 cssVarsV4 官方值（light 31 键 / dark 31 键；--radius 不在色板文件里）。
 *
 * <p>来源：https://www.shadcn-vue.com/r/colors/neutral.json（2026-11-20 读取）。与
 * https://ui.shadcn.com/r/colors/neutral.json 的差异只有 chart-1..5（官方 v4 已改灰阶），
 * 本仓按文件头声明的「原样照抄 shadcn-vue」保留彩色 chart ⇒ 比对基准取 shadcn-vue。</p>
 */
const OFFICIAL_NEUTRAL: Record<Theme, Record<string, string>> = {
    light: {
        background: "oklch(1 0 0)",
        foreground: "oklch(0.145 0 0)",
        card: "oklch(1 0 0)",
        "card-foreground": "oklch(0.145 0 0)",
        popover: "oklch(1 0 0)",
        "popover-foreground": "oklch(0.145 0 0)",
        primary: "oklch(0.205 0 0)",
        "primary-foreground": "oklch(0.985 0 0)",
        secondary: "oklch(0.97 0 0)",
        "secondary-foreground": "oklch(0.205 0 0)",
        muted: "oklch(0.97 0 0)",
        "muted-foreground": "oklch(0.556 0 0)",
        accent: "oklch(0.97 0 0)",
        "accent-foreground": "oklch(0.205 0 0)",
        destructive: "oklch(0.577 0.245 27.325)",
        border: "oklch(0.922 0 0)",
        input: "oklch(0.922 0 0)",
        ring: "oklch(0.708 0 0)",
        "chart-1": "oklch(0.646 0.222 41.116)",
        "chart-2": "oklch(0.6 0.118 184.704)",
        "chart-3": "oklch(0.398 0.07 227.392)",
        "chart-4": "oklch(0.828 0.189 84.429)",
        "chart-5": "oklch(0.769 0.188 70.08)",
        sidebar: "oklch(0.985 0 0)",
        "sidebar-foreground": "oklch(0.145 0 0)",
        "sidebar-primary": "oklch(0.205 0 0)",
        "sidebar-primary-foreground": "oklch(0.985 0 0)",
        "sidebar-accent": "oklch(0.97 0 0)",
        "sidebar-accent-foreground": "oklch(0.205 0 0)",
        "sidebar-border": "oklch(0.922 0 0)",
        "sidebar-ring": "oklch(0.708 0 0)",
    },
    dark: {
        background: "oklch(0.145 0 0)",
        foreground: "oklch(0.985 0 0)",
        card: "oklch(0.205 0 0)",
        "card-foreground": "oklch(0.985 0 0)",
        popover: "oklch(0.205 0 0)",
        "popover-foreground": "oklch(0.985 0 0)",
        primary: "oklch(0.922 0 0)",
        "primary-foreground": "oklch(0.205 0 0)",
        secondary: "oklch(0.269 0 0)",
        "secondary-foreground": "oklch(0.985 0 0)",
        muted: "oklch(0.269 0 0)",
        "muted-foreground": "oklch(0.708 0 0)",
        accent: "oklch(0.269 0 0)",
        "accent-foreground": "oklch(0.985 0 0)",
        destructive: "oklch(0.704 0.191 22.216)",
        border: "oklch(1 0 0 / 10%)",
        input: "oklch(1 0 0 / 15%)",
        ring: "oklch(0.556 0 0)",
        "chart-1": "oklch(0.488 0.243 264.376)",
        "chart-2": "oklch(0.696 0.17 162.48)",
        "chart-3": "oklch(0.769 0.188 70.08)",
        "chart-4": "oklch(0.627 0.265 303.9)",
        "chart-5": "oklch(0.645 0.246 16.439)",
        sidebar: "oklch(0.205 0 0)",
        "sidebar-foreground": "oklch(0.985 0 0)",
        "sidebar-primary": "oklch(0.488 0.243 264.376)",
        "sidebar-primary-foreground": "oklch(0.985 0 0)",
        "sidebar-accent": "oklch(0.269 0 0)",
        "sidebar-accent-foreground": "oklch(0.985 0 0)",
        "sidebar-border": "oklch(1 0 0 / 10%)",
        "sidebar-ring": "oklch(0.556 0 0)",
    },
};

/**
 * 有意偏离官方值的地方 —— 每一组都对应 color-shadcn-neutral.css 文件头/逐 token 注释里的依据。
 *
 * <p>改这张表 = 改色板基线，必须先有新的用户裁定与证据包；值写在这里而不是「跳过检查」，
 * 是为了让偏离本身也被钉住（有人把 --input 调回官方 0.922，门同样会红）。</p>
 */
const INTENTIONAL_DEVIATIONS: Record<Theme, Record<string, { value: string; why: string }>> = {
    light: {
        background: {
            value: "oklch(0.97 0 0)",
            why: "面差 5 键（用户 2026-11-12 批 a2a24caf3）；官方 1",
        },
        muted: { value: "oklch(0.93 0 0)", why: "面差 5 键；官方 0.97" },
        "muted-foreground": { value: "oklch(0.53 0 0)", why: "面差 5 键；官方 0.556" },
        accent: { value: "oklch(0.93 0 0)", why: "面差 5 键；官方 0.97" },
        "sidebar-accent": { value: "oklch(0.94 0 0)", why: "面差 5 键；官方 0.97" },
        destructive: {
            value: "oklch(0.55 0.245 27.325)",
            why: "task-89：官方 0.577 落浅底仅 4.38:1，只解 L 到 0.55",
        },
        input: {
            value: "oklch(0.605 0 0)",
            why: "task-310：控件边界需 1.4.11 的 3:1，官方 0.922 对 --muted 仅 2.54",
        },
        ring: {
            value: "var(--primary)",
            why: "官方 0.708 对 --background 仅 2.58–2.63:1 < 3:1（2026-11-11 裁定）",
        },
        "sidebar-ring": { value: "var(--primary)", why: "同上" },
    },
    dark: {
        input: {
            value: "oklch(0.554 0 0)",
            why: "task-310：同 3:1 判据（官方 oklch(1 0 0 / 15%)，5 底最差 3.192）",
        },
        ring: { value: "var(--primary)", why: "同 light 档 ① 偏离" },
        "sidebar-ring": { value: "var(--primary)", why: "同上" },
    },
};

/**
 * 中性键 = 除 chart-1..5 / destructive / sidebar-primary 外的全部键：它们的 chroma 必须是 0。
 *
 * <p>三个例外都是 registry 自己带彩度的键（chart 是数据色、destructive 是警示红、
 * dark 的 sidebar-primary = oklch(0.488 0.243 264.376) 是品牌蓝），不属于「中性色板」的判据面。</p>
 */
function isNeutralKey(bare: string): boolean {
    return !bare.startsWith("chart-") && bare !== "destructive" && bare !== "sidebar-primary";
}

/**
 * 逐键比对一档色板。
 *
 * <p>比的是 oklch 的四个数（L / C / H / alpha），不是字符串 —— 官方写 oklch(1 0 0 / 10%)、
 * 本仓写 oklch(1 0 0 / 10%) 时字符串相等，但加空格或换百分比写法不该红。</p>
 */
function checkPalette(theme: Theme): void {
    const block = theme === "light" ? light : dark;
    const official = OFFICIAL_NEUTRAL[theme];
    const deviations = INTENTIONAL_DEVIATIONS[theme];
    const expectedKeys = Object.keys(official).sort();
    const actualKeys = [...block.decls.keys()].sort();
    expect(
        actualKeys,
        theme +
            " 档的 token 集合与 shadcn neutral registry 不一致（多了键或少了解析）。registry 31 键：" +
            expectedKeys.join(", "),
    ).toEqual(expectedKeys.map((bare) => "--" + bare));

    for (const bare of expectedKeys) {
        const name = "--" + bare;
        const actualRaw = tokenSource(block.decls, name);
        const deviation = deviations[bare];
        const expectedRaw = deviation ? deviation.value : official[bare];
        const why = deviation ? deviation.why : "registry 原值";

        if (expectedRaw.startsWith("var(")) {
            // tokenSource 会把 var 链展开（--ring: var(--primary) 解成 oklch(0.205 0 0)），
            // 所以这里比的是**原始声明**，不是展开后的值。
            const rawDecl = (block.decls.get(name) ?? "").trim();
            expect(
                rawDecl,
                name +
                    " 应按文件头声明的偏离写成 " +
                    expectedRaw +
                    "（" +
                    why +
                    "），实际 " +
                    rawDecl,
            ).toBe(expectedRaw);
            continue;
        }

        const actual = parseOklch(actualRaw);
        const expected = parseOklch(expectedRaw);
        if (actual === null || expected === null) {
            throw new Error(
                name + " 不是 oklch 字面量：实际 " + actualRaw + " / 期望 " + expectedRaw,
            );
        }
        const same =
            Math.abs(actual.l - expected.l) < 1e-9 &&
            Math.abs(actual.c - expected.c) < 1e-9 &&
            Math.abs(actual.h - expected.h) < 1e-9 &&
            Math.abs(actual.alpha - expected.alpha) < 1e-9;
        expect(
            same,
            name +
                " 偏离了色板基线：实际 " +
                actualRaw +
                " / 期望 " +
                expectedRaw +
                "（" +
                why +
                "）。改色值必须先有用户裁定 + 证据，再改 color-shadcn-neutral.css 与本表",
        ).toBe(true);

        if (isNeutralKey(bare)) {
            expect(
                actual.c,
                name +
                    " 不再是纯灰（chroma " +
                    actual.c +
                    "）：本仓中性色板 = shadcn neutral registry 原样照抄，chroma 必须 0。" +
                    "要冷白请先改色板裁定，别在这里放宽门",
            ).toBe(0);
        }
    }
}

describe("C2 色板保真（task-132：只防漂移，不表达设计偏好）", () => {
    it("light 档：31 键与 shadcn neutral registry 一致，仅文件头声明的 3 组有意偏离（9 处）", () => {
        checkPalette("light");
    });

    it("dark 档：31 键与 shadcn neutral registry 一致，仅文件头声明的 2 组有意偏离（3 处）", () => {
        checkPalette("dark");
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
