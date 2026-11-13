import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ContextModelOverrides from "../ContextModelOverrides.vue";

/**
 * task-285 判据 ①②③④ 的组件面：每行只暴露该行真实可用的键；未登记键要**看得见**；
 * 不改就不 emit（不产生「看起来保存了」的假动作）。
 */
const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            settings: {
                notSet: "(not set)",
                fieldCompactionModels: "Per-model overrides",
                ctxModelsHint: "hint",
                ctxModelsEmpty: "No per-model overrides yet.",
                ctxModelAdd: "Add model",
                ctxModelRemove: "Remove",
                ctxModelName: "Model",
                ctxModelNamePlaceholder: "e.g. gpt-4o",
                ctxModelsSave: "Save overrides",
                ctxModelsDuplicateName: "dup",
                ctxModelsUnknownKept: "Kept as-is: {keys}",
                ctxSummaryProviderLlm: "LLM",
                ctxSummaryProviderRule: "Rule",
                // 全量 13 个覆盖键：仓库的 test-utils/vueTestUtils.ts 会扫渲染结果里的裸 key，
                // 少给一个就红 —— 这个守卫是对的（少了它，拼错 key 在测试里永远发现不了）。
                ctx: {
                    maxInputTokens: "Max input tokens",
                    tokenizerRef: "Tokenizer ref",
                    softThresholdPct: "Soft threshold",
                    hardThresholdPct: "Hard threshold",
                    keepRecentMessages: "Keep recent messages",
                    agentsMdMaxBytes: "AGENTS.md max bytes",
                    envMaxBytes: "Env max bytes",
                    pruneWindowChars: "Prune window chars",
                    recoveryBand: "Recovery band",
                    maxConsecutiveIneffective: "Max consecutive ineffective",
                    summaryProvider: "Summary provider",
                    summaryModel: "Summary model",
                    summaryTimeoutMs: "Summary timeout",
                },
            },
        },
    },
});

const RAW = JSON.stringify(
    { "gpt-4o": { summaryTimeoutMs: 20000, legacyKnob: "keep-me" } },
    null,
    2,
);

function mountPanel(raw = RAW) {
    return mount(ContextModelOverrides, {
        props: { modelsRaw: raw },
        global: { plugins: [i18n] },
    });
}

describe("ContextModelOverrides（按模型覆盖子表）", () => {
    it("每行按 catalog 的覆盖键渲染，且不再是一个 JSON 文本框", () => {
        const wrapper = mountPanel();
        expect(wrapper.findAll("[data-testid='ctx-model-row']")).toHaveLength(1);
        // 该行真实可用的键（catalog mapValueFields）逐个有控件；defaults 独有的 fingerprintEnabled 不出现。
        expect(wrapper.find("[data-testid='ctx-model-0-summaryTimeoutMs']").exists()).toBe(true);
        expect(wrapper.find("[data-testid='ctx-model-0-tokenizerRef']").exists()).toBe(true);
        expect(wrapper.find("[data-testid='ctx-model-0-fingerprintEnabled']").exists()).toBe(false);
        expect(wrapper.find("textarea").exists()).toBe(false);
    });

    it("未登记键在行内点名（看得见才叫保留）", () => {
        const wrapper = mountPanel();
        const note = wrapper.find("[data-testid='ctx-model-unknown-0']");
        expect(note.exists()).toBe(true);
        expect(note.text()).toContain("legacyKnob");
    });

    it("不改就不 emit；改了才 emit 且保留未登记键", async () => {
        const wrapper = mountPanel();
        await wrapper.find("[data-testid='ctx-models-save']").trigger("click");
        expect(wrapper.emitted("save")).toBeUndefined();

        await wrapper.find("[data-testid='ctx-model-0-summaryTimeoutMs']").setValue("12345");
        await wrapper.find("[data-testid='ctx-models-save']").trigger("click");
        const events = wrapper.emitted("save") as Record<string, string>[][];
        expect(events).toHaveLength(1);
        const payload = JSON.parse(events[0]![0]!.models as string) as Record<
            string,
            Record<string, unknown>
        >;
        expect(payload["gpt-4o"]?.summaryTimeoutMs).toBe(12345);
        expect(payload["gpt-4o"]?.legacyKnob).toBe("keep-me");
    });

    it("空表给出空态文案而不是空白卡", () => {
        const wrapper = mountPanel("{}");
        expect(wrapper.findAll("[data-testid='ctx-model-row']")).toHaveLength(0);
        expect(wrapper.text()).toContain("No per-model overrides yet.");
    });
});
