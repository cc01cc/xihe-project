/**
 * task-286 —— `jsonFieldFormat` 纯函数判据单测。
 *
 * 重点是把卡面两条最容易被做歪的判据钉成**逐字节**断言：
 * - 判据 ② 非法 JSON **不被静默改写**（原样返回 + 带错误）
 * - 判据 ④ 保存往返语义等价 + 幂等（格式化只影响显示，不改落库内容）
 */
import { describe, expect, it } from "vitest";
import { formatJsonText, isJsonTextFormatted, jsonSemanticsEqual } from "../jsonFieldFormat";

describe("formatJsonText —— 判据 ②：非法 JSON 不被静默改写", () => {
    /** 常见的手输错形态，逐条都必须原样返回。 */
    const BAD = [
        '{ "a": 1, }', // 悬空逗号
        "{'a': 1}", // 单引号
        '{ "a": 1 } extra', // 尾随垃圾
        '{\n  "a": \n', // 截断
        "not json at all",
        "[1, 2, ", // 数组未闭合
    ];
    it.each(BAD)("坏 JSON %j：原文逐字节保持不变", (raw) => {
        const result = formatJsonText(raw);
        expect(result.text).toBe(raw); // ← 判据 ② 的核心断言
        expect(result.formatted).toBe(false);
        expect(result.error).not.toBeNull();
    });

    it("失败时绝不返回空串 / 绝不清空用户输入", () => {
        const raw = '{ "broken": ';
        const result = formatJsonText(raw);
        expect(result.text).not.toBe("");
        expect(result.text.length).toBe(raw.length);
    });

    it("失败时绝不「尽力修复」（输出仍是原文，不是被改过的近似值）", () => {
        const raw = "{'a': 1}";
        const result = formatJsonText(raw);
        // 若实现里偷偷 replace 单引号，这里会变成 {"a": 1}
        expect(result.text).not.toContain('"a"');
    });
});

describe("formatJsonText —— 判据 ④：格式化只影响显示", () => {
    it("合法 JSON 会被缩进成 2 空格", () => {
        const raw = '{"a":1,"b":{"c":2}}';
        const result = formatJsonText(raw);
        expect(result.error).toBeNull();
        expect(result.text).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}');
    });

    it("格式化前后语义深等（不增删字段、不补默认值）", () => {
        const raw = '{"n":1,"nested":{"x":[1,2,3]},"s":"中文值"}';
        const result = formatJsonText(raw);
        expect(jsonSemanticsEqual(raw, result.text)).toBe(true);
    });

    it("幂等：已格式化文本再格式化逐字节相同", () => {
        const raw = '{"a":1}';
        const once = formatJsonText(raw).text;
        const twice = formatJsonText(once).text;
        expect(twice).toBe(once);
        expect(formatJsonText(once).formatted).toBe(false);
    });

    it("保留键的插入序（不重排）", () => {
        const raw = '{"z":1,"a":2,"m":3}';
        const text = formatJsonText(raw).text;
        expect(text.indexOf('"z"')).toBeLessThan(text.indexOf('"a"'));
        expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"m"'));
    });

    it("多字节中文值往返不丢", () => {
        const raw = '{"说明":"中文值含 emoji 🚀"}';
        const result = formatJsonText(raw);
        expect(jsonSemanticsEqual(raw, result.text)).toBe(true);
        expect(result.text).toContain("中文值含 emoji 🚀");
    });
});

describe("formatJsonText —— 空串是未设置态，不是错误", () => {
    it.each(["", "   ", "\n", "\t\n "])("空白输入 %j 不算错误", (raw) => {
        const result = formatJsonText(raw);
        expect(result.error).toBeNull();
        expect(result.text).toBe(raw);
        expect(result.formatted).toBe(false);
    });
});

describe("isJsonTextFormatted", () => {
    it("已格式化的合法 JSON 判为已格式化", () => {
        expect(isJsonTextFormatted('{\n  "a": 1\n}')).toBe(true);
    });
    it("紧凑 JSON 判为未格式化（需要格式化）", () => {
        expect(isJsonTextFormatted('{"a":1}')).toBe(false);
    });
    it("非法 JSON 不判为已格式化（但要保留原文）", () => {
        expect(isJsonTextFormatted("{bad")).toBe(false);
    });
});

describe("jsonSemanticsEqual", () => {
    it("同一语义不同空白 ⇒ 等价", () => {
        expect(jsonSemanticsEqual('{"a":1}', '{\n  "a": 1\n}')).toBe(true);
    });
    it("值不同 ⇒ 不等价", () => {
        expect(jsonSemanticsEqual('{"a":1}', '{"a":2}')).toBe(false);
    });
    it("少一个字段 ⇒ 不等价（防「格式化顺手补默认值」）", () => {
        expect(jsonSemanticsEqual('{"a":1}', '{"a":1,"b":0}')).toBe(false);
    });
    it("任一非法 ⇒ 无可比语义", () => {
        expect(jsonSemanticsEqual("{bad", '{"a":1}')).toBe(false);
    });
});
