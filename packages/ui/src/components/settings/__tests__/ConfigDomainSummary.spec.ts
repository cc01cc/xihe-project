import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ConfigDomainSummary from "../ConfigDomainSummary.vue";
import type { ConfigKeyMeta } from "../../stores/config";

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
        "zh-CN": {
            settings: {
                configSourceUpper: "上层",
                configSourceEnvShort: "环境变量",
                configSummaryInheritedLayer: "{count} 项由{source}设定",
                configSummaryInheritedMany: "{count} 项由上层设定",
                configSummaryShow: "查看",
                configSummaryHide: "收起",
                ia: {
                    layerInstanceShort: "实例层",
                    layerUserShort: "用户层",
                    layerWorkspaceShort: "工作区层",
                },
            },
        },
    },
});

function meta(key: string, over: Partial<ConfigKeyMeta> = {}): ConfigKeyMeta {
    return {
        key,
        source: "instance",
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: true,
        overridable: true,
        adminLocked: false,
        lockReason: null,
        ...over,
    };
}

function mountSummary(props: Record<string, unknown>) {
    return mount(ConfigDomainSummary, {
        props: { domain: "agent-runtime", layer: "user", meta: {}, ...props },
        global: { plugins: [i18n] },
    });
}

describe("ConfigDomainSummary (PLAN-0752 T3.5)", () => {
    it("counts keys an upper layer decides and names that layer", () => {
        const wrapper = mountSummary({
            meta: {
                a: meta("a", { adminLocked: true }),
                b: meta("b", { adminLocked: true }),
                c: meta("c", { adminLocked: true }),
                d: meta("d", { source: "user", writable: true }),
            },
        });
        expect(wrapper.find('[data-testid="config-domain-summary-agent-runtime"]').exists()).toBe(
            true,
        );
        expect(
            wrapper.find('[data-testid="config-domain-summary-text-agent-runtime"]').text(),
        ).toBe("3 项由实例层设定");
    });

    it("lists exactly the counted keys after expanding", async () => {
        const wrapper = mountSummary({
            meta: {
                a: meta("a", { adminLocked: true }),
                b: meta("b", { adminLocked: true }),
                d: meta("d", { source: "user", writable: true }),
            },
        });
        expect(
            wrapper.findAll('[data-testid^="config-domain-summary-row-agent-runtime-"]'),
        ).toHaveLength(0);
        await wrapper
            .find('[data-testid="config-domain-summary-toggle-agent-runtime"]')
            .trigger("click");
        const rows = wrapper.findAll('[data-testid^="config-domain-summary-row-agent-runtime-"]');
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.attributes("data-testid"))).toEqual([
            "config-domain-summary-row-agent-runtime-a",
            "config-domain-summary-row-agent-runtime-b",
        ]);
    });

    it("counts env-locked keys as an upper layer on the instance layer too", () => {
        const wrapper = mountSummary({
            layer: "instance",
            meta: {
                a: meta("a", { locked: true, source: "env", writable: false }),
                b: meta("b", { adminLocked: true }),
            },
        });
        // env 在优先级链最上层 ⇒ 计 1；管理员锁在实例层是「本层」行为 ⇒ 不计
        expect(
            wrapper.find('[data-testid="config-domain-summary-text-agent-runtime"]').text(),
        ).toBe("1 项由环境变量设定");
    });

    it("falls back to the generic wording when several layers feed the domain", () => {
        const wrapper = mountSummary({
            layer: "workspace",
            meta: {
                a: meta("a", { source: "instance", adminLocked: true }),
                b: meta("b", { source: "env", locked: true, writable: false }),
            },
        });
        expect(
            wrapper.find('[data-testid="config-domain-summary-text-agent-runtime"]').text(),
        ).toBe("2 项由上层设定");
    });

    it("renders nothing when no key is decided above the current layer", () => {
        const wrapper = mountSummary({
            meta: { a: meta("a", { source: "user", writable: true }) },
        });
        expect(wrapper.find('[data-testid="config-domain-summary-agent-runtime"]').exists()).toBe(
            false,
        );
    });
});
