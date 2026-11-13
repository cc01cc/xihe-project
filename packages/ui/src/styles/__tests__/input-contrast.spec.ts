import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * task-310 判据：`--input`（可交互控件边界）对**最差底面**必须 ≥ 3.10:1（WCAG 1.4.11 要 3:1，
 * 3.10 是我们刻意留的余量 —— 写进断言，才不会被下一个人当"多出来的 0.1"抹掉）。
 *
 * 为什么要有这条测试（Lead 2026-11-13 裁定）：token 改好之后，`ConfigDomainPanel.spec.ts` 只能
 * 断言「用了 `border-input` 这个 token」，**不再断言「对比度够」**。于是有人把 `--input` 改回
 * `oklch(0.928 …)`，那条 spec 依然全绿，而 10 个格子会一起掉到 1.1:1。
 * ⇒ 证据只证明某个时刻；**10 格读数必须是会红的断言**（`D-1162` ③ 的同一形态）。
 *
 * 分母纪律：报的是 5 个底面里**最差**的那个（`--muted` 恒为最差），只按 `--background` 算会系统性
 * 偏乐观（旧值就是这样"过"了 3.11，实测 2.54）。
 *
 * 实现说明：不手写 CSS parser —— postcss 是 vite 的硬依赖，按 vite 的位置解析它；
 * 解析不了就**失败**而不是跳过（跳过 = 又一个不会红的门）。
 */

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

function cssOf(palette: string): string {
    return readFileSync(join(THEMES, "color-shadcn-" + palette + ".css"), "utf8");
}
const PALETTES = ["neutral", "gray", "slate", "stone", "zinc"] as const;
const SURFACES = ["--background", "--card", "--popover", "--muted", "--sidebar"] as const;
const MIN_RATIO = 3.1;

/** 浏览器实测值（2026-11-13，Chromium，canvas 合成 + WCAG 相对亮度，取 5 底面最差）。
 *  它们的作用是**校验本文件里的色彩数学**：算错了这里先红，而不是等有人拿它去挡真回归。 */
const MEASURED: Record<string, number> = {
    "light/neutral": 3.136,
    "light/gray": 3.184,
    "light/slate": 3.14,
    "light/stone": 3.182,
    "light/zinc": 3.135,
    "dark/neutral": 3.192,
    "dark/gray": 3.184,
    "dark/slate": 3.172,
    "dark/stone": 3.108,
    "dark/zinc": 3.141,
};

function requireFromVite(id: string): unknown {
    const base = createRequire(import.meta.url);
    try {
        return base(id);
    } catch {
        const vitePath = base.resolve("vite");
        return createRequire(vitePath)(id);
    }
}

type Decls = Record<string, string>;

function parseThemeCss(palette: string): { light: Decls; dark: Decls } {
    const postcss = requireFromVite("postcss") as {
        parse: (css: string) => { walkRules: (cb: (rule: any) => void) => void };
    };
    if (!postcss?.parse) throw new Error("postcss 解析不可用：拒绝静默跳过本门（D-1162 ③）");
    const root = postcss.parse(cssOf(palette));
    const light: Decls = {};
    const dark: Decls = {};
    root.walkRules((rule: any) => {
        const sel = String(rule.selector || "");
        if (!/html\[data-xh-color=/.test(sel)) return;
        const target = sel.includes(".dark") ? dark : light;
        for (const node of rule.nodes || []) {
            if (node.type === "decl" && String(node.prop).startsWith("--")) {
                target[node.prop] = String(node.value).trim();
            }
        }
    });
    if (Object.keys(light).length === 0) {
        const css = cssOf(palette);
        throw new Error(
            "解析 " +
                palette +
                " 失败：css 长度 " +
                css.length +
                "，前 60 字符 " +
                JSON.stringify(css.slice(0, 60)),
        );
    }
    return { light, dark };
}

/** oklch(L C H[/ A]) → sRGB 8bit（与浏览器渲染同一条路：先 gamma 编码再取整） */
function oklchToRgb(value: string): { r: number; g: number; b: number; a: number } {
    const m = value.match(
        /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/i,
    );
    if (!m) throw new Error("看不懂的颜色值（本断言只接受 oklch）：" + value);
    const L = Number(m[1]) / (m[2] ? 100 : 1);
    const C = Number(m[3]) / (m[4] ? 100 : 1);
    const H = (Number(m[5]) * Math.PI) / 180;
    const a = m[6] === undefined ? 1 : Number(m[6]) / (m[7] ? 100 : 1);
    const A = C * Math.cos(H);
    const B = C * Math.sin(H);
    const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
    const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
    const s_ = L - 0.0894841775 * A - 1.291485548 * B;
    const l = l_ ** 3;
    const mm = m_ ** 3;
    const s = s_ ** 3;
    const lin = [
        4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
    ];
    const enc = (v: number) => {
        const c = Math.min(1, Math.max(0, v));
        return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
    };
    return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]), a };
}

type Rgb = { r: number; g: number; b: number };

function over(fg: { r: number; g: number; b: number; a: number }, bg: Rgb): Rgb {
    return {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
    };
}

/** WCAG 2.x 相对亮度：8bit → gamma 解码 → 线性加权（与浏览器读数同口径） */
function luminance(c: Rgb): number {
    const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(a: Rgb, b: Rgb): number {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 一格的读数：`--input` 对 5 个底面各自合成后的最差比值 */
function worstRatio(decls: Decls): { worst: number; where: string; per: Record<string, number> } {
    const need = (k: string): string => {
        const v = decls[k];
        if (!v)
            throw new Error(
                "主题块缺 token " + k + "（已解析到：" + Object.keys(decls).length + " 个）",
            );
        return v;
    };
    const base = over(oklchToRgb(need("--background")), { r: 255, g: 255, b: 255 });
    const per: Record<string, number> = {};
    let worst = Number.POSITIVE_INFINITY;
    let where = "";
    for (const s of SURFACES) {
        const raw = oklchToRgb(need(s));
        const surface = raw.a > 0.99 ? raw : over(raw, base);
        const border = over(oklchToRgb(need("--input")), surface);
        const r = Math.round(contrast(border, surface) * 1000) / 1000;
        per[s] = r;
        if (r < worst) {
            worst = r;
            where = s;
        }
    }
    return { worst, where, per };
}

const cells = PALETTES.map((p) => {
    const { light, dark } = parseThemeCss(p);
    return {
        palette: p,
        light: { decls: light, ...worstRatio(light) },
        dark: { decls: dark, ...worstRatio(dark) },
    };
});

describe("--input 对比度（task-310）：10 格 × 5 底面，最差 ≥ 3.10", () => {
    it("10 格全部达标（暗色最差的 dark/stone 是刻意贴线的那一格）", () => {
        const bad = cells
            .flatMap((c) => [
                { key: "light/" + c.palette, ...c.light },
                { key: "dark/" + c.palette, ...c.dark },
            ])
            .filter((c) => c.worst < MIN_RATIO);
        expect(
            bad.map((b) => b.key + " = " + b.worst + "（最差底面 " + b.where + "）"),
            "低于 " +
                MIN_RATIO +
                " 的格子（改 token 前先读 evidence/2026-11-13-config-domain-selects §5）",
        ).toEqual([]);
    });

    it("色彩数学与浏览器实测一致（±0.01）—— 算错了这里先红", () => {
        const mine: Record<string, number> = {};
        for (const c of cells) {
            mine["light/" + c.palette] = c.light.worst;
            mine["dark/" + c.palette] = c.dark.worst;
        }
        for (const [key, want] of Object.entries(MEASURED)) {
            expect(
                Math.abs(mine[key] - want),
                key + "：本文件算出 " + mine[key] + "，浏览器实测 " + want,
            ).toBeLessThanOrEqual(0.01);
        }
    });

    it("反例自检：把任一格改回改前值 ⇒ 断言必须变红（否则这条门是假的）", () => {
        const { light } = parseThemeCss("neutral");
        const before = { ...light, "--input": "oklch(0.66 0 0)" };
        const r = worstRatio(before);
        expect(r.worst).toBeLessThan(MIN_RATIO);
        expect(r.worst).toBeLessThan(3);
        // 分母选错的现场：改前值对**纯白 #fff** 算是过 3:1 的（旧注释就是这么写出"3.11"的），
        // 对真底面 oklch(0.97) 只有 2.854、对 --muted 2.54 ⇒ 分母选错方向会系统性掩盖问题（D-1139）。
        const white = { r: 255, g: 255, b: 255 };
        const onWhite = contrast(over(oklchToRgb("oklch(0.66 0 0)"), white), white);
        expect(Math.round(onWhite * 1000) / 1000).toBeGreaterThan(3);
        expect(r.per["--background"]).toBeLessThan(3);
    });
});
