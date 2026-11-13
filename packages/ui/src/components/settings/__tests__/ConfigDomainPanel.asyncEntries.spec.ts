import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import ConfigDomainPanel, { type DomainField } from "../ConfigDomainPanel.vue";

/**
 * task-464（D-1317，cp-2 task-462 诊断 85d3ec4d3）：**草稿必须跟着异步到达的 entries 走**。
 *
 * <p>缺陷机制（五环，逐环可核）：① 域卡容器是 `v-show`（`SettingsDomainView:373`）⇒ 面板**立即挂载**，
 * 早于 `loadLayerDomains` 的异步取数；② 草稿 `editing` 只由 `watch(expanded, {immediate:true})` 初始化一次
 * （`ConfigDomainPanel:101-107`），挂载那刻 `props.entries` 还是空 ⇒ 草稿全空串；③ 取数到达后
 * `entries={mode:"manual"}`（`stores/config.ts:375/:384`），但**没有 watch entries** ⇒ 草稿不重算；
 * ④ Select 的 `model-value` 取草稿（`:720-724`）⇒ 空 ⇒ trigger 空串；⑤ e2e `toContainText("手动审批")` 红。
 * CP 与 mock 数据都正确 ⇒ **这是 UI 渲染缺陷，不是数据缺口**。</p>
 *
 * <p>为什么用 save 载荷与 input 值做判据而不是 trigger 文案：reka-ui 的 `SelectValue` 在 jsdom 里
 * 不展开就不渲染选中项文本（内容懒挂载），拿它当判据会得到与产品无关的假红/假绿。
 * **草稿的真出口是 save 载荷**（`handleSave:507-515` 过滤空串），所以「草稿有没有同步」用
 * 「点保存发出去的 body」钉，既确定又是用户真会遇到的后果。</p>
 *
 * <p>同时钉两个**不许被这次修复破坏**的既有语义：① task-74：不覆盖未保存编辑（`handleReset:517-523`
 * 的乐观清空也不许被 entries 到达复活）；② task-121：面板卸载↔取数自持循环 —— 本修复只写本地草稿、
 * 不 emit、不触发取数，且容器仍是 `v-show`（不改回 `v-if`）。</p>
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
                customPlaceholder: "Custom value",
                customOption: "Custom…",
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
        options: [
            { label: "Auto", value: "auto" },
            { label: "Manual approval", value: "manual" },
        ],
    },
    { key: "note", label: "Note", type: "text" },
];

function makeRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
}

function mountPanel(entries: Record<string, string>) {
    return mount(ConfigDomainPanel, {
        props: {
            domain: "approval-policy",
            title: "Approval policy",
            entries,
            schema,
            layer: "instance" as const,
        },
        global: { plugins: [i18n, makeRouter()] },
    });
}

async function saveBody(wrapper: ReturnType<typeof mountPanel>) {
    const button = wrapper.findAll("button").find((b) => b.text().includes("Save"));
    expect(button, "保存按钮必须存在").toBeDefined();
    await button!.trigger("click");
    const emitted = wrapper.emitted("save") as Array<[Record<string, string>]> | undefined;
    expect(emitted, "点保存必须真的 emit save").toBeDefined();
    return emitted![emitted!.length - 1][0];
}

describe("ConfigDomainPanel 草稿跟随异步 entries（task-464 / D-1317）", () => {
    it("挂载时 entries 为空、取数后到达 ⇒ select 草稿同步（save 载荷带上 mode）", async () => {
        const wrapper = mountPanel({});
        expect(await saveBody(wrapper)).toEqual({});
        await wrapper.setProps({ entries: { mode: "manual" } });
        expect(await saveBody(wrapper)).toEqual({ mode: "manual" });
    });

    it("number/text 同形受益：entries 到达后输入框显示新值（不是空串）", async () => {
        const wrapper = mountPanel({});
        await wrapper.setProps({ entries: { chunkSize: "1024", note: "hello" } });
        expect(
            (
                wrapper.find('[data-testid="config-number-approval-policy-chunkSize"]')
                    .element as HTMLInputElement
            ).value,
        ).toBe("1024");
        expect(
            (
                wrapper.find('[data-testid="config-text-approval-policy-note"]')
                    .element as HTMLInputElement
            ).value,
        ).toBe("hello");
    });

    it("不覆盖未保存编辑（task-74）：用户改过的键保留，其它键照常同步", async () => {
        const wrapper = mountPanel({ mode: "auto", note: "server" });
        await wrapper
            .find('[data-testid="config-text-approval-policy-note"]')
            .setValue("user-typed");
        await wrapper.setProps({ entries: { mode: "manual", note: "server-updated" } });
        expect(
            (
                wrapper.find('[data-testid="config-text-approval-policy-note"]')
                    .element as HTMLInputElement
            ).value,
        ).toBe("user-typed");
        expect(await saveBody(wrapper)).toEqual({ mode: "manual", note: "user-typed" });
    });

    it("重置后 entries 到达不复活旧值（task-74 B1 的乐观清空不被推翻）", async () => {
        const wrapper = mountPanel({ chunkSize: "1234" });
        const reset = wrapper.findAll("button").find((b) => b.text().includes("↺"));
        expect(reset, "实例层应有逐键 ↺").toBeDefined();
        await reset!.trigger("click");
        expect(wrapper.emitted("reset")).toBeDefined();
        // 父组件 DELETE 后整层 reload ⇒ 该键从 entries 消失。
        await wrapper.setProps({ entries: {} });
        expect(await saveBody(wrapper)).toEqual({});
    });

    it("折叠态不重算，重新展开时按最新 entries 重取（既有语义不变）", async () => {
        const wrapper = mountPanel({ mode: "auto" });
        await wrapper.find("button").trigger("click"); // 收起（默认展开）
        await wrapper.setProps({ entries: { mode: "manual" } });
        await wrapper.find("button").trigger("click"); // 再展开
        expect(await saveBody(wrapper)).toEqual({ mode: "manual" });
    });
});
