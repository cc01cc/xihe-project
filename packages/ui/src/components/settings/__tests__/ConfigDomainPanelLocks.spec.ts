import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import ConfigDomainPanel from "../ConfigDomainPanel.vue";
import type { ConfigKeyMeta } from "../../../stores/config";

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
        "zh-CN": {
            // task-105：面板整树会渲染这些键；缺了它们 `t()` 会原样回显键名（裸键护栏会红）。
            common: {
                save: "保存",
            },
            settings: {
                adminLockedBadge: "由管理员锁定",
                adminLockReason: "由管理员锁定：{reason}",
                configCardExpandHint: "展开查看全部设置",
                configCardFieldCount: "{count} 项",
                configSourceEnv: "环境变量锁定",
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
                resetToDefault: "重置为系统默认",
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
        },
        // V6（af6ee270）给组件加了 route.hash 锚点 watch；这段 spec 当时没跟着装 router，
        // 于是 setup 里 `route.hash` 直接抛错（develop 上就是红的，task-145 顺手补上）。
        global: {
            plugins: [
                i18n,
                createRouter({
                    history: createMemoryHistory(),
                    routes: [
                        { path: "/settings/:layer/:domain", component: { template: "<div />" } },
                    ],
                }),
            ],
        },
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
