/**
 * task-74：颜色数学纯函数（零依赖，`styles/__tests__` 下的多份 spec 共用）。
 *
 * <p>为什么不直接读浏览器算好的值：本仓色值源码是 oklch（CSS 变量），jsdom 里没有真实合成器，
 * `getComputedStyle` 拿不到「合成到某个底面上」的像素 ⇒ 只能自己算。算法集中在这里，
 * `input-contrast.spec.ts`（用浏览器实测 3.136 锚定 `--input`）与本 spec 走同一份数学，
 * 避免两份实现各自漂移。</p>
 *
 * <p>依据：CSS Color 4 的 oklch → oklab → 线性 sRGB 矩阵与 transfer function；
 * WCAG 2.2 §relative luminance 与 `(L1+0.05)/(L2+0.05)`。矩阵常数照抄规范，勿「顺手优化」。</p>
 */

export type Rgb = { r: number; g: number; b: number };
export type Rgba = Rgb & { alpha: number };
export type Oklch = { l: number; c: number; h: number; alpha: number };

/**
 * `oklch(L C H)` / `oklch(L C H / A)`；L 与 A 都可带 `%`。
 * 解析不了返回 null —— 调用方负责报错，不许静默跳过（跳过 = 又一个不会红的门）。
 */
const OKLCH_RE =
    /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/;

export function parseOklch(raw: string): Oklch | null {
    const m = OKLCH_RE.exec(raw.trim());
    if (!m) return null;
    const l = m[2] === "%" ? Number(m[1]) / 100 : Number(m[1]);
    const alpha = m[5] === undefined ? 1 : m[6] === "%" ? Number(m[5]) / 100 : Number(m[5]);
    return { l, c: Number(m[3]), h: Number(m[4]), alpha };
}

/** oklch → 8bit sRGB（每通道 `Math.round`，与浏览器 deliver 到 canvas 的口径一致）。 */
export function oklchToRgba(raw: string): Rgba | null {
    const v = parseOklch(raw);
    if (!v) return null;
    const hRad = (v.h * Math.PI) / 180;
    const a = v.c * Math.cos(hRad);
    const b = v.c * Math.sin(hRad);
    // oklab → 立方后的 LMS
    const l3 = (v.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m3 = (v.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s3 = (v.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    // 立方后的 LMS → 线性 sRGB（CSS Color 4 常数，直接作用在 l3/m3/s3 上，不再过 XYZ）
    const lin = [
        4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
        -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
        -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
    ];
    const encode = (channel: number): number => {
        const clipped = Math.min(1, Math.max(0, channel));
        const srgb = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
        return Math.round(srgb * 255);
    };
    return { r: encode(lin[0]), g: encode(lin[1]), b: encode(lin[2]), alpha: v.alpha };
}

/** source-over 合成到**不透明**底面（本仓底色恒不透明；半透明 token 只有这样才可比）。 */
export function compositeOver(fg: Rgba, backdrop: Rgb): Rgb {
    const mix = (f: number, b: number): number => Math.round(f * fg.alpha + b * (1 - fg.alpha));
    return { r: mix(fg.r, backdrop.r), g: mix(fg.g, backdrop.g), b: mix(fg.b, backdrop.b) };
}

/** WCAG 2.2 相对亮度（先反 transfer，再按 0.2126/0.7152/0.0722 加权）。 */
export function relativeLuminance(rgb: Rgb): number {
    const linear = (v: number): number => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** WCAG 对比度，1..21。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 只要 3 位小数（读数是给人看的，别贴 16 位浮点）。 */
export function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

/** 展开 `var(--x)` 链（本仓 `--ring: var(--primary)`）；解析不出/成环返回 null，不返回半截值。 */
export function resolveToken(decls: ReadonlyMap<string, string>, name: string): string | null {
    let current = decls.get(name);
    if (current === undefined) return null;
    for (let depth = 0; depth < 8; depth += 1) {
        const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(current.trim());
        if (!m) return current.trim();
        const next = decls.get(m[1]);
        if (next === undefined) return null;
        current = next;
    }
    return null;
}

/** 便捷：token 原文（已展开 var 链）；不可解析即抛，禁止静默跳过。 */
export function tokenSource(decls: ReadonlyMap<string, string>, name: string): string {
    const raw = resolveToken(decls, name);
    if (raw === null) throw new Error("token 不可解析：" + name);
    return raw;
}

/** 便捷：token → 带 alpha 的 sRGB（`--border: oklch(1 0 0 / 10%)` 需要先合成）。 */
export function tokenToRgba(decls: ReadonlyMap<string, string>, name: string): Rgba {
    const raw = tokenSource(decls, name);
    const rgba = oklchToRgba(raw);
    if (rgba === null) throw new Error("token 不是 oklch 字面量：" + name + " = " + raw);
    return rgba;
}

/** 便捷：token → 不透明 sRGB（丢掉 alpha）。 */
export function tokenToRgb(decls: ReadonlyMap<string, string>, name: string): Rgb {
    const rgba = tokenToRgba(decls, name);
    return { r: rgba.r, g: rgba.g, b: rgba.b };
}
