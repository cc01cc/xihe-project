/**
 * 字段三态判定的**唯一实现**（task-42）。
 *
 * <p>为什么单独一个模块：两处都要用它 —— `services/instanceResources` 的归一化函数要给 DTO 带
 * `states`（键缺席 vs 键在但空，是它唯一还分得清的地方），`views/resources/detailFields` 要给
 * 用户/工作区层（未归一化的 DTO）判同样的事。留在 service 里会让 view 为了一个通用判据去 import
 * 一个资源专用模块（单测里也因此不得不把 service 整个 mock 掉）。</p>
 *
 * <p>「完全相同」与「完全没测到」在界面上不可区分（`D-1187`④ 同族）：本模块的存在就是为了
 * 让这两件事在数据层可判、在界面上可读。</p>
 */

/** 字段在**线上载荷**里的三种状态。 */
export type FieldState = "value" | "empty" | "absent";

export type FieldStates<K extends string = string> = Readonly<Record<K, FieldState>>;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * 判一个字段在原始载荷里属于哪一种（`absent` = 连键都没有）。
 *
 * <p>多个键算一个字段时按顺序取（例如 `label` 兼容 `name`）：任一个给了值就算有值；
 * 都没值但至少有一个键在，就算 `empty`。</p>
 */
export function wireStateOf(raw: unknown, keys: readonly string[]): FieldState {
    const record = asRecord(raw);
    let seen = false;
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        seen = true;
        const value = record[key];
        if (value === null || value === undefined || value === "") continue;
        if (Array.isArray(value) && value.length === 0) continue;
        return "value";
    }
    return seen ? "empty" : "absent";
}
