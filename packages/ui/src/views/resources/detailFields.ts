import { wireStateOf, type FieldState } from "../../services/fieldState";

/**
 * 资源详情页的**字段三态**装配（task-42）。
 *
 * <p>为什么单独一个模块：详情页的四个资源、每个资源三层，各自要判「这个字段接口给了没给」。
 * 判据只有一条（键在不在载荷里），但**装配**（有值画值 / 空值画「（空）」/ 缺席进清单）
 * 必须在同一处，否则同页会出现两种口径 —— 那正是本卡要消灭的「两者在界面上长得一样」。</p>
 *
 * <p>判据实现**复用** `services/fieldState.wireStateOf`：实例层的 DTO 是归一化过的，
 * 所以三态由 service 的 `states` 带上来；用户/工作区层的 DTO 直接就是解析后的 JSON
 * （`composables/api.ts` 不做归一化），`wireStateOf` 对同一份载荷同样成立 —— 一份实现、两处来源。</p>
 */

/** 一行可渲染的字段；`empty` 行没有值（渲染成显式的「（空）」，不是消失）。 */
export interface DetailFieldRow {
    labelKey: string;
    value: string | null;
    state: "value" | "empty";
}

export interface DetailFields {
    rows: DetailFieldRow[];
    /** 接口**没有返回**的字段（契约问题，不是「值为空」）——按登记顺序，不重复。 */
    absentKeyList: string[];
}

export function createFields(): DetailFields {
    return { rows: [], absentKeyList: [] };
}

export interface BooleanLabels {
    true: string;
    false: string;
}

/** 把原始值转成展示文本；空（`null` / `""` / 空数组）返回 `null`（= 该画「（空）」）。 */
export function formatFieldValue(value: unknown, booleanLabels: BooleanLabels): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.length === 0 ? null : value;
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
    if (typeof value === "boolean") return value ? booleanLabels.true : booleanLabels.false;
    if (Array.isArray(value)) return value.length === 0 ? null : JSON.stringify(value);
    return JSON.stringify(value);
}

/**
 * 收一行：`absent` ⇒ 只登记（页面在「接口未返回」区块里点名，不画成数据行）；
 * `value` / `empty` ⇒ 都画成数据行，区别只在有没有值。
 */
export function pushField(
    fields: DetailFields,
    labelKey: string,
    value: unknown,
    state: FieldState,
    booleanLabels: BooleanLabels,
): void {
    if (state === "absent") {
        if (!fields.absentKeyList.includes(labelKey)) fields.absentKeyList.push(labelKey);
        return;
    }
    const text = formatFieldValue(value, booleanLabels);
    fields.rows.push({ labelKey, value: text, state: text === null ? "empty" : "value" });
}

/** 用户/工作区层（未归一化的 DTO）判三态：与实例层共用同一实现。 */
export function stateOfRow(source: unknown, keys: readonly string[]): FieldState {
    return wireStateOf(source, keys);
}
/**
 * 展示字段名 → 它在**线上载荷**里的键（默认同名）。
 *
 * <p>为什么要有这张表：页面用的名字是「给人看的」（`references` 数的是 `referenceCount`、
 * `template` 读的是 `templateName`），而三态判定问的是「**那个键**在不在响应里」。
 * 表只登记不相等的那几个 —— 相等的不写，少一处漂。</p>
 */
const FIELD_WIRE_KEYS: Readonly<Record<string, readonly string[]>> = {
    label: ["label", "name"],
    owner: ["ownerType"],
    references: ["referenceCount"],
    template: ["templateName"],
    defaultModel: ["defaultModelName"],
    bodyTokens: ["bodyTokensEst"],
    scope: ["definitionScope"],
    workspace: ["definitionScope"],
    since: ["sinceMs"],
};

/**
 * 装配一个资源的全部展示字段。
 *
 * <p>`states` 只在实例层给（DTO 由 `services/instanceResources` 归一化，三态由它带上来）；
 * 用户/工作区层的 DTO 就是解析后的 JSON，直接从 `raw` 判。</p>
 */
export function collectFields(
    raw: unknown,
    specs: readonly (readonly [string, unknown])[],
    booleanLabels: BooleanLabels,
    states?: Readonly<Record<string, FieldState>>,
): DetailFields {
    const fields = createFields();
    for (const [field, value] of specs) {
        const labelKey = `resources.detail.fields.${field}`;
        const state = states
            ? (states[field] ?? "absent")
            : wireStateOf(raw, FIELD_WIRE_KEYS[field] ?? [field]);
        pushField(fields, labelKey, value, state, booleanLabels);
    }
    return fields;
}
