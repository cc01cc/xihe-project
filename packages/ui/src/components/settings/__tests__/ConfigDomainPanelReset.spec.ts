import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import ConfigDomainPanel, { type DomainField } from "../ConfigDomainPanel.vue";

/**
 * BL-542 / task-145：非实例层的「↺ 重置为默认」被收起。
 *
 * <p>为什么必须是实例层：CP 只有 `DELETE /config/instance/{domain}/{key}`；user/workspace 层的
 * ↺ 走 `PUT {key: ""}`，通用写入路径把空串原样入库（只有 llm-provider/embedding 有空值=删行
 * 特例）⇒ 不回退继承，而是把键钉成空串，还弹「重置成功」。</p>
 *
 * <p>这三条同时是 A/B 判据：把 `canDeleteOverride` 的 `=== "instance"` 改回 `!== "user"`，
 * workspace / user 两条立刻红。</p>
 */

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            settings: {
                resetToDefault: "Reset to default",
                driftedBadge: "Drifted",
                driftedClear: "Clear drifted value",
                driftedHint: "Stored value is not in the current candidates",
                driftedOption: "(no longer available)",
                empty: "(empty)",
                notSet: "(not set)",
            },
            common: { save: "Save" },
        },
    },
});

const schema: DomainField[] = [
    { key: "chunkSize", label: "Chunk size", type: "number" },
    {
        key: "mode",
        label: "Mode",
        type: "select",
        options: [{ label: "Auto", value: "auto" }],
    },
];

function makeRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
}

async function mountForLayer(layer: "instance" | "user") {
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain: "rag",
            title: "RAG",
            // mode 的值 "legacy" 不在候选集里 ⇒ 漂移徽标出现（用来验证「收起按钮但不收起提示」）
            entries: { chunkSize: "1024", mode: "legacy" },
            schema,
            layer,
        },
        global: { plugins: [i18n, makeRouter()] },
    });
    await wrapper.find("button").trigger("click"); // 展开域卡，行才渲染
    return wrapper;
}

function resetButtons(wrapper: Awaited<ReturnType<typeof mountForLayer>>) {
    return wrapper.findAll("button").filter((button) => button.text().includes("↺"));
}

describe("ConfigDomainPanel 重置按钮的层可见性（BL-542）", () => {
    it("TC-R1: 实例层保留逐键 ↺ 与漂移清理（这里才是真删行）", async () => {
        const wrapper = await mountForLayer("instance");
        expect(resetButtons(wrapper).length, "实例层两个可写字段各有一个 ↺").toBe(2);
        expect(
            wrapper.find('[data-testid="config-drift-clear-rag-mode"]').exists(),
            "实例层的漂移清理保留",
        ).toBe(true);
        wrapper.unmount();
    });

    it("TC-R3: 用户层同样没有 ↺ 与漂移清理", async () => {
        const wrapper = await mountForLayer("user");
        expect(resetButtons(wrapper).length).toBe(0);
        expect(wrapper.find('[data-testid="config-drift-clear-rag-mode"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="config-drift-rag-mode"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
