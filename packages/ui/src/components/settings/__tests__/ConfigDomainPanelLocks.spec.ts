import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ConfigDomainPanel from "../ConfigDomainPanel.vue";
import type { ConfigKeyMeta } from "../../../stores/config";

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
        "zh-CN": {
            settings: {
                adminLockedBadge: "由管理员锁定",
                adminLockReason: "由管理员锁定：{reason}",
                configSourceInstance: "instance",
                configSourceInstanceOnly: "仅 instance",
                configSourceOverridable: "可被覆盖",
                configSourceReadonly: "只读",
                envLockedHint: "env 覆盖",
                empty: "空",
                notSet: "未设置",
                customOption: "自定义",
                customPlaceholder: "输入",
                driftedBadge: "漂移",
                driftedHint: "漂移",
                driftedClear: "清除",
                driftedOption: "漂移：{value}",
            },
        },
    },
});

function meta(overrides: Partial<ConfigKeyMeta>): ConfigKeyMeta {
    return {
        key: "chunkSize",
        source: "instance",
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: true,
        overridable: true,
        adminLocked: false,
        lockReason: null,
        ...overrides,
    };
}

async function mountPanel(entry: ConfigKeyMeta) {
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain: "rag",
            title: "RAG",
            entries: { chunkSize: "4096" },
            schema: [{ key: "chunkSize", label: "Chunk Size", type: "text" }],
            meta: { chunkSize: entry },
            layer: "instance",
            admin: true,
        },
        global: { plugins: [i18n] },
    });
    await wrapper.find("button").trigger("click");
    return wrapper;
}

describe("ConfigDomainPanel admin lock", () => {
    it("shows the admin lock badge and reason instead of an editable field", async () => {
        const wrapper = await mountPanel(
            meta({
                adminLocked: true,
                writable: false,
                reason: "ADMIN_LOCKED",
                lockReason: "统一分块",
            }),
        );

        expect(wrapper.find('[data-testid="config-admin-lock-rag-chunkSize"]').text()).toContain(
            "由管理员锁定",
        );
        expect(wrapper.text()).toContain("由管理员锁定：统一分块");
        // The pinned instance value is rendered read-only, not as an input.
        expect(wrapper.text()).toContain("4096");
        expect(wrapper.find("input").exists()).toBe(false);
    });

    it("offers no lock toggle on the ordinary config page", async () => {
        const wrapper = await mountPanel(meta({}));

        expect(wrapper.find('[data-testid="config-admin-lock-rag-chunkSize"]').exists()).toBe(
            false,
        );
        expect(wrapper.text()).not.toContain("锁定配置");
        expect(wrapper.find("input").exists()).toBe(true);
    });
});
