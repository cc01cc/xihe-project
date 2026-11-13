import { describe, it, expect, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import ConfigDomainPanel, { type DomainField } from "../ConfigDomainPanel.vue";
import type { ConfigKeyMeta } from "../../../stores/config";

/**
 * task-31（用户复审「我改了用户层配置，实例层看不出被覆盖」）：实例层「被个人层覆盖」徽标。
 *
 * <p>契约（`docs/api/openapi.yaml:3093-3094`）：`ConfigKeyMeta` 没有覆盖人字段，做法是
 * 「用 `layer=user` 检测覆盖」⇒ 徽标只能 UI 侧比对 instance 原始行与 user 原始行派生。
 * 三条断言对应卡面验收三条，且都能被变异打红：
 * ① user 层有该键 ⇒ 徽标出现 + 点它跳到用户层同一条目（`/settings/user/<domain>#<key>`）；
 * ② user 层**没有**该键 ⇒ 不出现（不是恒显示）；
 * ③ user 层**未加载**（`userEntries === undefined`）⇒ 不出现 —— 把"不知道"画成"没有覆盖"
 *    正是本卡要消灭的假阴性；④ 非实例层 / 无用户层路由的实例专属域 ⇒ 不出现。</p>
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
                configSourceUserOverride: "Personal override",
                // task-225（默认展开）暴露的夹具缺口：本行原先被折叠挡住 ⇒ 裸键守卫空过。
                configSourceInheritedAbove: "Inherited from above",
                configSourceInstanceDefault: "Instance default",
                configSourceOverridable: "Overridable below",
                configCardFieldCount: "{count} fields",
                configCardExpandHint: "Expand",
                configSourceInstanceOnly: "Instance only",
            },
            common: { save: "Save" },
        },
    },
});

const schema: DomainField[] = [
    { key: "chunkSize", label: "Chunk size", type: "number" },
    { key: "topK", label: "Top K", type: "number" },
];

function meta(key: string): ConfigKeyMeta {
    return {
        key,
        source: "instance",
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

async function mountPanel(options: {
    layer?: "instance" | "user";
    domain?: string;
    userEntries?: Record<string, string>;
}) {
    const router = makeRouter();
    const domain = options.domain ?? "rag";
    await router.push({ path: `/settings/${options.layer ?? "instance"}/${domain}` });
    await router.isReady();
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain,
            title: "RAG",
            entries: { chunkSize: "800" },
            schema,
            meta: { chunkSize: meta("chunkSize"), topK: meta("topK") },
            layer: options.layer ?? "instance",
            userEntries: options.userEntries,
        },
        global: { plugins: [i18n, router] },
        attachTo: document.body,
    });
    await flushPromises();
    // 字段行只在域卡**展开后**才渲染（v-if）—— 不展开就断言"没有徽标"是假阴性。
    // task-225 起默认展开 ⇒ 只有「字段行还不在 DOM 里」时才点一次（两态都可断言）。
    const toggle = wrapper.find("button");
    if (!wrapper.find('[data-testid^="config-field-"]').exists() && toggle.exists()) {
        await toggle.trigger("click");
        await flushPromises();
    }
    return { wrapper, router };
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("ConfigDomainPanel 实例层·被个人层覆盖（task-31）", () => {
    it("user 层有该键 ⇒ 徽标出现，且点它跳到用户层同一条目", async () => {
        const { wrapper, router } = await mountPanel({ userEntries: { topK: "5" } });
        const badge = wrapper.find(`[data-testid="config-user-override-rag-topK"]`);
        expect(badge.exists()).toBe(true);
        // 只覆盖有 user 行的那个键，别的一律不出现（不是整域一个徽标）。
        expect(wrapper.find(`[data-testid="config-user-override-rag-chunkSize"]`).exists()).toBe(
            false,
        );
        await badge.trigger("click");
        await flushPromises();
        expect(router.currentRoute.value.path).toBe("/settings/user/rag");
        expect(router.currentRoute.value.hash).toBe("#topK");
    });

    it("user 层没有该键 ⇒ 不出现（不得恒显示）", async () => {
        const { wrapper } = await mountPanel({ userEntries: {} });
        expect(wrapper.find(`[data-testid="config-user-override-rag-topK"]`).exists()).toBe(false);
        expect(wrapper.find(`[data-testid="config-user-override-rag-chunkSize"]`).exists()).toBe(
            false,
        );
    });

    it("user 层未加载（undefined）⇒ 不出现：不知道 ≠ 没有覆盖", async () => {
        const { wrapper } = await mountPanel({ userEntries: undefined });
        expect(wrapper.find(`[data-testid="config-user-override-rag-topK"]`).exists()).toBe(false);
    });

    it("非实例层 ⇒ 不出现（徽标只陈述实例默认值被覆盖）", async () => {
        const { wrapper } = await mountPanel({ layer: "user", userEntries: { topK: "5" } });
        expect(wrapper.find(`[data-testid="config-user-override-rag-topK"]`).exists()).toBe(false);
    });

    it("实例专属域（无用户层路由）⇒ 不出现（不制造死链）", async () => {
        const { wrapper } = await mountPanel({ domain: "logging", userEntries: { topK: "5" } });
        expect(wrapper.find(`[data-testid="config-user-override-logging-topK"]`).exists()).toBe(
            false,
        );
    });
});
