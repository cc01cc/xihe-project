// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0631 M2：视觉语言（**默认 = B 密集**；A 克制 / C 现状+ 只是 opt-in 覆盖）的
 * **真实截图 + 质量门**。
 *
 * 为什么是 spec 而不是 `scripts/shoot-*.mjs`：截图必须跑在"应用真的被 Vite 服务起来"
 * 的前提下，而 `e2e/playwright.config.ts` 已经带 baseURL + webServer（`pnpm dev`）。
 * 自写 mjs 要么重复这套启动逻辑，要么漏掉它 —— 后者正是任务书点名的
 * `Cannot navigate to invalid URL`（漏 `--config` 的后果）。所以用 mock lane 的 spec。
 *
 * 复现（默认 headless，**必须**给 `--config`）：
 *   cd packages/ui
 *   $env:XIHE_E2E_PROFILE = "mock"
 *   $env:XIHE_E2E_BROWSER_CHANNEL = "chrome-beta"   # 本机 Playwright 浏览器缓存不含对应
 *                                                  # revision 时用它（Chrome Beta 专供 Playwright）
 *   $env:XIHE_UI_PORT = "12650"                     # 可选：避免和别的车道抢 12630
 *   $env:XH_0631_SHOT_DIR = "H:/zeogit/one/.local/xh-d28/shots/0631"   # 可选
 *   pnpm exec playwright test --config e2e/playwright.config.ts `
 *       e2e/mock/plan-0631-variants.spec.ts --reporter=list
 *
 * 这个 spec 同时是**质量门**，不是"截图完事"：
 * - 0 console error / 0 pageerror（默认态 + A/C × 两个页面，各自断言）；
 * - **默认 = B**：无 `?variant=` 时断言无属性，且关键 token 等于 B —— 正文 14px/行高 1.55、
 *   圆角主档 10px、`--spacing` = 0.875 步进（0.21875rem）、强调色 `#3b5bd0`。
 *   数值依据 **2026-11-06 用户裁定 A″ 整体固化**（正文 14px·1.55 + 圆角 10px + 中性冷白/蓝拆分）。
 *   **用 `getComputedStyle` 断言，不做截图比对**（Windows 上截图断言会被跳过，
 *   截图只作为报告产物）；
 * - A/C 仍可覆盖：`?variant=a` / `?variant=c` 的属性与实测值逐项断言；
 * - 旧持久化值迁移：预置 localStorage `xihe-visual-variant = "c"` 后刷新，键必须被清除、
 *   渲染必须回到默认 B；`?variant=b` 是默认的别名（不投影属性）；
 * - 对比度**实测**：正文/次级文字/强调色上的文字 ≥ 4.5:1，焦点环 ≥ 3:1（WCAG 1.4.11）；
 * - 焦点环可见：键盘 Tab 聚焦真实控件后读 `outline` / `box-shadow`，并截局部图。
 *
 * 产物落在 git 之外（默认 `<repo>/../.local/xh-d28/shots/0631/`，可用 env 覆盖），
 * 每张图旁边有 `measure/<name>.json`，对比表里的数字全部来自这些文件。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { openContextPanel } from "../helpers/context-panel";
import { LONG_TIMEOUT_MS } from "../timeouts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `packages/ui/e2e/mock` → 上 5 级 = 仓库根（worktree 里是 worktree 根），再进 `.local`。 */
const SHOT_DIR = process.env.XH_0631_SHOT_DIR
    ? path.resolve(process.env.XH_0631_SHOT_DIR)
    : path.resolve(HERE, "../../../../../.local/xh-d28/shots/0631");

interface VariantCase {
    /** 文件名前缀（A-chat.png）。 */
    id: "A" | "B" | "C";
    /** `?variant=` 的取值。 */
    param: "a" | "b" | "c";
    name: string;
    /** 正文元素实测字号（px）。 */
    bodyFontPx: number;
    /** 正文元素实测行高（px）。 */
    lineHeightPx: number;
    /** `rounded-lg` 控件实测圆角（px）= `--radius`。 */
    controlRadiusPx: number;
}

/** 默认视觉语言 = B（密集，用户 2026-11-03 圈选）。无参数时量到的必须是这些值。 */
const DEFAULT_B = {
    name: "密集",
    bodyFontPx: 14,
    lineHeightPx: 21.7,
    controlRadiusPx: 10,
    /** 0.25rem × 0.875 = 3.5px 步进。 */
    spacing: "0.21875rem",
    radius: "0.625rem",
    textSm: "0.875rem",
    brand: "#3b5bd0",
    foreground: "#16181d",
    mutedForeground: "#64686f",
} as const;

/**
 * A/C **仅用于对比与回归，非发布默认**：只在 `?variant=a|c` 下生效。
 * B 不再作为候选 case —— 它就是无参数时的默认，由下面的 `default = B` 用例断言。
 */
const VARIANTS: VariantCase[] = [
    { id: "A", param: "a", name: "克制", bodyFontPx: 14, lineHeightPx: 23.8, controlRadiusPx: 8 },
    { id: "C", param: "c", name: "现状+", bodyFontPx: 14, lineHeightPx: 21, controlRadiusPx: 8 },
];

const SESSION_ID = "vis-session";
const DRAFT = "先跑 mock 车道，再看三个候选的截图。";

/** 同一份数据：多轮对话（含列表与行内代码），让密度差异在正文上直接可见。 */
const MESSAGES: Record<string, Array<Record<string, unknown>>> = {
    [SESSION_ID]: [
        {
            id: "msg-1",
            sessionId: SESSION_ID,
            role: "USER",
            content: "把工作区的依赖升级到最新，然后跑一遍 mock 车道，把失败项列出来。",
            createdAt: "2026-11-03T02:10:00.000Z",
        },
        {
            id: "msg-2",
            sessionId: SESSION_ID,
            role: "ASSISTANT",
            content: [
                "好的，我先核对当前版本，再逐包升级并跑 `test:mock`。",
                "",
                "1. `packages/ui` 的 lock 与 store 一致，无需重新解析；",
                "2. CP 侧只改测试依赖，不动 Flyway 迁移；",
                "3. mock 车道在独立端口起 Vite，跑完自动回收。",
                "",
                "失败项我会按「spec 文件 × 首个错误」归并，不逐条贴日志。",
            ].join("\n"),
            createdAt: "2026-11-03T02:10:20.000Z",
        },
        {
            id: "msg-3",
            sessionId: SESSION_ID,
            role: "USER",
            content: "截图页也一起看下：聊天页要开着右侧 dock 的会话设置。",
            createdAt: "2026-11-03T02:11:00.000Z",
        },
        {
            id: "msg-4",
            sessionId: SESSION_ID,
            role: "ASSISTANT",
            content: [
                "已经打开 dock 的「会话设置」标签，四个分区（审批模式 / 上下文模板 / 上下文源 / 分支）都在。",
                "",
                "顺带说明：这三个候选只改 CSS 变量集，组件代码一行没动 —— 所以截图里的差别，",
                "就是「气质与密度」的差别，不是功能差别。",
            ].join("\n"),
            createdAt: "2026-11-03T02:11:30.000Z",
        },
    ],
};

const CONFIG_DOMAINS: Record<string, Record<string, string>> = {
    "llm-provider": { profile: '{"providerId":"deepseek","connectionKey":"default"}' },
    "context-policy": { defaults: '{"softThresholdPct":0.8}' },
    embedding: { model: "text-embedding-3-small", dimensions: "1536" },
    rag: { chunkSize: "1000", chunkOverlap: "200", topK: "5", minScore: "0.35" },
    "agent-runtime": { useRegistry: "true", useSupervisor: "false" },
    "agent-profile": { userName: "zero" },
    "user-preference": { theme: "dark" },
    logging: { logLevel: "INFO", levelCp: "DEBUG", levelUi: "INFO" },
    "approval-policy": { mode: "manual" },
    "job-policy": { defaultTimeoutSecs: "300", maxTimeoutSecs: "1800" },
};

/** 浅色候选 + 管理员能力：`/settings/config` 的 instance 层需要 `isInstanceAdmin`。 */
async function prepareAuth(page: Page): Promise<void> {
    await setupMockAuth(page);
    await page.addInitScript(() => {
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({
                id: "user-1",
                email: "test@xihe.local",
                name: "Test User",
                capabilities: {
                    isInstanceAdmin: true,
                    isInstanceSuper: true,
                    workspaceAdminOf: ["workspace-1"],
                },
            }),
        );
    });
}

/**
 * 会话投影 fixture：`setupMockSessions` 对 `/sessions/{id}/{suffix}` 的未知后缀回答 404，
 * 而聊天列会主动拉 `derived-state` 与 `follow-ups` —— 缺 fixture 时页面会真的 console.error
 * （"0 console error" 门就会红，且红的原因是 fixture 缺口而不是 UI 缺陷）。
 */
async function mockSessionProjections(page: Page, sessionId: string): Promise<void> {
    await page.route(`**/api/v1/sessions/${sessionId}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, activeChildren: [], terminalNotices: [] }),
        });
    });
    await page.route(`**/api/v1/sessions/${sessionId}/follow-ups`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId,
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 5,
                pauseReason: null,
                items: [],
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${sessionId}/participants`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ participants: [] }),
        });
    });
    await page.route(`**/api/v1/sessions/${sessionId}/commands`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ commands: [] }),
        });
    });
}

/** 配置页 fixture：层视图（带 entries）+ 逐键 meta（来源/锁定）。 */
async function mockConfigApis(page: Page): Promise<void> {
    await page.route("**/api/v1/config/**", async (route) => {
        const url = new URL(route.request().url());
        const parts = url.pathname.split("/").filter(Boolean);
        const domain = parts[2] === "config" ? (parts[3] ?? "") : "";
        const layer = url.searchParams.get("layer") ?? "instance";
        if (route.request().method() === "PUT") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ status: "ok", keys: 1 }),
            });
            return;
        }
        const entries = CONFIG_DOMAINS[domain] ?? {};
        if (parts.at(-1) === "meta") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    domain,
                    layer,
                    keys: Object.keys(entries).map((key) => ({
                        key,
                        source: layer,
                        locked: false,
                        writable: true,
                        reason: null,
                        instanceEligible: true,
                        defaultPresent: false,
                        overridable: true,
                    })),
                }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
                url.searchParams.has("layer") || url.searchParams.has("includeMeta")
                    ? { domain, entries, envOverridden: {} }
                    : entries,
            ),
        });
    });
}

/**
 * 默认态与两个 opt-in 覆盖都必须 0 console error / 0 pageerror —— 收集器在导航前挂上。
 *
 * 同时收集 `4xx/5xx` 响应作为**诊断**（不进断言）：Chrome 的
 * "Failed to load resource: … 404" 不带 URL，只凭它无法判断是 fixture 缺口还是 UI 缺陷。
 * 预期内的 404（如 `/workspaces/current` 在 mock 里是"没有活动工作区"）不能直接算失败，
 * 所以这里只把它们拼进断言消息。
 */
function collectErrors(page: Page): { errors: string[]; http: string[] } {
    const errors: string[] = [];
    const http: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("response", (response) => {
        if (response.status() >= 400) http.push(`${response.status()} ${response.url()}`);
    });
    return { errors, http };
}

interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
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

/**
 * 把 `getComputedStyle` 给出的颜色串解析成 sRGB。
 * 候选里颜色可能来自 hex（→ `rgb()`）、`oklch()`，Tailwind 的 `/50` 透明度会落成
 * `color-mix` → 浏览器算出的 `oklab(… / 0.5)`。解析不了就抛错 —— 宁可红，
 * 也不要静默把对比度算成 1:1。
 */
function parseColor(raw: string): Rgba {
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

function over(fg: Rgba, bg: Rgba): Rgba {
    if (fg.a >= 1) return fg;
    const alpha = Math.max(0, fg.a);
    return {
        r: fg.r * alpha + bg.r * (1 - alpha),
        g: fg.g * alpha + bg.g * (1 - alpha),
        b: fg.b * alpha + bg.b * (1 - alpha),
        a: 1,
    };
}

/**
 * 背景栈（由近到远）合成成一个不透明色。
 * `bg-muted/50` 这类半透明层必须先叠到下层再算对比度，否则会把 50% 的灰当成实色。
 */
function resolveBackground(stack: string[]): Rgba {
    let result: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        result = over(parseColor(stack[index]), result);
    }
    return result;
}

function luminance(color: Rgba): number {
    const channel = (value: number): number => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.x 对比度；前景带 alpha 时先合成到背景上（不允许把透明当纯色算）。 */
function contrastRatio(foreground: string, background: string[]): number {
    const bg = resolveBackground(background);
    const fg = over(parseColor(foreground), bg);
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const [light, dark] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return Number(((light + 0.05) / (dark + 0.05)).toFixed(2));
}

/**
 * 从 `outlineColor` / `boxShadow` 这类可能混着长度、关键字、多个阴影的串里取出第一个
 * **可解析的颜色**。不用正则猜格式：候选里 ring 可能落在 oklch / oklab / rgb 任一形态，
 * 猜错会把"焦点环不可解析"报成真失败（也会把真失败报成绿）。
 */
function firstColorIn(text: string): string | null {
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

interface Measurement {
    variant: string | null;
    tokens: Record<string, string>;
    text: {
        fontSizePx: number;
        lineHeightPx: number;
        color: string;
        backgrounds: string[];
    };
    control: { borderRadiusPx: number; background: string; color: string };
    listRowHeightPx: number | null;
    focus: {
        tag: string;
        testId: string;
        label: string;
        outlineWidthPx: number;
        outlineStyle: string;
        outlineColor: string;
        boxShadow: string;
        /** 焦点环画在**父级表面**上（outline-offset / ring 都在边框盒之外）。 */
        backgrounds: string[];
    } | null;
}

/** 在页面里读真实计算样式（不是读 CSS 源码，也不是读快照）。 */
async function measure(
    page: Page,
    textSelector: string,
    controlSelector: string,
    listRowSelector: string | null,
    withFocus: boolean,
): Promise<Measurement> {
    return page.evaluate(
        ({
            textSelector: textSel,
            controlSelector: controlSel,
            listRowSelector: rowSel,
            withFocus,
        }) => {
            const root = document.documentElement;
            const rootStyle = getComputedStyle(root);
            const token = (name: string) => rootStyle.getPropertyValue(name).trim();
            const px = (value: string) => Number.parseFloat(value);
            const visible = (element: Element | null): element is HTMLElement => {
                if (!(element instanceof HTMLElement)) return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && element.offsetParent !== null;
            };
            /**
             * 逐级向上收集非透明底色（由近到远），交给 Node 侧合成 —— 页面里不做颜色数学，
             * 避免 `oklab` / `color-mix` 在不同浏览器里给出不同形态时算错。
             */
            const backgroundsOf = (element: Element | null): string[] => {
                const stack: string[] = [];
                let node: Element | null = element;
                while (node) {
                    const bg = getComputedStyle(node).backgroundColor;
                    if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") stack.push(bg);
                    node = node.parentElement;
                }
                return stack;
            };
            const pickVisible = (selector: string): HTMLElement => {
                for (const candidate of Array.from(document.querySelectorAll(selector))) {
                    if (visible(candidate)) return candidate;
                }
                throw new Error(`no visible element for selector: ${selector}`);
            };

            const textElement = pickVisible(textSel);
            const textStyle = getComputedStyle(textElement);
            const controlElement = pickVisible(controlSel);
            const controlStyle = getComputedStyle(controlElement);
            const rowElement = rowSel
                ? Array.from(document.querySelectorAll(rowSel)).find(visible)
                : undefined;

            let focus: Measurement["focus"] = null;
            if (withFocus) {
                const active = document.activeElement;
                if (!(active instanceof HTMLElement)) throw new Error("nothing focused");
                const focusStyle = getComputedStyle(active);
                focus = {
                    tag: active.tagName.toLowerCase(),
                    testId: active.getAttribute("data-testid") ?? "",
                    label: (active.getAttribute("aria-label") ?? active.textContent ?? "")
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, 40),
                    outlineWidthPx: px(focusStyle.outlineWidth),
                    outlineStyle: focusStyle.outlineStyle,
                    outlineColor: focusStyle.outlineColor,
                    boxShadow: focusStyle.boxShadow,
                    backgrounds: backgroundsOf(active.parentElement),
                };
            }

            return {
                variant: root.getAttribute("data-xh-variant"),
                tokens: {
                    background: token("--background"),
                    foreground: token("--foreground"),
                    mutedForeground: token("--muted-foreground"),
                    brand: token("--brand"),
                    brandForeground: token("--brand-foreground"),
                    ring: token("--ring"),
                    textSm: token("--text-sm"),
                    spacing: token("--spacing"),
                    radius: token("--radius"),
                },
                text: {
                    fontSizePx: px(textStyle.fontSize),
                    lineHeightPx: px(textStyle.lineHeight),
                    color: textStyle.color,
                    backgrounds: backgroundsOf(textElement),
                },
                control: {
                    borderRadiusPx: px(controlStyle.borderTopLeftRadius),
                    background: controlStyle.backgroundColor,
                    color: controlStyle.color,
                },
                listRowHeightPx: rowElement
                    ? Number(rowElement.getBoundingClientRect().height.toFixed(1))
                    : null,
                focus,
            };
        },
        { textSelector, controlSelector, listRowSelector, withFocus },
    );
}

function writeMeasure(name: string, payload: unknown): void {
    const dir = path.join(SHOT_DIR, "measure");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function shoot(page: Page, name: string): Promise<string> {
    mkdirSync(path.dirname(path.join(SHOT_DIR, name)), { recursive: true });
    const file = path.join(SHOT_DIR, name);
    await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
    return file;
}

/**
 * 焦点环**局部图**：只截聚焦元素周围 ±16px，否则整屏图里 2px 的环根本看不清
 * （"焦点环可见"这种结论不该靠整屏缩略图目测）。
 */
async function shootFocus(page: Page, name: string): Promise<string> {
    const box = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return null;
        const rect = active.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (!box) throw new Error("no focused element to crop");
    // 至少 240×140：32px 的图标按钮 + 2px 环，纯裁剪出来只有 56px，报告里看不清。
    const width = Math.max(240, box.width + 96);
    const height = Math.max(140, box.height + 96);
    const x = Math.max(0, box.x + box.width / 2 - width / 2);
    const y = Math.max(0, box.y + box.height / 2 - height / 2);
    mkdirSync(path.dirname(path.join(SHOT_DIR, name)), { recursive: true });
    const file = path.join(SHOT_DIR, name);
    await page.screenshot({
        path: file,
        animations: "disabled",
        caret: "hide",
        clip: { x, y, width, height },
    });
    return file;
}

test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

test.describe("PLAN-0631 M2 visual variants", () => {
    for (const variant of VARIANTS) {
        test(`opt-in ${variant.id} (${variant.name}) — workspace chat with context dock`, async ({
            page,
        }) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            const { errors, http } = collectErrors(page);
            await prepareAuth(page);
            await setupMockSessions(page, {
                sessions: [{ id: SESSION_ID, title: "依赖升级与 mock 车道" }],
                messages: MESSAGES,
            });
            await mockSessionProjections(page, SESSION_ID);

            await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}?variant=${variant.param}`, {
                waitUntil: "load",
            });
            // 就绪用事件而不是时钟：composer 只在会话/分支投影落地后挂载。
            await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
            await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            // 真实输入（让发送按钮可用），再真实点击打开 dock 的 context 标签。
            await page.getByTestId("chat-input").fill(DRAFT);
            await openContextPanel(page);
            await expect(page.getByTestId("session-settings-expanded")).toBeVisible();

            // 键盘 Tab：从 composer 走到下一个可交互控件，读它的焦点指示。
            await page.getByTestId("chat-input").focus();
            await page.keyboard.press("Tab");

            const shot = await shoot(page, `${variant.id}-chat.png`);
            const focusShot = await shootFocus(page, `focus/${variant.id}-chat-focus.png`);

            const result = await measure(
                page,
                '[data-testid="message-item"] p, [data-testid="message-item"] .paragraph-node',
                '[data-testid="chat-send-button"]',
                null,
                true,
            );
            test.info().annotations.push({
                type: "focus-target",
                description: `${result.focus?.tag ?? "?"} ${result.focus?.testId ?? ""} ${
                    result.focus?.label ?? ""
                }`.trim(),
            });

            const bodyContrast = contrastRatio(result.text.color, result.text.backgrounds);
            const mutedContrast = contrastRatio(result.tokens.mutedForeground, [
                result.tokens.background,
            ]);
            const brandContrast = contrastRatio(result.tokens.brandForeground, [
                result.tokens.brand,
            ]);
            // 元素级：强调色按钮上的文字（不是只看 token）。
            const sendButtonContrast = contrastRatio(result.control.color, [
                result.control.background,
            ]);

            expect(result.variant, "opt-in 属性必须真的投影到 <html>").toBe(variant.param);
            expect(result.text.fontSizePx).toBeCloseTo(variant.bodyFontPx, 0);
            expect(result.text.lineHeightPx).toBeCloseTo(variant.lineHeightPx, 0);
            expect(result.control.borderRadiusPx).toBeCloseTo(variant.controlRadiusPx, 0);
            expect(bodyContrast, "正文 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(mutedContrast, "次级文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(brandContrast, "强调色上的文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(sendButtonContrast, "发送按钮文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);

            // 焦点环：键盘可达 + 可见（outline 或 ring 阴影二者其一），且与底色 ≥ 3:1。
            expect(result.focus, "Tab 后必须有聚焦元素").not.toBeNull();
            const focus = result.focus!;
            const hasOutline = focus.outlineStyle !== "none" && focus.outlineWidthPx >= 2;
            const hasRing = focus.boxShadow !== "none" && focus.boxShadow.length > 0;
            expect(hasOutline || hasRing, "焦点指示必须可见（outline 或 ring）").toBe(true);
            const focusColor = firstColorIn(hasOutline ? focus.outlineColor : focus.boxShadow);
            expect(
                focusColor,
                `焦点环颜色必须可解析（focus=${JSON.stringify(focus)}）`,
            ).not.toBeNull();
            const focusContrast = contrastRatio(focusColor!, focus.backgrounds);
            expect(
                focusContrast,
                `焦点环与背景 ≥ 3:1（WCAG 1.4.11，focus=${JSON.stringify(focus)}）`,
            ).toBeGreaterThanOrEqual(3);

            writeMeasure(`${variant.id}-chat`, {
                variant: variant.id,
                param: variant.param,
                page: "chat",
                shot,
                focusShot,
                contrast: {
                    body: bodyContrast,
                    muted: mutedContrast,
                    brand: brandContrast,
                    sendButton: sendButtonContrast,
                    focusRing: focusContrast,
                },
                measurement: result,
            });
            expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
        });

        test(`opt-in ${variant.id} (${variant.name}) — settings forms and lists`, async ({
            page,
        }) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            const { errors, http } = collectErrors(page);
            await prepareAuth(page);
            await mockConfigApis(page);

            // PLAN-0752 M1：设置区一页一域（层进 URL），密度/配色仍按同一批锚点量。
            // 两个域各展开一次以证明「表单与列表都吃变体」，测量与截图回到 logging 域（量的是它）。
            const fields: Record<string, string> = {
                rag: "config-field-rag-chunkSize",
                logging: "config-field-logging-logLevel",
            };
            for (const domain of ["rag", "logging"]) {
                await page.goto(`/settings/instance/${domain}?variant=${variant.param}`, {
                    waitUntil: "load",
                });
                await page.getByTestId(`config-domain-${domain}`).locator("button").first().click();
                await expect(page.getByTestId(fields[domain])).toBeVisible({
                    timeout: LONG_TIMEOUT_MS,
                });
            }
            await page.goto(`/settings/instance/logging?variant=${variant.param}`, {
                waitUntil: "load",
            });
            await page.getByTestId("config-domain-logging").locator("button").first().click();
            await expect(page.getByTestId(fields.logging)).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            // 点击域会把页面滚到被点元素；默认与 A/C 的密度不同 ⇒ 落点不同 ⇒ 截图不可比。
            // 统一回到顶部（全局路由由 `main` 自身滚动），让三张图从同一个位置开始。
            await page.evaluate(() => {
                document.scrollingElement?.scrollTo(0, 0);
                for (const element of document.querySelectorAll("main")) element.scrollTo(0, 0);
            });

            const shot = await shoot(page, `${variant.id}-settings.png`);
            // 正文档取域名行标题（`text-sm font-medium`，没有 `leading-*` 覆盖，行高来自阶梯）；
            // 圆角取域容器（`rounded-lg` → `--radius`）；行高取域名行本身。
            const result = await measure(
                page,
                '[data-testid="config-domain-logging"] > button',
                '[data-testid="config-domain-logging"]',
                '[data-testid="config-domain-logging"] > button',
                false,
            );

            const bodyContrast = contrastRatio(result.text.color, result.text.backgrounds);
            const mutedContrast = contrastRatio(result.tokens.mutedForeground, [
                result.tokens.background,
            ]);
            const brandContrast = contrastRatio(result.tokens.brandForeground, [
                result.tokens.brand,
            ]);

            expect(result.variant).toBe(variant.param);
            expect(result.text.fontSizePx).toBeCloseTo(variant.bodyFontPx, 0);
            expect(result.text.lineHeightPx).toBeCloseTo(variant.lineHeightPx, 0);
            expect(result.control.borderRadiusPx).toBeCloseTo(variant.controlRadiusPx, 0);
            expect(bodyContrast, "正文 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(mutedContrast, "次级文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(brandContrast, "强调色上的文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);

            writeMeasure(`${variant.id}-settings`, {
                variant: variant.id,
                param: variant.param,
                page: "settings",
                shot,
                contrast: { body: bodyContrast, muted: mutedContrast, brand: brandContrast },
                measurement: result,
            });
            expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
        });
    }

    test("default = B (密集) — workspace chat, no ?variant", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { errors, http } = collectErrors(page);
        await prepareAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "默认视觉语言 B" }],
            messages: MESSAGES,
        });
        await mockSessionProjections(page, SESSION_ID);

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`, { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        // 正文档必须真的渲染出来再量（消息投影是异步的，composer 先挂载）。
        await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await page.getByTestId("chat-input").fill(DRAFT);
        await openContextPanel(page);
        await expect(page.getByTestId("session-settings-expanded")).toBeVisible();

        // 键盘 Tab：从 composer 走到下一个可交互控件，读它的焦点指示。
        await page.getByTestId("chat-input").focus();
        await page.keyboard.press("Tab");

        const shot = await shoot(page, "default-chat.png");
        const focusShot = await shootFocus(page, "focus/default-chat-focus.png");

        const result = await measure(
            page,
            '[data-testid="message-item"] p, [data-testid="message-item"] .paragraph-node',
            '[data-testid="chat-send-button"]',
            null,
            true,
        );
        test.info().annotations.push({
            type: "focus-target",
            description: `${result.focus?.tag ?? "?"} ${result.focus?.testId ?? ""} ${
                result.focus?.label ?? ""
            }`.trim(),
        });

        const bodyContrast = contrastRatio(result.text.color, result.text.backgrounds);
        const mutedContrast = contrastRatio(result.tokens.mutedForeground, [
            result.tokens.background,
        ]);
        const brandContrast = contrastRatio(result.tokens.brandForeground, [result.tokens.brand]);
        const sendButtonContrast = contrastRatio(result.control.color, [result.control.background]);

        // 默认态的关键 token 必须 **等于 B**（用户 2026-11-03 圈选）。这条替代了旧的
        // "默认与改动前逐像素一致" —— 默认现在就应该长成 B，而不是维持旧外观。
        expect(result.variant, "默认不得投影任何 variant 属性").toBeNull();
        expect(result.text.fontSizePx, "B 正文 14px").toBeCloseTo(DEFAULT_B.bodyFontPx, 1);
        expect(result.text.lineHeightPx, "B 正文行高 1.55").toBeCloseTo(DEFAULT_B.lineHeightPx, 1);
        expect(result.control.borderRadiusPx, "B 主档圆角 10px").toBeCloseTo(
            DEFAULT_B.controlRadiusPx,
            1,
        );
        expect(result.tokens.spacing, "B 间距 0.875 步进（3.5px）").toBe(DEFAULT_B.spacing);
        expect(result.tokens.radius, "B --radius = 10px（A″ 固化）").toBe(DEFAULT_B.radius);
        expect(result.tokens.textSm, "B 正文阶梯 14px").toBe(DEFAULT_B.textSm);
        expect(result.tokens.brand, "B 唯一强调色 = brand token").toBe(DEFAULT_B.brand);
        expect(result.tokens.foreground, "B 正文色").toBe(DEFAULT_B.foreground);
        expect(result.tokens.mutedForeground, "B 次级文字色").toBe(DEFAULT_B.mutedForeground);

        expect(bodyContrast, "正文 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(mutedContrast, "次级文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(brandContrast, "强调色上的文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(sendButtonContrast, "发送按钮文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);

        // 焦点环：键盘可达 + 可见（outline 或 ring 阴影二者其一），且与底色 ≥ 3:1。
        expect(result.focus, "Tab 后必须有聚焦元素").not.toBeNull();
        const focus = result.focus!;
        const hasOutline = focus.outlineStyle !== "none" && focus.outlineWidthPx >= 2;
        const hasRing = focus.boxShadow !== "none" && focus.boxShadow.length > 0;
        expect(hasOutline || hasRing, "焦点指示必须可见（outline 或 ring）").toBe(true);
        const focusColor = firstColorIn(hasOutline ? focus.outlineColor : focus.boxShadow);
        expect(focusColor, `焦点环颜色必须可解析（focus=${JSON.stringify(focus)}）`).not.toBeNull();
        const focusContrast = contrastRatio(focusColor!, focus.backgrounds);
        expect(
            focusContrast,
            `焦点环与背景 ≥ 3:1（WCAG 1.4.11，focus=${JSON.stringify(focus)}）`,
        ).toBeGreaterThanOrEqual(3);

        writeMeasure("default-chat", {
            variant: "B",
            param: null,
            page: "chat",
            shot,
            focusShot,
            contrast: {
                body: bodyContrast,
                muted: mutedContrast,
                brand: brandContrast,
                sendButton: sendButtonContrast,
                focusRing: focusContrast,
            },
            measurement: result,
        });
        expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
    });

    test("default = B (密集) — settings forms and lists, no ?variant", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { errors, http } = collectErrors(page);
        await prepareAuth(page);
        await mockConfigApis(page);

        // 同上：一页一域。两个域各展开一次证明「表单与列表都吃默认密度」，测量与截图回到 logging 域。
        const fields: Record<string, string> = {
            rag: "config-field-rag-chunkSize",
            logging: "config-field-logging-logLevel",
        };
        for (const domain of ["rag", "logging"]) {
            await page.goto(`/settings/instance/${domain}`, { waitUntil: "load" });
            await page.getByTestId(`config-domain-${domain}`).locator("button").first().click();
            await expect(page.getByTestId(fields[domain])).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
        }
        await page.goto("/settings/instance/logging", { waitUntil: "load" });
        await page.getByTestId("config-domain-logging").locator("button").first().click();
        await expect(page.getByTestId(fields.logging)).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await page.evaluate(() => {
            document.scrollingElement?.scrollTo(0, 0);
            for (const element of document.querySelectorAll("main")) element.scrollTo(0, 0);
        });

        const shot = await shoot(page, "default-settings.png");
        const result = await measure(
            page,
            '[data-testid="config-domain-logging"] > button',
            '[data-testid="config-domain-logging"]',
            '[data-testid="config-domain-logging"] > button',
            false,
        );

        const bodyContrast = contrastRatio(result.text.color, result.text.backgrounds);
        const mutedContrast = contrastRatio(result.tokens.mutedForeground, [
            result.tokens.background,
        ]);
        const brandContrast = contrastRatio(result.tokens.brandForeground, [result.tokens.brand]);

        expect(result.variant, "默认不得投影任何 variant 属性").toBeNull();
        expect(result.text.fontSizePx, "B 正文 14px").toBeCloseTo(DEFAULT_B.bodyFontPx, 1);
        expect(result.text.lineHeightPx, "B 正文行高 1.55").toBeCloseTo(DEFAULT_B.lineHeightPx, 1);
        expect(result.control.borderRadiusPx, "B 主档圆角 10px").toBeCloseTo(
            DEFAULT_B.controlRadiusPx,
            1,
        );
        expect(result.tokens.spacing, "B 间距 0.875 步进（3.5px）").toBe(DEFAULT_B.spacing);
        expect(result.tokens.brand, "B 唯一强调色 = brand token").toBe(DEFAULT_B.brand);
        expect(bodyContrast, "正文 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(mutedContrast, "次级文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(brandContrast, "强调色上的文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);

        writeMeasure("default-settings", {
            variant: "B",
            param: null,
            page: "settings",
            shot,
            contrast: { body: bodyContrast, muted: mutedContrast, brand: brandContrast },
            measurement: result,
        });
        expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
    });

    test("legacy stored variant is cleared and ?variant=b aliases the default B", async ({
        page,
    }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { errors, http } = collectErrors(page);
        await prepareAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "旧持久化迁移" }],
            messages: MESSAGES,
        });
        await mockSessionProjections(page, SESSION_ID);

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`, { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });

        // 模拟对比期残留：旧版把 C 的选择写进了 localStorage。
        await page.evaluate(() => localStorage.setItem("xihe-visual-variant", "c"));
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        const stored = await page.evaluate(() => localStorage.getItem("xihe-visual-variant"));
        expect(stored, "旧持久化键必须被清除，否则会回落到已废弃的默认外观").toBeNull();

        const migrated = await measure(
            page,
            '[data-testid="message-item"] p, [data-testid="message-item"] .paragraph-node',
            '[data-testid="chat-send-button"]',
            null,
            false,
        );
        expect(migrated.variant, "迁移后不投影属性 = 默认 B").toBeNull();
        expect(migrated.text.fontSizePx).toBeCloseTo(DEFAULT_B.bodyFontPx, 1);
        expect(migrated.tokens.brand).toBe(DEFAULT_B.brand);

        // `?variant=b` 是「默认」的别名：不投影属性，渲染仍是 B。
        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}?variant=b`, {
            waitUntil: "load",
        });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        const alias = await measure(
            page,
            '[data-testid="message-item"] p, [data-testid="message-item"] .paragraph-node',
            '[data-testid="chat-send-button"]',
            null,
            false,
        );
        expect(alias.variant, "?variant=b 不投影属性").toBeNull();
        expect(alias.text.fontSizePx).toBeCloseTo(DEFAULT_B.bodyFontPx, 1);
        expect(alias.tokens.spacing).toBe(DEFAULT_B.spacing);
        expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
    });
});
