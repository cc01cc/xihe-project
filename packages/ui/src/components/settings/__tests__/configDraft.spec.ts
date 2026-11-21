import { describe, expect, it } from "vitest";
import {
    isDraftKeyDirty,
    isMaskedField,
    isMaskedFieldKey,
    isMaskPlaceholder,
    normalizeDraftValue,
    sameDraftValue,
    type DraftFieldLike,
} from "../configDraft";

/**
 * task-190（Lead 判据 ①②）：设置页 dirty 判据的**比较函数**与**掩码豁免**。
 *
 * <p>为什么单独钉这两个函数而不是只在面板里做 DOM 断言：面板里复现「改回原值」需要先有一份
 * 非字符串基准（数组/对象/掩码串），DOM 层只能改到字符串；而这两类恰恰是假阳重灾区：</p>
 * <ul>
 *   <li>① `draft !== base` 对数组/对象**恒真**（引用不同）⇒ 改回原值仍整页 dirty，挡下次导航；</li>
 *   <li>① 只比 `JSON.stringify` 又会因**键序**不同假阴 ⇒ 必须规范化 + 键排序；</li>
 *   <li>② 读面回填的是掩码占位（`••••` / `<unchanged>`），永远不等于真实值 ⇒ 未编辑也持久 dirty。</li>
 * </ul>
 */

const jsonField: DraftFieldLike = { key: "allowedModels", type: "json" };
const passwordField: DraftFieldLike = { key: "llmApiKey", type: "password" };
const textField: DraftFieldLike = { key: "logLevel", type: "text" };

describe("task-190 · normalizeDraftValue", () => {
    it("标量按显示形态归一到字符串（null/undefined 记空串）", () => {
        expect(normalizeDraftValue(undefined)).toBe("");
        expect(normalizeDraftValue(null)).toBe("");
        expect(normalizeDraftValue("INFO")).toBe("INFO");
        expect(normalizeDraftValue(5)).toBe("5");
        expect(normalizeDraftValue(false)).toBe("false");
    });

    it("对象按键名排序后序列化（键序不同不产生差异）", () => {
        expect(normalizeDraftValue({ b: 1, a: 2 })).toBe(normalizeDraftValue({ a: 2, b: 1 }));
        expect(normalizeDraftValue({ a: "1" })).toBe('{"a":"1"}');
    });

    it("数组逐项归一（数字与字符串元素不再因类型不同而判脏）", () => {
        expect(normalizeDraftValue([1, "a"])).toBe(normalizeDraftValue(["1", "a"]));
        expect(normalizeDraftValue([{ b: 2, a: 1 }])).toBe(normalizeDraftValue([{ a: 1, b: 2 }]));
    });
});

describe("task-190 · sameDraftValue", () => {
    it("数组换了引用、内容相同 ⇒ 视为相同", () => {
        expect(sameDraftValue(["a", "b"], ["a", "b"])).toBe(true);
    });

    it("对象键序不同但内容相同 ⇒ 视为相同", () => {
        expect(sameDraftValue({ x: 1, y: 2 }, { y: 2, x: 1 })).toBe(true);
    });
});

describe("task-190 · 掩码识别", () => {
    it("password 类型与密钥类键名都算掩码字段", () => {
        expect(isMaskedField(passwordField)).toBe(true);
        expect(isMaskedFieldKey("llmApiKey")).toBe(true);
        expect(isMaskedFieldKey("logLevel")).toBe(false);
    });

    it("占位形态（圆点 / * / <unchanged>）识别为「未改动」", () => {
        expect(isMaskPlaceholder("••••••")).toBe(true);
        expect(isMaskPlaceholder("****")).toBe(true);
        expect(isMaskPlaceholder("<unchanged>")).toBe(true);
        expect(isMaskPlaceholder("Info")).toBe(false);
        expect(isMaskPlaceholder("")).toBe(false);
    });
});

describe("task-190 · isDraftKeyDirty（Lead 判据 ①）", () => {
    it("数组改回原值 ⇒ 不 dirty（引用不同但内容相同）", () => {
        const base = [1, 2];
        const draft = [1, 2];
        expect(draft).not.toBe(base);
        expect(isDraftKeyDirty(jsonField, draft, base)).toBe(false);
    });

    it("数组元素真改 ⇒ dirty", () => {
        expect(isDraftKeyDirty(jsonField, [1, 3], [1, 2])).toBe(true);
        expect(isDraftKeyDirty(jsonField, [1, 2, 3], [1, 2])).toBe(true);
    });

    it("对象改回原值 ⇒ 不 dirty；新增键 ⇒ dirty", () => {
        expect(isDraftKeyDirty(jsonField, { a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
        expect(isDraftKeyDirty(jsonField, { a: 1, c: 3 }, { a: 1 })).toBe(true);
    });

    it("普通文本字段按值比较", () => {
        expect(isDraftKeyDirty(textField, "INFO", "INFO")).toBe(false);
        expect(isDraftKeyDirty(textField, "DEBUG", "INFO")).toBe(true);
    });

    it("掩码字段：空草稿 / 占位草稿都不算 dirty（Lead 判据 ②）", () => {
        expect(isDraftKeyDirty(passwordField, "", "")).toBe(false);
        expect(isDraftKeyDirty(passwordField, "••••", "")).toBe(false);
        expect(isDraftKeyDirty(passwordField, "<unchanged>", "<unchanged>")).toBe(false);
        expect(isDraftKeyDirty(passwordField, "<unchanged>", "real-secret")).toBe(false);
    });

    it("掩码字段用户真输入新值 ⇒ dirty", () => {
        expect(isDraftKeyDirty(passwordField, "sk-new", "")).toBe(true);
        expect(isDraftKeyDirty(passwordField, "sk-new", "<unchanged>")).toBe(true);
    });
});
