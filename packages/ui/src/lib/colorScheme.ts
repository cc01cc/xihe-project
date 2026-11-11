/**
 * 配色方案开关（task-48 / PLAN-0762 T3.1，用户 2026-11-11 裁定：**统一用 shadcn-vue 官方 5 个
 * base color，禁止自行调色**）。
 *
 * 五个方案 = 官方 `components.json → tailwind.baseColor` 的全集
 * （`neutral / gray / slate / stone / zinc`），取值来自
 * `https://www.shadcn-vue.com/r/colors/<base>.json` 的 `cssVarsV4`，原样落在
 * `styles/themes/color-shadcn-<base>.css`；唯一偏离官方值的是 `--ring` / `--sidebar-ring`
 * （官方值对 `--background` 实测 2.58–2.63:1 < WCAG 3:1，改用 `--primary`，见各文件内注释
 * 与 `internal/A03-xihe/evidence/2026-11-11-color-shadcn-unify/m2-impl.md`）。
 *
 * 与 `visualVariant.ts`（A/C 视觉语言覆盖：密度/圆角/字号）是**两条正交的轴**：
 * 本文件只管颜色 token，不碰字号与几何；两者可同时生效（`?variant=a&color=slate`）。
 *
 * 状态存在哪里：
 * - 生效面 = `<html data-xh-color="<scheme>">`（**恒被设置**，包括默认 neutral —— 属性即当前值，
 *   便于 devtools 与 E2E 直接读，不再有"没有属性 = 默认"的隐式态）；
 * - 持久面 = localStorage `xihe-color-scheme`（同一个键从"旧候选对比"继承下来，语义变了：
 *   以前"只删不读"，现在读 5 值并回写归一化后的值）；
 * - 明暗仍由 `useTheme` 的 `xihe-theme` 独占（`<html class="dark">`），本文件不读不写。
 *
 * 旧值迁移（**必须给明确映射，不许报错、不许停留在废弃外观**）：候选对比期写进同一个键的是
 * `c1` / `c2` / `c2′` / `c3`，它们对应的调色板（`color-c1-neutral.css` / `color-c3-muted.css` 与
 * 旧 `:root` 的 C2′）已整体下线。映射规则：
 *
 * | 旧值 | 新值 | 说明 |
 * | --- | --- | --- |
 * | `c1` | `neutral` | 自有蓝灰板已下线，落官方默认方案 |
 * | `c2` / `c2′` / `c2p` | `neutral` | 旧默认色板，同样落默认 |
 * | `c3` | `neutral` | 自有弱灰板已下线 |
 * | `default` / `off` / `none` | `neutral` | 历史清除值 |
 * | 其他未知串 | `neutral` | 不抛错、不写日志噪音；下次写入即被归一 |
 *
 * 也就是说：**旧值不再可见（用户看到的是官方 neutral），但不会报错**，且键会被就地改写为
 * 归一化后的值，第二次启动起走正常分支（不留"每次启动都迁移"的隐藏分支）。
 */

export const COLOR_SCHEME_STORAGE_KEY = "xihe-color-scheme";
export const COLOR_SCHEME_ATTRIBUTE = "data-xh-color";

/** 官方 5 个 base color（`components.json → tailwind.baseColor` 的全集，顺序即选择器顺序）。 */
export const COLOR_SCHEMES = ["neutral", "gray", "slate", "stone", "zinc"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/**
 * 默认方案 —— **单一常量**：用户看完五个方案后圈定哪个，只改这一行（以及
 * `components.json` 的 `tailwind.baseColor`，二者必须一致）。别在组件里另写默认值。
 */
export const DEFAULT_COLOR_SCHEME: ColorScheme = "neutral";

/** 历史清除值：等价于"没选过"，落默认。 */
const CLEAR_VALUES = new Set(["default", "off", "none", ""]);

/** 旧候选值 → 新方案（见文件头映射表）。 */
const LEGACY_VALUES: Record<string, ColorScheme> = {
    c1: DEFAULT_COLOR_SCHEME,
    c2: DEFAULT_COLOR_SCHEME,
    "c2′": DEFAULT_COLOR_SCHEME,
    "c2'": DEFAULT_COLOR_SCHEME,
    c2p: DEFAULT_COLOR_SCHEME,
    c3: DEFAULT_COLOR_SCHEME,
};

export function isColorScheme(value: string | null | undefined): value is ColorScheme {
    return typeof value === "string" && (COLOR_SCHEMES as readonly string[]).includes(value);
}

export interface NormalizedColorScheme {
    /** 归一化后真正生效的方案。 */
    scheme: ColorScheme;
    /** 触发归一化的原始串（`null` = 本来就合法或没存过）；供诊断/测试断言"确实迁移了"。 */
    migratedFrom: string | null;
}

/**
 * 把任意持久化/URL 串归一化成 5 个方案之一。纯函数：不读全局、不写存储。
 * 规则见文件头映射表：合法值原样返回，旧候选值与未知串一律落默认并回报 `migratedFrom`。
 */
export function normalizeColorScheme(raw: string | null | undefined): NormalizedColorScheme {
    const value = (raw ?? "").trim().toLowerCase();
    if (isColorScheme(value)) return { scheme: value, migratedFrom: null };
    if (CLEAR_VALUES.has(value)) {
        return { scheme: DEFAULT_COLOR_SCHEME, migratedFrom: value === "" ? null : value };
    }
    // 未知串（含旧候选 c1/c2/c3、旧默认名、大小写/空白变体）一律落默认，并标为已迁移。
    return { scheme: LEGACY_VALUES[value] ?? DEFAULT_COLOR_SCHEME, migratedFrom: raw ?? null };
}

/**
 * 解析 URL `?color=` 一次性覆盖（截图/对比入口，不持久化）。`search` 传 `location.search`。
 * 未知值返回 `null`（= 忽略参数、用持久化值），旧候选值同样返回 `null`：旧链接不该把界面
 * 拉回已下线的调色板。
 */
export function resolveColorScheme(search: string): ColorScheme | null {
    const fromQuery = new URLSearchParams(search).get("color")?.trim().toLowerCase() ?? "";
    if (CLEAR_VALUES.has(fromQuery)) return null;
    return isColorScheme(fromQuery) ? fromQuery : null;
}

/** 把方案投影到 `<html data-xh-color>`。传 `null` 即移除属性（= 落 `:root` 默认，等价 neutral）。 */
export function applyColorScheme(scheme: ColorScheme | null): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (scheme) root.setAttribute(COLOR_SCHEME_ATTRIBUTE, scheme);
    else root.removeAttribute(COLOR_SCHEME_ATTRIBUTE);
}

function readStorage(): string | null {
    try {
        if (typeof localStorage === "undefined") return null;
        return localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    } catch {
        // Storage 可能抛（隐私模式/配额/策略）：读不到就当没存过，不影响本次渲染。
        return null;
    }
}

function writeStorage(scheme: ColorScheme): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, scheme);
    } catch {
        // 写失败不阻断交互：本次会话仍生效（属性已设置），只是下次启动回默认。
    }
}

/** 读持久化方案（已归一化，但不回写、不投影 —— 纯读，便于测试）。 */
export function getStoredColorScheme(): ColorScheme {
    return normalizeColorScheme(readStorage()).scheme;
}

/**
 * 用户在设置里选了方案：持久化 + 立即生效。返回归一化后的值（供调用方回显）。
 * 传非 5 值（含旧候选值）不会报错，按映射表归一后照常落库。
 */
export function setStoredColorScheme(value: string): ColorScheme {
    const { scheme } = normalizeColorScheme(value);
    writeStorage(scheme);
    applyColorScheme(scheme);
    return scheme;
}

/**
 * 启动钩子：`main.ts` 在挂载前调用，保证首屏就是最终配色（无闪烁）。优先级：
 * 1. URL `?color=<5 值>`（一次性、不持久化）；
 * 2. localStorage（旧候选值就地归一 + 回写）；
 * 3. `DEFAULT_COLOR_SCHEME`。
 * 返回实际生效的方案，便于诊断日志与测试断言。
 */
export function initColorScheme(): ColorScheme {
    const search = typeof location === "undefined" ? "" : location.search;
    const fromQuery = resolveColorScheme(search);
    if (fromQuery) {
        applyColorScheme(fromQuery);
        return fromQuery;
    }

    const stored = readStorage();
    const { scheme, migratedFrom } = normalizeColorScheme(stored);
    applyColorScheme(scheme);
    // 就地归一：旧键（c1/c2/c3/未知串）第一次启动就改写成 5 值之一，之后不再走迁移分支。
    if (migratedFrom !== null) writeStorage(scheme);
    return scheme;
}
