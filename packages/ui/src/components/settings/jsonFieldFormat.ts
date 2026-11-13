/**
 * task-286 —— JSON 字段的「加载即格式化」决策层（**纯函数，无 DOM/无 CM6**）。
 *
 * 为什么单独抽出来：卡面判据 ②「非法 JSON 不被静默改写」与 ④「保存往返等价」都是
 * **语义判据**，不是渲染判据。把它们埋进 Vue 组件里就只能靠浏览器截图判断对错；
 * 抽成纯函数后它们可以被单测逐字节钉住 —— 而这两条恰恰是最容易被「顺手修好」做坏的。
 *
 * 三条硬规则（逐条对应卡面判据）：
 *
 * 1. **格式化是呈现，不是修正**（判据 ②）。`JSON.parse` 失败时**原样返回输入**，
 *    绝不「尽力修复」、绝不回退默认值、绝不把原文清空。用户输错的东西必须原样留在
 *    编辑器里，外加一条错误提示 —— 静默改写成「看起来合法的别的东西」比不格式化坏得多，
 *    因为用户保存下去的就是被改过的内容。
 * 2. **语义不变**（判据 ④）。只 `parse` → `stringify(…, null, 2)`：不增删字段、不补默认值、
 *    不重排键序（JS 对象键序对整数键以外保持插入序，与源文本一致）。因此
 *    `formatJsonText(合法).parsed` 与原文解析结果**深等**。
 * 3. **幂等**（判据 ④ 的推论）。已格式化文本再格式化一次必须逐字节相同，
 *    否则「每次加载都变一点」会在保存往返里累积漂移。
 *
 * 空串是**合法的未设置态**（`handleSave` 会把它过滤掉），不是「非法 JSON」：
 * 返回 `ok: true` 且原样返回，否则空字段会在页面上挂一条假错误。
 */

/** 一次格式化尝试的结果。`ok: false` 时 `text` 恒等于入参。 */
export interface JsonFormatResult {
    /** 要显示在编辑器里的文本。失败时 = 原文（**绝不改写**）。 */
    text: string;
    /** 是否成功解析并重排（空串算成功但无需重排）。 */
    formatted: boolean;
    /** 失败时的错误信息（供 UI 展示）；成功时为 `null`。 */
    error: string | null;
}

/**
 * 尝试把一段 JSON 文本格式化成两空格缩进。
 *
 * - 空串 / 纯空白 ⇒ `{ ok: true, formatted: false }`（未设置态，不算错）。
 * - 可解析 ⇒ 缩进后的文本；若原本已缩进，结果与输入逐字节相同（幂等）。
 * - 不可解析 ⇒ **原文原样返回** + `error`（判据 ②）。
 */
export function formatJsonText(raw: string): JsonFormatResult {
    if (raw.trim() === "") {
        return { text: raw, formatted: false, error: null };
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        const pretty = JSON.stringify(parsed, null, 2);
        // `JSON.stringify` 对顶层 `undefined` 返回 undefined（JSON.parse 造不出，但兜底）。
        if (pretty === undefined) {
            return { text: raw, formatted: false, error: null };
        }
        return { text: pretty, formatted: pretty !== raw, error: null };
    } catch (cause) {
        // 判据 ②：失败时**原文原样**返回。这里刻意不 catch 成空串 / 不返回 pretty 的空白。
        const detail = cause instanceof Error && cause.message ? cause.message : String(cause);
        return { text: raw, formatted: false, error: detail };
    }
}

/**
 * 判断一段文本是否「已是格式化态」（用于避免加载时把用户正在编辑的内容重排）。
 * 判据 = `formatJsonText` 的结果不需要改动文本。
 */
export function isJsonTextFormatted(raw: string): boolean {
    const result = formatJsonText(raw);
    return result.error === null && !result.formatted;
}

/**
 * 保存往返判据助手（判据 ④）：格式化前后**解析语义**必须深等。
 *
 * 只比较 JSON 语义（键序/空白不参与），因为「格式化只影响显示」这句话的实质就是
 * 「解析出来的值不变」。非法 JSON 返回 `false`（没有可比语义）。
 */
export function jsonSemanticsEqual(before: string, after: string): boolean {
    const a = tryParse(before);
    const b = tryParse(after);
    if (a === UNPARSABLE || b === UNPARSABLE) return false;
    return deepEqual(a, b);
}

const UNPARSABLE = Symbol("unparsable");

function tryParse(text: string): unknown | typeof UNPARSABLE {
    try {
        return JSON.parse(text);
    } catch {
        return UNPARSABLE;
    }
}

/** 结构化深等（只处理 JSON 能表达的形态：null/bool/number/string/array/object）。 */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        return a.every((item, index) => deepEqual(item, b[index]));
    }
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
        const aKeys = Object.keys(a as Record<string, unknown>);
        const bKeys = Object.keys(b as Record<string, unknown>);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every(
            (key) =>
                Object.prototype.hasOwnProperty.call(b, key) &&
                deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
        );
    }
    return false;
}
