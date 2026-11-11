import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import ConfigDomainPanel, { type DomainField } from "../ConfigDomainPanel.vue";
import { i18n } from "../../../i18n";
import type { ConfigKeyMeta } from "../../../stores/config";

/**
 * task-23 / P2-6：JSON 长值在**只读态**不许单行截断。
 *
 * 为什么这条要单独立 spec：可编辑态本来就是 `<textarea rows="3">`（实测 74 px），
 * 缺陷只在 `readonly`（整域只读 / 实例专属键落到下层）时的取值 span —— 而那一路
 * 在 mock 预览里**拍不到**（mock 账号持有 `MANAGE_WORKSPACE_DEFAULT_CONFIG`，页面始终是可编辑态，
 * 见 `evidence/2026-11-11-settings-p2/p02-probe.json`），所以只能靠组件级断言钉住。
 */
const JSON_VALUE =
    '{"fingerprintEnabled":true,"softThresholdPct":70,"hardThresholdPct":85,' +
    '"keepRecentMessages":12,"agentsMdMaxBytes":65536,"envMaxBytes":32768}';

function meta(key: string): ConfigKeyMeta {
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
    };
}

async function mountReadonly(schema: DomainField[], entries: Record<string, string>) {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain: "context-policy",
            title: "上下文策略",
            entries,
            schema,
            meta: Object.fromEntries(schema.map((field) => [field.key, meta(field.key)])),
            layer: "workspace-default",
            readonly: true,
        },
        global: { plugins: [i18n, router] },
    });
    // 域面板默认折叠：先展开，字段行才进 DOM（与 ConfigDomainPanelLocks.spec.ts 同法）。
    await wrapper.find("button").trigger("click");
    return wrapper;
}

describe("ConfigDomainPanel 只读长值（task-23 P2-6）", () => {
    it("JSON 字段的只读取值换行显示，不再 truncate", async () => {
        const wrapper = await mountReadonly(
            [
                { key: "defaults", label: "压缩默认值（JSON）", type: "json" },
                { key: "models", label: "按模型覆盖（JSON）", type: "json" },
            ],
            { defaults: JSON_VALUE, models: "{}" },
        );

        const value = wrapper
            .findAll("span")
            .find((node) => node.text().includes("fingerprintEnabled"));
        expect(value).toBeTruthy();
        const classes = value!.classes();
        // 关键：单行截断类必须不在，多行三个类必须在
        expect(classes).not.toContain("truncate");
        expect(classes).toContain("whitespace-pre-wrap");
        expect(classes).toContain("break-all");
        expect(classes).toContain("overflow-y-auto");
        // 值本身没被改写（不截断内容、不格式化）
        expect(value!.text()).toContain('"keepRecentMessages":12');
        wrapper.unmount();
    });

    it("非多行类型（text）的只读取值仍保持单行 truncate", async () => {
        const wrapper = await mountReadonly(
            [{ key: "summaryProvider", label: "摘要提供方", type: "text" }],
            { summaryProvider: "anthropic" },
        );

        const value = wrapper.findAll("span").find((node) => node.text() === "anthropic");
        expect(value).toBeTruthy();
        expect(value!.classes()).toContain("truncate");
        expect(value!.classes()).not.toContain("whitespace-pre-wrap");
        wrapper.unmount();
    });
});
