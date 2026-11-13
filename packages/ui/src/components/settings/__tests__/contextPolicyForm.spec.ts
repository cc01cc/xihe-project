import { describe, expect, it } from "vitest";
import {
    composeDefaults,
    composeModels,
    decomposeDefaults,
    decomposeModels,
    defaultsLeaves,
    modelOverrideFields,
    unknownKeysOf,
} from "../contextPolicyForm";

/**
 * task-285 判据 ②③④ 的机器形式：往返字节相等 / 按模型改互不影响 / 未登记键不丢。
 * 三条都跑在**纯函数**上 —— 不挂 DOM 也能复算，改了逻辑这里先红。
 */
const DEFAULTS_RAW = JSON.stringify(
    {
        softThresholdPct: 0.6,
        keepRecentMessages: 12,
        summaryProvider: "rule",
        legacyKnob: "keep-me",
    },
    null,
    2,
);
const MODELS_RAW = JSON.stringify(
    {
        "gpt-4o": { summaryTimeoutMs: 20000, summaryModel: "gpt-4o-mini", unknownPerModel: 7 },
        claude: { summaryTimeoutMs: 30000 },
    },
    null,
    2,
);

describe("catalog 是唯一清单（不新造一份）", () => {
    it("defaults 13 个叶子、models 13 个覆盖键，且两侧集合不同", () => {
        const defaults = defaultsLeaves().map((field) => field.key);
        const overrides = modelOverrideFields().map((field) => field.key);
        expect(defaults).toHaveLength(13);
        expect(overrides).toHaveLength(13);
        // 数相等纯属巧合，**集合不同**才是要点：不能拿 defaults 的键去画覆盖表
        // （fingerprintEnabled 不在覆盖表里，写进去会被 CP 的 additionalProperties:false 拒掉）。
        expect(overrides).toContain("tokenizerRef");
        expect(defaults).toContain("fingerprintEnabled");
        expect(overrides).not.toContain("fingerprintEnabled");
        expect(defaults).not.toContain("tokenizerRef");
    });
});

describe("defaults 往返与保留", () => {
    it("原样往返 ⇒ null（不改 = 一个字节都不动）", () => {
        expect(composeDefaults(DEFAULTS_RAW, decomposeDefaults(DEFAULTS_RAW))).toBeNull();
    });

    it("改一个键 ⇒ 其它键（含未登记键）都还在", () => {
        const drafts = decomposeDefaults(DEFAULTS_RAW);
        drafts.summaryProvider = "llm";
        const text = composeDefaults(DEFAULTS_RAW, drafts);
        expect(text).not.toBeNull();
        const next = JSON.parse(text as string) as Record<string, unknown>;
        expect(next.summaryProvider).toBe("llm");
        expect(next.softThresholdPct).toBe(0.6);
        expect(next.keepRecentMessages).toBe(12);
        // 判据 ④：catalog 没登记的键不能因为「不认识」被丢掉。
        expect(next.legacyKnob).toBe("keep-me");
    });

    it("清空一个键 ⇒ 该键消失（不是写空串）", () => {
        const drafts = decomposeDefaults(DEFAULTS_RAW);
        drafts.keepRecentMessages = "";
        const next = JSON.parse(composeDefaults(DEFAULTS_RAW, drafts) as string) as Record<
            string,
            unknown
        >;
        expect("keepRecentMessages" in next).toBe(false);
    });

    it("数字/布尔按类型写回，不是一律写字符串", () => {
        const drafts = decomposeDefaults(undefined);
        drafts.softThresholdPct = "0.75";
        drafts.fingerprintEnabled = "false";
        const next = JSON.parse(composeDefaults(undefined, drafts) as string) as Record<
            string,
            unknown
        >;
        expect(next.softThresholdPct).toBe(0.75);
        expect(next.fingerprintEnabled).toBe(false);
    });
});

describe("models 按模型覆盖", () => {
    it("原样往返 ⇒ null", () => {
        expect(composeModels(MODELS_RAW, decomposeModels(MODELS_RAW))).toBeNull();
    });

    it("判据 ③：改 A 的 summaryTimeoutMs，B 一字不变", () => {
        const rows = decomposeModels(MODELS_RAW);
        const a = rows.find((row) => row.name === "gpt-4o") as { values: Record<string, string> };
        a.values.summaryTimeoutMs = "12345";
        const next = JSON.parse(composeModels(MODELS_RAW, rows) as string) as Record<
            string,
            Record<string, unknown>
        >;
        expect(next["gpt-4o"]?.summaryTimeoutMs).toBe(12345);
        expect(next.claude).toEqual({ summaryTimeoutMs: 30000 });
    });

    it("判据 ④：每行里未登记的键原样保留，且能指出来是哪些", () => {
        const rows = decomposeModels(MODELS_RAW);
        const a = rows.find((row) => row.name === "gpt-4o") as { values: Record<string, string> };
        a.values.summaryModel = "gpt-4o";
        const next = JSON.parse(composeModels(MODELS_RAW, rows) as string) as Record<
            string,
            Record<string, unknown>
        >;
        expect(next["gpt-4o"]?.unknownPerModel).toBe(7);
        expect(unknownKeysOf(MODELS_RAW, "gpt-4o")).toEqual(["unknownPerModel"]);
        expect(unknownKeysOf(MODELS_RAW, "claude")).toEqual([]);
    });

    it("删行 / 加行", () => {
        const rows = decomposeModels(MODELS_RAW);
        rows.splice(
            rows.findIndex((row) => row.name === "claude"),
            1,
        );
        rows.push({ name: "new-model", values: { summaryTimeoutMs: "9000" } });
        const next = JSON.parse(composeModels(MODELS_RAW, rows) as string) as Record<
            string,
            unknown
        >;
        expect(Object.keys(next).sort()).toEqual(["gpt-4o", "new-model"]);
        expect((next["new-model"] as Record<string, unknown>).summaryTimeoutMs).toBe(9000);
    });
});

describe("catalog 缺失时的降级", () => {
    it("空串/非法 JSON 当空对象，不抛", () => {
        expect(composeDefaults("", decomposeDefaults(""))).toBeNull();
        expect(decomposeModels("{not json")).toEqual([]);
    });
});
