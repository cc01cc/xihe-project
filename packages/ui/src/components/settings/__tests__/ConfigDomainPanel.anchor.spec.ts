import { describe, it, expect, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import ConfigDomainPanel, { type DomainField } from "../ConfigDomainPanel.vue";
import type { ConfigKeyMeta } from "../../../stores/config";

/**
 * PLAN-0752 T2.4 / T2.5（task-133）：继承层徽标可点 + 锚点落地。
 *
 * <p>design.md:24 —— 被覆盖的继承层以浅色**可点**文字展示，点击跳到对应层同一条目并**短暂高亮**
 * （锚点 `#<setting-key>`）。三条断言各自针对一件事，且都能被变异打红（见任务卡 A/B 表）：
 * ①点击 ⇒ 目标层路径 + hash；②hash 变化 ⇒ 目标行获得焦点 + 高亮（1.6 s 后撤）；
 * ③生效层徽标**不可点**（区分「生效」与「继承」两类）。</p>
 */

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            settings: {
                notSet: "(not set)",
                empty: "(empty)",
                resetToDefault: "Reset",
                configKeyInstanceOnlyBadge: "Instance only",
                configKeyInstanceOnlyHint: "Instance-only key",
                configSourceInstance: "instance",
                configSourceUser: "user",
                configSourceInherited: "Inherited from {source}",
                configSourceInstanceDefault: "Instance default",
                configSourceInheritedAbove: "Inherited from the layer above",
                configSourceOverridable: "Overridable below",
            },
            common: { save: "Save" },
        },
    },
});

const schema: DomainField[] = [
    { key: "chunkSize", label: "Chunk size", type: "number" },
    { key: "topK", label: "Top K", type: "number" },
];

function meta(key: string, source: ConfigKeyMeta["source"]): ConfigKeyMeta {
    return {
        key,
        source,
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: false,
        overridable: true,
    };
}

function makeRouter(): Router {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: "/settings/instance/:domain", component: { template: "<div />" } },
            { path: "/settings/user/:domain", component: { template: "<div />" } },
        ],
    });
}

async function mountAtUserRag(options: { hash?: string } = {}) {
    const router = makeRouter();
    await router.push({ path: "/settings/user/rag", hash: options.hash ?? "" });
    await router.isReady();
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain: "rag",
            title: "RAG",
            entries: { chunkSize: "1000", topK: "5" },
            schema,
            layer: "user",
            // chunkSize 由实例层生效（⇒ 继承层，可点）；topK 在本层生效（⇒ 生效层，不可点）
            meta: { chunkSize: meta("chunkSize", "instance"), topK: meta("topK", "user") },
        },
        global: { plugins: [i18n, router] },
        attachTo: document.body,
    });
    await flushPromises();
    return { wrapper, router };
}

async function expand(wrapper: Awaited<ReturnType<typeof mountAtUserRag>>["wrapper"]) {
    // task-225 起域卡默认展开 ⇒ 只在字段行缺失时点一次（两态都成立）。
    if (!wrapper.find('[data-testid^="config-field-"]').exists()) {
        await wrapper.find("button").trigger("click");
        await flushPromises();
    }
}

afterEach(() => {
    vi.useRealTimers();
});

describe("ConfigDomainPanel anchor jump (T2.4 / T2.5)", () => {
    it("TC-A1: 点击继承层徽标 ⇒ 目标层域页 + #<setting-key>", async () => {
        const { wrapper, router } = await mountAtUserRag();
        await expand(wrapper);

        const jump = wrapper.find('[data-testid="config-source-jump-rag-chunkSize"]');
        expect(jump.exists(), "继承层徽标必须可点").toBe(true);
        await jump.trigger("click");
        await flushPromises();

        expect(router.currentRoute.value.path).toBe("/settings/instance/rag");
        expect(router.currentRoute.value.hash).toBe("#chunkSize");
        wrapper.unmount();
    });

    it("TC-A2: 同页 hash 变化 ⇒ 目标行获得焦点与高亮 class（1.6 s 后撤销）", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { wrapper, router } = await mountAtUserRag();
        // task-225 起默认展开 ⇒ 先由用户收起，再验证「带 hash 会把它自动展开」（这条断言因此更强：
        // 不是「默认就没渲染」，而是「收起来之后还能被锚点重新打开」）。
        await wrapper.get("button").trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="config-field-rag-topK"]').exists()).toBe(false);

        await router.push({ path: "/settings/user/rag", hash: "#topK" });
        await flushPromises();
        await flushPromises();

        const row = wrapper.find('[data-testid="config-field-rag-topK"]');
        expect(row.exists(), "锚点目标行必须被自动展开渲染出来").toBe(true);
        expect(row.attributes("tabindex")).toBe("-1");
        expect(document.activeElement, "焦点必须落到目标行").toBe(row.element);
        expect(row.classes().join(" "), "目标行要短暂高亮").toContain("ring-2");

        vi.advanceTimersByTime(1700);
        await flushPromises();
        expect(
            wrapper.find('[data-testid="config-field-rag-topK"]').classes().join(" "),
        ).not.toContain("ring-2");
        wrapper.unmount();
    });

    it("TC-A3: 生效层徽标不可点（只有继承层才有跳转按钮）", async () => {
        const { wrapper } = await mountAtUserRag();
        await expand(wrapper);

        expect(
            wrapper.find('[data-testid="config-source-jump-rag-topK"]').exists(),
            "生效层不得有跳转按钮",
        ).toBe(false);
        // 来源文字仍在（纯文本徽标），既有断言不受影响
        expect(wrapper.find('[data-testid="config-source-rag-topK"]').text()).toContain("user");
        // 继承行文案已按 design.md:105 收窄（badge = 来源类型短语）——这里只验「来源文字仍在」
        expect(wrapper.find('[data-testid="config-source-rag-chunkSize"]').text()).toContain(
            "Instance default",
        );
        wrapper.unmount();
    });

    // task-251 / D-1043 B（verify 实读 design.md:105 后裁定 ⓐ）：
    // badge 与继承说明**必须并存**（design 原意），缺陷对象只是「两半说同一个层名」。
    // 现在：badge = 来源类型短语（实例默认），hint = 「继承自上层」（不复述源名）。
    it("TC-A4: 继承行 badge + 继承说明并存，且不重复层名", async () => {
        const { wrapper } = await mountAtUserRag();
        await expand(wrapper);

        const inherited = wrapper.find('[data-testid="config-source-rag-chunkSize"]');
        const badge = wrapper.find('[data-testid="config-source-jump-rag-chunkSize"]');
        expect(badge.exists(), "design.md:105：继承行仍要有来源 badge").toBe(true);
        expect(badge.text(), "badge = 来源类型短语，不是纯层名").toBe("Instance default");
        expect(inherited.text(), "badge + hint 两句并存、层名不重复").toBe(
            "Instance defaultInherited from the layer above",
        );
        expect(inherited.text(), "不再出现「instanceInherited」式拼接").not.toContain(
            "instanceInherited",
        );
        wrapper.unmount();
    });
});
