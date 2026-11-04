/**
 * 2026-11-04 用户裁定：agent 主体名与 username 的字符规范（UI 预检 vs CP 权威判定）。
 *
 * 判据以 CP 为准，而 CP **不 trim**：`" abc "` 在服务端是 400 `INVALID_NAME_FORMAT`。
 * 所以 UI 也不能先 trim 再判——否则界面放行、请求到 CP 才失败（用户只看到"保存没反应"）。
 * 前后空格单独给 "whitespace" 码，让调用方提示"前后不能有空格"，而不是静默吞掉。
 */
import { describe, expect, it } from "vitest";
import {
    PRINCIPAL_NAME_PATTERN,
    USERNAME_MAX_LENGTH,
    principalNameError,
    usernameError,
} from "../principalName";

describe("principalNameError (2026-11-04 name-format ruling)", () => {
    it.each(["Zoe", "zoe", "张三", "zoe2026", "Agent2", "李明2", "中", "a"])(
        "接受不含空格、不以数字开头的 %s",
        (value) => {
            expect(principalNameError(value)).toBeNull();
        },
    );

    it.each([" abc ", "abc ", " abc", "\tabc", "abc\n"])(
        "前后空格单独报 whitespace，不静默 trim：%j",
        (value) => {
            expect(principalNameError(value)).toBe("whitespace");
        },
    );

    it.each(["", " ", "   "])("空或纯空白报 required：%j", (value) => {
        expect(principalNameError(value)).toBe("required");
    });

    it.each(["zoe wang", "张 三", "1Zoe", "123", "zoe_wang", "zoe-wang", "zoe.wang", "张三（PM）"])(
        "中间空格 / 符号 / 数字开头报 pattern：%s",
        (value) => {
            expect(principalNameError(value)).toBe("pattern");
        },
    );

    it("正则与 CP NameFormat.PATTERN_SOURCE 逐字同源（改一侧必须同批改另一侧）", () => {
        expect(PRINCIPAL_NAME_PATTERN.source).toBe(
            "^[A-Za-z\\u4e00-\\u9fff][A-Za-z0-9\\u4e00-\\u9fff]*$",
        );
    });
});

describe("usernameError (v29: username 与主体名同规则 + 列宽 32)", () => {
    it("接受大写与中文汉字（v29 放宽的两类）", () => {
        expect(usernameError("ZhangSan")).toBeNull();
        expect(usernameError("李小明")).toBeNull();
        expect(usernameError("Zoe2026")).toBeNull();
    });

    it("前后空格单独报 whitespace（不静默 trim）", () => {
        expect(usernameError(" abc ")).toBe("whitespace");
        expect(usernameError("abc ")).toBe("whitespace");
    });

    it("符号 / 数字开头 / 中间空格报 pattern", () => {
        expect(usernameError("abc-def")).toBe("pattern");
        expect(usernameError("abc_def")).toBe("pattern");
        expect(usernameError("1abc")).toBe("pattern");
        expect(usernameError("abc def")).toBe("pattern");
    });

    it("超过 32 报 length，32 恰好合法（CP 列宽 VARCHAR(32)）", () => {
        expect(USERNAME_MAX_LENGTH).toBe(32);
        expect(usernameError("a".repeat(32))).toBeNull();
        expect(usernameError("a".repeat(33))).toBe("length");
    });

    it("空串报 required（注册页留空由 CP 从邮箱派生，属调用方语义）", () => {
        expect(usernameError("")).toBe("required");
    });
});
