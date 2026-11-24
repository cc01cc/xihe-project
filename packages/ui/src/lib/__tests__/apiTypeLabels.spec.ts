import { describe, expect, it } from "vitest";
import { apiTypeLabelKey, formatApiType, formatApiTypeTechnical } from "../apiTypeLabels";

/** task-170 / F-07：API Type 展示名映射只做「人能读的名字」，不据它推断能力。 */
describe("apiTypeLabels（F-07 API Type 展示名）", () => {
    it("登记过的类型给出 i18n 键，版本号以人类可读的（vN）后缀显示", () => {
        expect(apiTypeLabelKey("anthropic-messages")).toBe("settings.apiTypeAnthropicMessages");
        const translate = (key: string) =>
            key === "settings.apiTypeAnthropicMessages" ? "Anthropic Messages 协议" : key;
        expect(formatApiType("anthropic-messages", 1, translate)).toBe(
            "Anthropic Messages 协议（v1）",
        );
    });

    it("未登记的类型原样返回（漏配词表时显示技术标识，不显示错名字）", () => {
        expect(apiTypeLabelKey("legacy-responses")).toBeNull();
        const translate = (key: string) => key;
        expect(formatApiType("legacy-responses", 2, translate)).toBe("legacy-responses（v2）");
    });

    it('缺版本号时只给名字，不要拼出 "@undefined"', () => {
        const translate = (key: string) => (key === "settings.apiTypeMimoResponses" ? "MiMo" : key);
        expect(formatApiType("mimo-responses", null, translate)).toBe("MiMo");
    });

    it("技术形态保留 id@version，供技术详情/JSON 使用", () => {
        expect(formatApiTypeTechnical("openai-chat-completions", 1)).toBe(
            "openai-chat-completions@1",
        );
        expect(formatApiTypeTechnical("openai-chat-completions", null)).toBe(
            "openai-chat-completions",
        );
    });
});
