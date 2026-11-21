/**
 * task-190：设置页草稿的**比较判据**（唯一实现）。
 *
 * <p>为什么单独成模块：dirty 判定要能脱离组件单测 —— 面板 `editing` 里今后的值可能不再是纯字符串
 * （多值 select、json 结构化编辑），而 `!==` 对数组/对象恒为真（引用不同）⇒「改回原值仍算 dirty」的
 * 假阳，用户什么都没改也会被离开守卫拦住。反过来只比 `JSON.stringify` 又会因键序不同产生假阴。</p>
 *
 * <p>掩码字段（apiKey/secret/password）另有一条纪律：读取面回填的可能是掩码占位，未编辑时它不等于
 * 真实值，若按字面比较会把整页永久判成 dirty。这里把它们视为「只有用户真输入了新值才算改」。</p>
 */

/** 结构化草稿值的最小形状（面板 schema 的字段子集，避免与组件互相 import）。 */
export interface DraftFieldLike {
    key: string;
    type?: "text" | "password" | "select" | "number" | "json" | "textarea";
}

/** 掩码占位：`••••` / `****` / `<unchanged>` 这类「取读面表示已存在值」的哨兵。 */
const MASK_PLACEHOLDERS = new Set(["<unchanged>", "unchanged", "(unchanged)"]);

/**
 * 把任意草稿值规范成可比字符串：字符串原样，数组按元素递归，对象**按键名排序**后递归，
 * 数字/布尔按字面。`undefined`/`null` 与空串等价（面板里「没填」就是空串）。
 */
export function normalizeDraftValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return JSON.stringify(value.map((item) => normalizeDraftValue(item)));
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const sorted: Record<string, string> = {};
        for (const key of Object.keys(record).sort()) {
            sorted[key] = normalizeDraftValue(record[key]);
        }
        return JSON.stringify(sorted);
    }
    return String(value);
}

/** 深比较（经 `normalizeDraftValue` 规范化 ⇒ 数组元素级、对象键序无关）。 */
export function sameDraftValue(left: unknown, right: unknown): boolean {
    return normalizeDraftValue(left) === normalizeDraftValue(right);
}

/** 键名启发式：apiKey / secret / password 一律按掩码字段处理（与面板渲染判据同源）。 */
export function isMaskedFieldKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return (
        normalized.includes("apikey") ||
        normalized.includes("secret") ||
        normalized.includes("password")
    );
}

export function isMaskedField(field: DraftFieldLike): boolean {
    return field.type === "password" || isMaskedFieldKey(field.key);
}

/** 掩码占位值（`••••••` / `*****` 这类只由掩码字符组成的串）。 */
export function isMaskPlaceholder(value: string): boolean {
    if (MASK_PLACEHOLDERS.has(value.trim().toLowerCase())) return true;
    const trimmed = value.trim();
    return trimmed.length > 0 && /^[•*]+$/u.test(trimmed);
}

/**
 * 单个键是否「有未保存编辑」。
 *
 * <p>掩码字段的额外放行：草稿为空或仍是掩码占位 ⇒ 视为**没动**（读面可能只回填了掩码，
 * 用户也没输入新值）。只有用户真输入了新值（非常量掩码、非空、且与基准不同）才算 dirty。</p>
 */
export function isDraftKeyDirty(field: DraftFieldLike, draft: unknown, base: unknown): boolean {
    if (sameDraftValue(draft, base)) return false;
    if (isMaskedField(field)) {
        const draftText = normalizeDraftValue(draft);
        // 空 / 仍是占位（读面回填的掩码）⇒ 用户没输入新值，不算改动。
        // 反过来**不**看基准：基准是掩码占位时无法与真实值比较，此时草稿一旦是新输入就必须算 dirty，
        // 否则「读面回填 <unchanged>、用户输入 sk-new」这种最该保存的改动会被静默吞掉。
        if (draftText === "" || isMaskPlaceholder(draftText)) return false;
    }
    return true;
}
