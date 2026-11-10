import { describe, expect, it } from "vitest";
import { mockLongToolCalls, mockLongWrapProbeToolCall, mockLongWindowsPathToolCall } from "../mockData";

/**
 * task-110：长串夹具守卫 —— 「不许被拼短」。
 *
 * 为什么需要：量具（measure-mono-width.mjs）对「字符串变短」完全瞎 —— 短串永远不溢出。
 * 有人改夹具时把 JSON.stringify 换成手写字符串、或转义层把 \\\\ 吃成 \\，
 * 长串会静默缩短，量测依然全绿。这是 D-861「判据的对象被悄悄换掉」：
 * 判据没坏，被测的东西变了。
 *
 * 下限怎么定：取当前实测长度留约 5% 余量（实测值记在每条注释里）。
 * 目的不是禁止编辑，而是「显著变短必须是有意的」—— 缩短到门槛以下就要来改这张表，
 * 而改表的人会读到这段注释。
 */
const MINIMA: { id: string; args: number; body: number; note: string }[] = [
    { id: "tc-long-args", args: 300, body: 0, note: "实测 args=320" },
    { id: "tc-long-output", args: 85, body: 330, note: "实测 args=90 / result=353（这张卡的长串在 result 上）" },
    { id: "tc-long-error", args: 195, body: 265, note: "实测 args=208 / error=285" },
    { id: "tc-long-refusal", args: 190, body: 0, note: "实测 args=199" },
    { id: "tc-long-winpath", args: 360, body: 0, note: "实测 args=387（Windows 反斜杠形态）" },
    { id: "tc-long-wrapprobe", args: 260, body: 0, note: "实测 args=277（压力腿正对照，必须单行）" },
];

describe("preview 长串夹具守卫（task-110）", () => {
    it("六张长串卡都在，且 arguments 长度不低于实测下限", () => {
        expect(mockLongToolCalls.map((call) => call.id)).toEqual(MINIMA.map((row) => row.id));
        const short = MINIMA.map((row) => {
            const call = mockLongToolCalls.find((entry) => entry.id === row.id);
            return { id: row.id, len: call ? call.arguments.length : -1, min: row.args, note: row.note };
        }).filter((row) => row.len < row.min);
        expect(short).toEqual([]);
    });

    it("正文（result / error）也没有被清空成占位符", () => {
        const bodies = MINIMA.filter((row) => row.body > 0).map((row) => {
            const call = mockLongToolCalls.find((entry) => entry.id === row.id);
            const body = (call?.result ?? "").length + (call?.error ?? "").length;
            return { id: row.id, body, min: row.body };
        });
        expect(bodies.length).toBe(2);
        expect(bodies.filter((row) => row.body < row.min)).toEqual([]);
    });

    it("Windows 反斜杠形态没有被转义层吃短（≥10 对）", () => {
        const args = mockLongWindowsPathToolCall.arguments;
        expect((args.match(/\\\\/g) ?? []).length).toBeGreaterThanOrEqual(10);
        expect(args).toContain("Users");
    });

    it("压力腿正对照是单行合法 JSON（改成多行 = 换掉实验样本）", () => {
        const args = mockLongWrapProbeToolCall.arguments;
        expect(args.includes("\n")).toBe(false);
        expect(args.includes("\r")).toBe(false);
        expect(() => JSON.parse(args)).not.toThrow();
    });
});
