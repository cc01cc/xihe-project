/**
 * task-285：`context-policy` 两个 JSON 键 → 分键表单的**纯逻辑**。
 *
 * <p>为什么要有这一层：CP 把 `context-policy` 存成两个键 `defaults` / `models`，值是 JSON 文本
 * （`LlmSummaryProvider.java:269-270` 用 `parseObject(domain.get("defaults"))` 读）。UI 早先直接把
 * 它们当裸 JSON 文本框（`ConfigLayerPanels.vue:166-169`），等于把「13 个类型化键 + 1 张按模型覆盖表」
 * 退化成手写 JSON。这里只做「JSON ↔ 逐字段」的双向映射，渲染交给组件。
 *
 * <p>三条不变量（卡面判据，见 `configSchemaCatalog` 与 `ContextModelOverrides.vue` 的调用点）：
 * ① **未登记的键原样保留** —— 重组时以原始对象为底，只覆盖/删除本表单认识的键；
 * ② **未改动 ⇒ 原文字节不变** —— 重组结果与原始对象深度相等时直接返回原始文本，不重排版；
 * ③ **空值 = 取消该键**，不是写空串（CP 的 `pick*` 对缺失键走默认/继承，空串则是一个值）。
 */
import { CONFIG_SCHEMA_CATALOG, type SchemaField } from "../../lib/configSchemaCatalog";

export const CONTEXT_POLICY_DOMAIN = "context-policy";
export const DEFAULTS_KEY = "defaults";
export const MODELS_KEY = "models";
export const DEFAULTS_PREFIX = DEFAULTS_KEY + ".";

export function contextPolicyCatalogFields(): SchemaField[] {
    return CONFIG_SCHEMA_CATALOG[CONTEXT_POLICY_DOMAIN] ?? [];
}

/** `defaults` 下的类型化叶子（键已去掉 `defaults.` 前缀）。 */
export function defaultsLeaves(): SchemaField[] {
    return contextPolicyCatalogFields()
        .filter((field) => field.key.startsWith(DEFAULTS_PREFIX))
        .map((field) => ({ ...field, key: field.key.slice(DEFAULTS_PREFIX.length) }));
}

/** `models` 的按模型覆盖键（来自生成物的 `mapValueFields`，不是手抄的第二份清单）。 */
export function modelOverrideFields(): SchemaField[] {
    return (
        contextPolicyCatalogFields().find((field) => field.key === MODELS_KEY)?.mapValueFields ?? []
    );
}

/** 解析成普通对象；空串/非法 JSON/数组一律当空对象（读侧宽容，写侧不猜）。 */
export function parseObjectValue(raw: string | undefined): Record<string, unknown> {
    if (!raw || raw.trim() === "") return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { ...(parsed as Record<string, unknown>) };
        }
        return {};
    } catch {
        return {};
    }
}

/** 对象值 → 输入框文本（未设置为空串；布尔按 true/false，数字按十进制）。 */
export function valueToText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return value;
    return JSON.stringify(value);
}

/**
 * 输入框值 → 对象值；空值返回 undefined（= 不设置该键）。
 *
 * <p>**入参必须是 unknown 而不是 string**：`<input type="number">` 上 Vue 的 `v-model` 会隐式
 * 把值转成 number（等价 `.number` Modifier），于是"输入框里是文本"这个直觉是错的。
 * 实测症状：`text.trim is not a function` —— 在组件测试里点保存时炸在事件处理器内部，
 * 外层只看到"没 emit"，很容易被误判成"按钮没接上"。故在这里显式收敛，不靠调用方自觉。</p>
 */
export function textToValue(text: unknown, type: SchemaField["type"]): unknown {
    const raw = String(text ?? "").trim();
    if (raw === "") return undefined;
    if (type === "boolean") return raw === "true";
    if (type === "integer" || type === "number") {
        const num = Number(raw);
        return Number.isFinite(num) ? num : raw;
    }
    return text;
}

/** 键序无关的稳定序列化，只用于「改没改」的比较，不用来写回。 */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** 以原始对象为底，把草稿逐键覆盖上去；空文本 = 删掉该键（未登记键永不触碰）。 */
export function applyDrafts(
    original: Record<string, unknown>,
    drafts: Record<string, string>,
    fields: SchemaField[],
): Record<string, unknown> {
    const next = { ...original };
    for (const field of fields) {
        if (!(field.key in drafts)) continue;
        const value = textToValue(drafts[field.key] ?? "", field.type);
        if (value === undefined) delete next[field.key];
        else next[field.key] = value;
    }
    return next;
}

/** 把 `defaults` 文本拆成逐键草稿（键名不带 `defaults.` 前缀）。 */
export function decomposeDefaults(raw: string | undefined): Record<string, string> {
    const obj = parseObjectValue(raw);
    const drafts: Record<string, string> = {};
    for (const field of defaultsLeaves()) drafts[field.key] = valueToText(obj[field.key]);
    return drafts;
}

/**
 * 重组 `defaults` 的 JSON 文本。
 *
 * @returns `null` = 没有变化（调用方不该写这个键）；否则是要写回的新文本。
 */
export function composeDefaults(
    originalRaw: string | undefined,
    drafts: Record<string, string>,
): string | null {
    const original = parseObjectValue(originalRaw);
    const next = applyDrafts(original, drafts, defaultsLeaves());
    if (stableStringify(next) === stableStringify(original)) return null;
    // 全清空时写 "{}" 而不是 ""：空串在 CP 通用写入路径里会被原样入库（`ConfigService.java:1374-1405`），
    // 那不是「没有覆盖」，而是一个空对象；"{}" 与「没配」在 `parseObject` 眼里等价。
    return JSON.stringify(next, null, 2);
}

export interface ModelRowDraft {
    /** 模型名（`models` 的键；`LlmSummaryProvider.java:282` 的 `models.path(baseModel)`）。 */
    name: string;
    /** 该行的按键草稿；空串 = 该键不设置（回落到 `defaults`）。 */
    values: Record<string, string>;
}

/** 把 `models` 文本拆成逐行草稿（顺序按原文键序，便于稳定显示）。 */
export function decomposeModels(raw: string | undefined): ModelRowDraft[] {
    const obj = parseObjectValue(raw);
    const fields = modelOverrideFields();
    return Object.entries(obj).map(([name, value]) => {
        const row =
            value && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
        const values: Record<string, string> = {};
        for (const field of fields) values[field.key] = valueToText(row[field.key]);
        return { name, values };
    });
}

/** 一行里没被 catalog 登记的键（保存时原样保留，不能因为不认识就丢）。 */
export function unknownKeysOf(raw: string | undefined, name: string): string[] {
    const row = parseObjectValue(raw)[name];
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const known = new Set(modelOverrideFields().map((field) => field.key));
    return Object.keys(row as Record<string, unknown>).filter((key) => !known.has(key));
}

/**
 * 重组 `models` 的 JSON 文本。
 *
 * <p>每行都**以原始对象里同名行**为底（保留未登记键），所以：改 A 行不影响 B 行；
 * 删行 = 从结果里移除该键；新增行 = 只写入该行草稿里非空的键。
 *
 * @returns `null` = 没有变化。
 */
export function composeModels(
    originalRaw: string | undefined,
    rows: ModelRowDraft[],
): string | null {
    const original = parseObjectValue(originalRaw);
    const fields = modelOverrideFields();
    const next: Record<string, unknown> = {};
    for (const row of rows) {
        const name = row.name.trim();
        if (name === "") continue;
        const base = parseObjectValue(
            original[name] && typeof original[name] === "object"
                ? JSON.stringify(original[name])
                : undefined,
        );
        next[name] = applyDrafts(base, row.values, fields);
    }
    if (stableStringify(next) === stableStringify(original)) return null;
    return JSON.stringify(next, null, 2);
}
