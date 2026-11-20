import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import ConfigDomainPanel, { type DomainField } from "../ConfigDomainPanel.vue";
import { i18n } from "../../../i18n";
import type { ConfigKeyMeta } from "../../../stores/config";
import { openSelect, selectItemTextsFor } from "../../../test-utils/select";

/**
 * task-155 / task-139 D1：设置页下拉**不许空白**。
 *
 * <p>层读面（GET /config/{domain}?layer=）只返回显式覆盖行，所以「本层没有这个键」是常态；
 * 旧实现把「继承」和「没值」都渲染成空 SelectValue，实测 19 个下拉 17 个空白，用户看不出
 * 生效值，也看不出到底配没配。本 spec 钉住新语义的三条分支：</p>
 * <ol>
 *   <li>继承态 ⇒ 生效值 + 来源短语（INFO（代码默认））；</li>
 *   <li>覆盖态 ⇒ 本层值，不出现继承标注；</li>
 *   <li>有合并读面但该键无生效值 ⇒「未设置」；调用方**没给**合并读面 ⇒ 维持旧渲染（不编造）。</li>
 * </ol>
 *
 * <p>为什么直接 mount 面板而不是整页：本 spec 判的是「effective prop 有无 / 值是什么」到显示的
 * 映射；合并读面怎么取（ConfigLayerPanels.ensureEffective）是另一层的事，它失败不画、成功写回
 * store 的行为由真栈读数（evidence 档 §真栈）覆盖。</p>
 */

const LEVEL_OPTIONS = [
    { label: "跟踪", value: "TRACE" },
    { label: "调试", value: "DEBUG" },
    { label: "信息", value: "INFO" },
    { label: "警告", value: "WARN" },
    { label: "错误", value: "ERROR" },
];

const levelSchema: DomainField[] = [
    { key: "logLevel", label: "日志级别", type: "select", options: LEVEL_OPTIONS },
];

const customSchema: DomainField[] = [
    {
        key: "logLevel",
        label: "日志级别",
        type: "select",
        options: LEVEL_OPTIONS,
        allowCustom: true,
    },
];

function meta(source: ConfigKeyMeta["source"], extra: Partial<ConfigKeyMeta> = {}): ConfigKeyMeta {
    return {
        key: "logLevel",
        source,
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: true,
        overridable: true,
        adminLocked: false,
        lockReason: null,
        ...extra,
    };
}

const SELECT = '[data-testid="config-select-logging-logLevel"]';

async function mountPanel(props: Record<string, unknown> = {}) {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain: "logging",
            title: "日志",
            entries: {},
            schema: levelSchema,
            meta: { logLevel: meta("code") },
            layer: "instance",
            ...props,
        },
        global: { plugins: [i18n, router] },
    });
    // task-225 起域卡默认展开 ⇒ 字段行挂载即渲染；这里只为旧形态兜底点一次。
    if (!wrapper.find('[data-testid^="config-field-"]').exists()) {
        await wrapper.find("button").trigger("click");
    }
    return wrapper;
}

describe("ConfigDomainPanel · 下拉继承值（task-155）", () => {
    it("TC-E1: 继承态显示生效值 + 来源短语，且走的是 placeholder 通道", async () => {
        const wrapper = await mountPanel({ effective: { logLevel: "INFO" } });
        const trigger = wrapper.get(SELECT);
        expect(trigger.text(), "本层无覆盖时不许空白").toBe("信息（代码默认）");
        // placeholder 通道：值 span 上带 data-placeholder，说明这是「继承来的」而不是选中项。
        expect(trigger.find("[data-placeholder]").exists()).toBe(true);
        wrapper.unmount();
    });

    it("TC-E2: 覆盖态显示本层值，不出现继承标注", async () => {
        const wrapper = await mountPanel({
            entries: { logLevel: "DEBUG" },
            effective: { logLevel: "INFO" },
            meta: { logLevel: meta("instance") },
        });
        const trigger = wrapper.get(SELECT);
        await openSelect(wrapper, SELECT);
        expect(trigger.text()).toBe("调试");
        expect(trigger.text()).not.toContain("继承");
        wrapper.unmount();
    });

    it("TC-E3: 有合并读面但该键无生效值 ⇒「未设置」，不是空白", async () => {
        const wrapper = await mountPanel({ effective: {} });
        expect(wrapper.get(SELECT).text()).toBe("（未设置）");
        wrapper.unmount();
    });

    it("TC-E4: 调用方没给合并读面 ⇒ 维持旧渲染（不编造生效值）", async () => {
        const plain = await mountPanel();
        expect(plain.get(SELECT).text(), "非 allowCustom 旧渲染仍是空").toBe("");
        plain.unmount();

        const custom = await mountPanel({ schema: customSchema });
        expect(custom.get(SELECT).text(), "allowCustom 旧渲染仍是（未设置）").toBe("（未设置）");
        custom.unmount();
    });

    it("TC-E5: 生效值不在候选里（目录漂移 / 非法值）原样显示，绝不留空", async () => {
        const wrapper = await mountPanel({ effective: { logLevel: "MYSTERY" } });
        expect(wrapper.get(SELECT).text()).toBe("MYSTERY（代码默认）");
        wrapper.unmount();
    });

    it("TC-E6: allowCustom 的「未设置」项写明继承了什么", async () => {
        const inherited = await mountPanel({
            schema: customSchema,
            effective: { logLevel: "INFO" },
        });
        await openSelect(inherited, SELECT);
        expect(selectItemTextsFor(inherited, SELECT)).toContain("未设置（继承：信息）");
        inherited.unmount();

        const plain = await mountPanel({ schema: customSchema, effective: {} });
        await openSelect(plain, SELECT);
        expect(selectItemTextsFor(plain, SELECT)).toContain("（未设置）");
        plain.unmount();
    });

    it("TC-E7: 用户层覆盖时显示的是本层值，不是上层的生效值", async () => {
        const wrapper = await mountPanel({
            layer: "user",
            entries: { logLevel: "WARN" },
            effective: { logLevel: "INFO" },
            meta: { logLevel: meta("user") },
        });
        await openSelect(wrapper, SELECT);
        expect(wrapper.get(SELECT).text()).toBe("警告");
        wrapper.unmount();
    });

    it("TC-E8: 来源是 none 时不硬贴来源短语", async () => {
        const wrapper = await mountPanel({
            effective: { logLevel: "INFO" },
            meta: { logLevel: meta("none") },
        });
        expect(wrapper.get(SELECT).text()).toBe("信息");
        wrapper.unmount();
    });
});
