import { describe, expect, it } from "vitest";
import { config, mount } from "@vue/test-utils";
import ConfigSourceSummary from "../ConfigSourceSummary.vue";
import { i18n } from "../../../i18n";
import type { ConfigKeyMeta } from "../../../stores/config";

(config.global.plugins ??= []).push(i18n);

/**
 * task-170 / F-07：生效来源原先默认就把 `embedding.dimensions` 这类 CP 技术标识
 * 铺在正文里。现在默认收起、展开才见明细（审计信息进可折叠的「高级」区），
 * 顶层只留一句人话；source 词本身也 i18n 化（instance ⇒ 实例层）。
 */
function meta(
    rows: Array<Partial<ConfigKeyMeta> & { key: string }>,
): Record<string, ConfigKeyMeta> {
    return Object.fromEntries(
        rows.map((row) => [
            row.key,
            {
                source: "instance",
                locked: false,
                writable: true,
                reason: null,
                instanceEligible: true,
                defaultPresent: true,
                overridable: true,
                ...row,
            } as ConfigKeyMeta,
        ]),
    );
}

function mountSummary() {
    return mount(ConfigSourceSummary, {
        props: {
            domain: "embedding",
            layer: "user" as const,
            meta: meta([
                { key: "dimensions", source: "instance" },
                { key: "profile", source: "instance" },
            ]),
        },
    });
}

describe("ConfigSourceSummary（F-07 审计明细默认收起）", () => {
    it("默认收起：只给一句人话摘要，不显示裸键名", async () => {
        const wrapper = mountSummary();
        const toggle = wrapper.get('[data-testid="config-source-summary-toggle-embedding"]');
        expect(toggle.attributes("aria-expanded")).toBe("false");
        expect(wrapper.text()).toContain("2 项由上层设定");
        expect(wrapper.text()).not.toContain("embedding.dimensions");
        expect(wrapper.find('[data-testid^="config-source-row-"]').exists()).toBe(false);
    });

    it("展开后明细可见：键名 + 人话层名（不是 instance 机器值）", async () => {
        const wrapper = mountSummary();
        await wrapper
            .get('[data-testid="config-source-summary-toggle-embedding"]')
            .trigger("click");

        const row = wrapper.get('[data-testid="config-source-row-embedding-dimensions"]');
        expect(row.text()).toContain("embedding.dimensions");
        expect(row.text()).toContain("实例层");
        expect(row.text()).toContain("继承自 实例层");
    });
});

describe("ConfigSourceSummary（task-386 / D-1232 实例模型凭据归属标注）", () => {
    const NOTE = '[data-testid="config-source-own-credential-llm-provider"]';
    const TOGGLE = '[data-testid="config-source-summary-toggle-llm-provider"]';

    function mountWithNote(ownCredentialNote?: boolean) {
        return mount(ConfigSourceSummary, {
            props: {
                domain: "llm-provider",
                layer: "user" as const,
                meta: meta([{ key: "profile", source: "instance" }]),
                ...(ownCredentialNote === undefined ? {} : { ownCredentialNote }),
            },
        });
    }

    it("判据①：调用方判定成立 ⇒ 标注可见，文案说「凭据」而不是「连接」", () => {
        const note = mountWithNote(true).get(NOTE);
        expect(note.text()).toBe("此模型将使用你自己的凭据");
    });

    it("判据②：判定不成立（false / 不传）⇒ 不渲染标注", () => {
        expect(mountWithNote(false).find(NOTE).exists()).toBe(false);
        expect(mountWithNote().find(NOTE).exists()).toBe(false);
    });

    it("判据③：只展示 —— 不改摘要折叠态、不增减明细行、不新增可操作控件", async () => {
        const withNote = mountWithNote(true);
        const without = mountWithNote(false);
        expect(withNote.get(TOGGLE).attributes("aria-expanded")).toBe("false");
        await withNote.get(TOGGLE).trigger("click");
        await without.get(TOGGLE).trigger("click");
        expect(withNote.findAll('[data-testid^="config-source-row-"]').length).toBe(
            without.findAll('[data-testid^="config-source-row-"]').length,
        );
        expect(withNote.findAll("button").length).toBe(without.findAll("button").length);
    });
});
