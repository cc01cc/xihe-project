/**
 * PLAN-0631 色彩方案 / 视觉语言候选的**颜色探针**（真实计算样式 + WCAG 对比度）。
 *
 * 为什么单独成文件：颜色数学（oklch/oklab/color-mix → sRGB、alpha 合成、WCAG 2.x）
 * 已经出现过两份近似实现，第三份就该抽出来。这里只做纯函数 + 一个"读某元素的
 * 计算样式与祖先底色"的探针，不做断言 —— 阈值留在各 spec 里，便于同一套数学被
 * 不同 lane（视觉语言 / 色彩方案）复用。
 *
 * 注意：页面里的 `getComputedStyle` 可能给出 `oklch()`、`oklab()`（`color-mix` 的
 * 结果）、`rgb()` 或 hex；解析不了就抛错，宁可红也不要把对比度静默算成 1:1。
 */
import type { Page } from "@playwright/test";

export interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

export interface ElementProbe {
    found: true;
    tag: string;
    testId: string;
    label: string;
    text: string;
    background: string;
    color: string;
    borderTopColor: string;
    borderTopWidth: number;
    borderBottomColor: string;
    borderBottomWidth: number;
    outlineColor: string;
    outlineWidthPx: number;
    outlineStyle: string;
    boxShadow: string;
    borderRadiusPx: number;
    fontSizePx: number;
    lineHeightPx: number;
    /** 由近到远的非透明底色栈（含元素自身）。 */
    backgrounds: string[];
    rect: { x: number; y: number; width: number; height: number };
}

function encodeChannel(value: number): number {
    const clamped = Math.min(1, Math.max(0, value));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
}

/** `oklab(L a b)` → sRGB（CSS Color 4 参考矩阵）。 */
function oklabToSrgb(lightness: number, a: number, b: number): Rgba {
    const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
    const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
    const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
    const l = lPrime ** 3;
    const m = mPrime ** 3;
    const s = sPrime ** 3;
    return {
        r: encodeChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        g: encodeChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        b: encodeChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
        a: 1,
    };
}

function parseAlpha(raw: string | undefined): number {
    if (!raw) return 1;
    return raw.endsWith("%")
        ? Number.parseFloat(raw) / 100
        : Math.min(1, Math.max(0, Number.parseFloat(raw)));
}

export function parseColor(raw: string): Rgba {
    const value = raw.trim().toLowerCase();
    const oklch =
        /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(
            value,
        );
    if (oklch) {
        const lightness = oklch[1].endsWith("%")
            ? Number.parseFloat(oklch[1]) / 100
            : Number.parseFloat(oklch[1]);
        const hue = (Number.parseFloat(oklch[3]) * Math.PI) / 180;
        const chroma = Number.parseFloat(oklch[2]);
        const color = oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
        color.a = parseAlpha(oklch[4]);
        return color;
    }
    const oklab =
        /^oklab\(\s*([\d.]+%?)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(value);
    if (oklab) {
        const lightness = oklab[1].endsWith("%")
            ? Number.parseFloat(oklab[1]) / 100
            : Number.parseFloat(oklab[1]);
        const color = oklabToSrgb(
            lightness,
            Number.parseFloat(oklab[2]),
            Number.parseFloat(oklab[3]),
        );
        color.a = parseAlpha(oklab[4]);
        return color;
    }
    const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(
        value,
    );
    if (srgb) {
        return {
            r: Math.round(Number.parseFloat(srgb[1]) * 255),
            g: Math.round(Number.parseFloat(srgb[2]) * 255),
            b: Math.round(Number.parseFloat(srgb[3]) * 255),
            a: parseAlpha(srgb[4]),
        };
    }
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(
        value,
    );
    if (rgb) {
        return {
            r: Number.parseFloat(rgb[1]),
            g: Number.parseFloat(rgb[2]),
            b: Number.parseFloat(rgb[3]),
            a: parseAlpha(rgb[4]),
        };
    }
    const hex = /^#([0-9a-f]{6})$/.exec(value);
    if (hex) {
        return {
            r: Number.parseInt(hex[1].slice(0, 2), 16),
            g: Number.parseInt(hex[1].slice(2, 4), 16),
            b: Number.parseInt(hex[1].slice(4, 6), 16),
            a: 1,
        };
    }
    throw new Error(`unsupported color value: ${raw}`);
}

export function over(fg: Rgba, bg: Rgba): Rgba {
    if (fg.a >= 1) return fg;
    const alpha = Math.max(0, fg.a);
    return {
        r: fg.r * alpha + bg.r * (1 - alpha),
        g: fg.g * alpha + bg.g * (1 - alpha),
        b: fg.b * alpha + bg.b * (1 - alpha),
        a: 1,
    };
}

/** 背景栈（由近到远）合成成一个不透明色。 */
export function resolveBackground(stack: string[]): Rgba {
    let result: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        result = over(parseColor(stack[index]), result);
    }
    return result;
}

export function luminance(color: Rgba): number {
    const channel = (value: number): number => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.x 对比度；前景带 alpha 时先合成到背景上。 */
export function contrastRatio(foreground: string, background: string[]): number {
    const bg = resolveBackground(background);
    const fg = over(parseColor(foreground), bg);
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const [light, dark] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return Number(((light + 0.05) / (dark + 0.05)).toFixed(2));
}

/** 两个颜色的 WCAG 对比度（都用不透明色）。 */
export function contrastBetween(a: string, b: string): number {
    return contrastRatio(a, [b]);
}

/** 从 `outlineColor` / `boxShadow` 这类串里取出第一个**可解析的**颜色。 */
export function firstColorIn(text: string): string | null {
    for (const match of text.matchAll(/[\w-]+\([^)]*\)/g)) {
        try {
            parseColor(match[0]);
            return match[0];
        } catch {
            continue;
        }
    }
    return null;
}

/** HSL 色相（0-360）与饱和度（0-100），用于"色相是否可区分"的判定。 */
export function hsl(color: string): { h: number; s: number; l: number } {
    const { r, g, b } = parseColor(color);
    const rn = r / 255,
        gn = g / 255,
        bn = b / 255;
    const max = Math.max(rn, gn, bn),
        min = Math.min(rn, gn, bn);
    const delta = max - min;
    const l = (max + min) / 2;
    const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (delta !== 0) {
        if (max === rn) h = ((gn - bn) / delta) % 6;
        else if (max === gn) h = (bn - rn) / delta + 2;
        else h = (rn - gn) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: Number((s * 100).toFixed(1)), l: Number((l * 100).toFixed(1)) };
}

/** 两色的色相距离（0-180）。低饱和色（近灰）的色相无意义，调用方先用 s 判掉。 */
export function hueDistance(a: string, b: string): number {
    const diff = Math.abs(hsl(a).h - hsl(b).h) % 360;
    return Number((diff > 180 ? 360 - diff : diff).toFixed(1));
}

/**
 * 读一个**可见**元素的计算样式与祖先底色栈（由近到远）。
 * 页面里不做颜色数学：`oklab`/`color-mix` 在不同浏览器里形态不同，交给 Node 侧合成。
 *
 * `backgroundsFrom: "parent"` 用于**焦点环**：outline 画在边框盒之外，落在父级表面上；
 * 若从元素自身取底色，会把"深色按钮 + 同色环"算成 1:1（假失败）。
 */
export async function probe(
    page: Page,
    selector: string,
    options: { backgroundsFrom?: "self" | "parent" } = {},
): Promise<ElementProbe> {
    return page.evaluate(
        ({ sel, backgroundsFrom }) => {
            const visible = (element: Element | null): element is HTMLElement => {
                if (!(element instanceof HTMLElement)) return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && element.offsetParent !== null;
            };
            let element: Element | null = null;
            for (const candidate of Array.from(document.querySelectorAll(sel))) {
                if (visible(candidate)) {
                    element = candidate;
                    break;
                }
            }
            if (!(element instanceof HTMLElement)) {
                throw new Error(`no visible element for selector: ${sel}`);
            }
            const style = getComputedStyle(element);
            const px = (value: string) => Number.parseFloat(value);
            const backgrounds: string[] = [];
            const collect = (node: Element | null): void => {
                let current: Element | null = node;
                while (current) {
                    const bg = getComputedStyle(current).backgroundColor;
                    if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)")
                        backgrounds.push(bg);
                    current = current.parentElement;
                }
            };
            collect(backgroundsFrom === "parent" ? element.parentElement : element);
            const rect = element.getBoundingClientRect();
            const text = (element.getAttribute("aria-label") ?? element.textContent ?? "")
                .replace(/\s+/g, " ")
                .trim();
            return {
                found: true as const,
                tag: element.tagName.toLowerCase(),
                testId: element.getAttribute("data-testid") ?? "",
                label: text.slice(0, 60),
                text,
                background: style.backgroundColor,
                color: style.color,
                borderTopColor: style.borderTopColor,
                borderTopWidth: px(style.borderTopWidth),
                borderBottomColor: style.borderBottomColor,
                borderBottomWidth: px(style.borderBottomWidth),
                outlineColor: style.outlineColor,
                outlineWidthPx: px(style.outlineWidth),
                outlineStyle: style.outlineStyle,
                boxShadow: style.boxShadow,
                borderRadiusPx: px(style.borderTopLeftRadius),
                fontSizePx: px(style.fontSize),
                lineHeightPx: px(style.lineHeight),
                backgrounds,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
        },
        { sel: selector, backgroundsFrom: options.backgroundsFrom ?? "self" },
    );
}

/** 当前键盘焦点的探针（焦点环画在父级表面上，所以底色从 parent 起算）。 */
export async function probeActive(page: Page): Promise<ElementProbe> {
    return probe(page, ":focus", { backgroundsFrom: "parent" });
}
