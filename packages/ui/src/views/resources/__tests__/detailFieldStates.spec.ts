import { describe, expect, it } from "vitest";
import { collectFields, formatFieldValue, pushField, createFields } from "../detailFields";

/**
 * task-42：资源详情页的**三态装配**（纯函数层）。
 *
 * <p>判据纪律：三种状态各自断言，并且**每条都带阳性对照**（`D-1182`）—— 只断「缺席时不进数据行」
 * 而不证明「有值时会进」，实现写成「永远登记缺席」也能过。
 *
 * <p>「（空）」不是文案细节而是判据：键在值为空 ⇒ 画一行 `empty`；键不在 ⇒ 进「接口未返回」清单。
 * 二者在用户眼里长得一样，所以差异必须钉在数据上（`state` + `absentKeyList`），不能只钉在渲染文本上。</p>
 */
const boolLabels = { true: "是", false: "否" };

describe("formatFieldValue —— 空值的三种写法都归一成 null", () => {
    it("null / undefined / 空串 / 空数组 ⇒ null（= 该画「（空）」）", () => {
        expect(formatFieldValue(null, boolLabels)).toBeNull();
        expect(formatFieldValue(undefined, boolLabels)).toBeNull();
        expect(formatFieldValue("", boolLabels)).toBeNull();
        expect(formatFieldValue([], boolLabels)).toBeNull();
    });

    it("阳性对照：0 与 false 都是**有值**，不能当空", () => {
        expect(formatFieldValue(0, boolLabels)).toBe("0");
        expect(formatFieldValue(false, boolLabels)).toBe("否");
        expect(formatFieldValue(true, boolLabels)).toBe("是");
        expect(formatFieldValue("x", boolLabels)).toBe("x");
        expect(formatFieldValue([1], boolLabels)).toBe("[1]");
    });
});

describe("pushField —— 缺席只登记、空值画成 empty 行", () => {
    it("absent ⇒ 不进 rows，只进 absentKeyList（且不重复）", () => {
        const fields = createFields();
        pushField(fields, "k.replacedAt", null, "absent", boolLabels);
        pushField(fields, "k.replacedAt", null, "absent", boolLabels);
        expect(fields.rows).toHaveLength(0);
        expect(fields.absentKeyList).toEqual(["k.replacedAt"]);
    });

    it("empty ⇒ 进 rows 且 state=empty（value 为 null）", () => {
        const fields = createFields();
        pushField(fields, "k.fingerprint", "", "empty", boolLabels);
        expect(fields.rows).toHaveLength(1);
        expect(fields.rows[0]).toEqual({ labelKey: "k.fingerprint", value: null, state: "empty" });
        expect(fields.absentKeyList).toHaveLength(0);
    });

    it("value ⇒ 进 rows 且 state=value", () => {
        const fields = createFields();
        pushField(fields, "k.revision", 2, "value", boolLabels);
        expect(fields.rows[0]).toEqual({ labelKey: "k.revision", value: "2", state: "value" });
    });
});

describe("collectFields —— 用户/工作区层：直接判原始载荷的键", () => {
    it("键在值空 ⇒ empty 行；键不在 ⇒ 缺席清单（同一份载荷里两种都有）", () => {
        const raw = { label: "部署令牌", fingerprint: "" };
        const fields = collectFields(
            raw,
            [
                ["label", raw.label],
                ["fingerprint", raw.fingerprint],
                ["replacedAt", undefined],
            ],
            boolLabels,
        );
        expect(fields.rows.map((r) => r.labelKey)).toEqual([
            "resources.detail.fields.label",
            "resources.detail.fields.fingerprint",
        ]);
        expect(fields.rows[1].state).toBe("empty");
        expect(fields.absentKeyList).toEqual(["resources.detail.fields.replacedAt"]);
    });

    it("阳性对照：同一个 replacedAt 键在载荷里给了值 ⇒ 进 rows，缺席清单为空", () => {
        const raw = { label: "部署令牌", fingerprint: "fp:1", replacedAt: "2026-11-01T00:00:00Z" };
        const fields = collectFields(
            raw,
            [
                ["label", raw.label],
                ["fingerprint", raw.fingerprint],
                ["replacedAt", raw.replacedAt],
            ],
            boolLabels,
        );
        expect(fields.absentKeyList).toEqual([]);
        expect(fields.rows.find((r) => r.labelKey.endsWith(".replacedAt"))?.state).toBe("value");
    });

    it("展示名与线上键不同时按 FIELD_WIRE_KEYS 判（references 读 referenceCount）", () => {
        const raw = { label: "甲", referenceCount: 0 };
        const fields = collectFields(
            raw,
            [
                ["references", raw.referenceCount],
                ["owner", undefined],
            ],
            boolLabels,
        );
        expect(fields.rows[0]).toEqual({
            labelKey: "resources.detail.fields.references",
            value: "0",
            state: "value",
        });
        // raw 里没有 ownerType ⇒ owner 是契约问题
        expect(fields.absentKeyList).toEqual(["resources.detail.fields.owner"]);
    });

    it("alias 键：label 缺席但 name 给了值 ⇒ 仍算 value", () => {
        const raw = { name: "别名令牌" };
        const fields = collectFields(raw, [["label", raw.name]], boolLabels);
        expect(fields.rows).toHaveLength(1);
        expect(fields.rows[0].state).toBe("value");
        expect(fields.absentKeyList).toEqual([]);
    });
});

describe("collectFields —— 实例层：三态以 service 的 states 为准", () => {
    it("states 说 absent 的字段即使值字段被填了默认值也不进 rows", () => {
        // 归一化会给缺席的 revision 填 1：只看值会以为「后端给了 1」，看 states 才知道是缺席。
        const raw = { revision: 1, fingerprint: "" };
        const fields = collectFields(
            raw,
            [
                ["revision", raw.revision],
                ["fingerprint", raw.fingerprint],
            ],
            boolLabels,
            { revision: "absent", fingerprint: "empty" },
        );
        expect(fields.absentKeyList).toEqual(["resources.detail.fields.revision"]);
        expect(fields.rows).toHaveLength(1);
        expect(fields.rows[0].labelKey).toBe("resources.detail.fields.fingerprint");
        expect(fields.rows[0].state).toBe("empty");
    });

    it("阳性对照：states 说 value 的字段进 rows（同样填了默认值也不误判成缺席）", () => {
        const raw = { revision: 1 };
        const fields = collectFields(raw, [["revision", 1]], boolLabels, { revision: "value" });
        expect(fields.absentKeyList).toEqual([]);
        expect(fields.rows[0]).toEqual({
            labelKey: "resources.detail.fields.revision",
            value: "1",
            state: "value",
        });
    });
});
