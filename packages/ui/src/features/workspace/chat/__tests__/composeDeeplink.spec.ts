/**
 * BL-339：深链预填的解析层单测（纯函数）。
 *
 * 口径（产品裁定）：**合法载荷照用；任何非法/超限一律「静默忽略 + 一条 console.warn」**，
 * 不抛错、不弹窗 —— 深链来自外部入口，不能因为别人拼错参数就打断用户。
 */
import { describe, expect, it, vi } from "vitest";
import {
    COMPOSE_RECIPIENT_LIMIT,
    COMPOSE_TEXT_LIMIT,
    decodeComposePayload,
    normalizeComposeDeeplink,
    parseComposeDeeplink,
    stripComposeQuery,
} from "../composables/useComposeDeeplink";

/** UTF-8 JSON → base64url（`-`/`_` 替换、无 padding），模拟外部入口的拼法。 */
function encode(payload: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function spyWarn() {
    return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("BL-339 深链解析", () => {
    it("合法载荷：text 必填，to/cc/sessionId 原样带回", () => {
        const raw = encode({
            text: "帮我核对这条绑定",
            to: ["participant-a"],
            cc: ["participant-b", "participant-c"],
            sessionId: "session-1",
        });
        const warn = spyWarn();
        const payload = parseComposeDeeplink(raw);
        expect(payload).toEqual({
            text: "帮我核对这条绑定",
            to: ["participant-a"],
            cc: ["participant-b", "participant-c"],
            sessionId: "session-1",
        });
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("缺 text ⇒ 忽略 + warn 一次", () => {
        const warn = spyWarn();
        expect(parseComposeDeeplink(encode({ to: ["a"] }))).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("不是 base64url ⇒ 忽略 + warn 一次", () => {
        const warn = spyWarn();
        expect(parseComposeDeeplink("%%%not-base64%%%")).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("解码出来不是 JSON ⇒ 忽略 + warn 一次", () => {
        const warn = spyWarn();
        // "not json at all" 的 base64url
        const raw = Buffer.from("not json at all", "utf8")
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        expect(parseComposeDeeplink(raw)).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("to 不是字符串数组 ⇒ 忽略 + warn 一次", () => {
        const warn = spyWarn();
        expect(parseComposeDeeplink(encode({ text: "x", to: "participant-a" }))).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("超长 text ⇒ 截断到上限 + warn 一次", () => {
        const warn = spyWarn();
        const payload = parseComposeDeeplink(encode({ text: "x".repeat(COMPOSE_TEXT_LIMIT + 50) }));
        expect(payload?.text).toHaveLength(COMPOSE_TEXT_LIMIT);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("to/cc 超量 ⇒ 各自截断 + warn 一次", () => {
        const warn = spyWarn();
        const ids = Array.from({ length: COMPOSE_RECIPIENT_LIMIT + 5 }, (_, index) => `p-${index}`);
        const payload = parseComposeDeeplink(encode({ text: "x", to: ids, cc: ids }));
        expect(payload?.to).toHaveLength(COMPOSE_RECIPIENT_LIMIT);
        expect(payload?.cc).toHaveLength(COMPOSE_RECIPIENT_LIMIT);
        // 一个 warn 覆盖"超限截断"这一事实即可（不按字段各报一条）。
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    it("重复参数（数组）⇒ 取第一条 + warn 一次", () => {
        const warn = spyWarn();
        const first = encode({ text: "first" });
        const second = encode({ text: "second" });
        expect(parseComposeDeeplink([first, second])?.text).toBe("first");
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("其它字段类型不符（sessionId 非字符串）⇒ 忽略 + warn 一次", () => {
        const warn = spyWarn();
        expect(parseComposeDeeplink(encode({ text: "x", sessionId: 42 }))).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("quote 只解析不校验内容（BL-339 先不使用）", () => {
        const warn = spyWarn();
        expect(parseComposeDeeplink(encode({ text: "x", quote: "被引用的原文" }))).toEqual({
            text: "x",
        });
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe("BL-339 深链工具函数", () => {
    it("decodeComposePayload 处理无 padding 的 base64url", () => {
        const raw = encode({ text: "中文 / ascii" }).replace(/=+$/, "");
        expect(decodeComposePayload(raw)).toBe('{"text":"中文 / ascii"}');
    });

    it("stripComposeQuery 只去掉 compose，保留其它参数与 hash", () => {
        expect(stripComposeQuery("/workspace/ws-1/chat/s-1?compose=abc&tab=chat#tail")).toBe(
            "/workspace/ws-1/chat/s-1?tab=chat#tail",
        );
        expect(stripComposeQuery("/workspace/ws-1?compose=abc")).toBe("/workspace/ws-1");
    });

    it("normalizeComposeDeeplink 接受空数组的 to/cc（等价于不预填）", () => {
        const warn = spyWarn();
        expect(normalizeComposeDeeplink({ text: "x", to: [], cc: [] })).toEqual({
            text: "x",
            to: [],
            cc: [],
        });
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
